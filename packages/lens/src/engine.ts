import type { EngineIO, LensResult, LensSpec, Resolver } from "./types.js";
import { materialiseLenses } from "./materialise.js";
import { matchUrl } from "./url-pattern.js";
import { runIntercept } from "./resolvers/intercept.js";
import { runDom } from "./resolvers/dom.js";
import { runLlm } from "./resolvers/llm.js";
import { isPlainObject } from "./util.js";
import { fillAbsent, satisfiesReturns } from "./reconcile.js";

/**
 * Run resolvers in cost order, filling fields until `returns` is satisfied.
 * Outcomes return immediately; incomplete values become LLM context or partial results.
 */
export async function executeLens(
  spec: LensSpec,
  targetUrl: string,
  args: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult> {
  const match = matchUrl(spec.accepts, targetUrl);
  if (!match) {
    return {
      kind: "error",
      message: `target ${targetUrl} does not match accepts patterns of ${spec.lens}@v${spec.version}`,
    };
  }
  const params = { ...match.params, ...args, target: targetUrl };

  let lastMiss = "no resolvers defined";
  let gathered: unknown;
  const contributors: Resolver["kind"][] = [];
  for (const resolver of spec.resolve) {
    io.log?.(`trying ${resolver.kind} resolver`);
    let result: LensResult | null;
    switch (resolver.kind) {
      case "intercept":
        result = await runIntercept(resolver, params, io, spec.outcomes);
        break;
      case "dom":
        result = await runDom(resolver, params, io, spec.outcomes);
        break;
      case "llm":
        result = await runLlm(resolver, io);
        break;
    }
    if (!result) {
      io.log?.(`${resolver.kind} resolver missed`);
      lastMiss = `${resolver.kind} resolver missed`;
      continue;
    }
    // Outcomes and errors are terminal; agent extraction includes gathered fields.
    if (result.kind !== "value") {
      io.log?.(
        result.kind === "outcome"
          ? `${resolver.kind} resolver returned ${result.name} outcome`
          : `${resolver.kind} resolver returned an error`
      );
      if (result.kind === "outcome" && result.name === "agent_extract" && gathered !== undefined) {
        return {
          ...result,
          value: {
            ...(result.value as Record<string, unknown>),
            gathered: await materialiseLenses(gathered, spec.returns),
          },
        };
      }
      return result;
    }

    gathered =
      isPlainObject(gathered) && isPlainObject(result.value)
        ? fillAbsent(gathered, result.value)
        : result.value;
    contributors.push(resolver.kind);
    io.log?.(`${resolver.kind} resolver contributed a value`);
    if (satisfiesReturns(gathered, spec.returns)) {
      io.log?.("return contract satisfied");
      return {
        kind: "value",
        value: await materialiseLenses(gathered, spec.returns),
        resolver: settledResolver(contributors),
      };
    }
  }
  // Mark incomplete results so the host will not cache them.
  if (gathered !== undefined) {
    io.log?.("resolvers exhausted with a partial value");
    return {
      kind: "value",
      value: await materialiseLenses(gathered, spec.returns),
      resolver: settledResolver(contributors),
      partial: true,
    };
  }
  io.log?.("all resolvers exhausted without a value");
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}
