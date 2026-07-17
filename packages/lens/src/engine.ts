import type { EngineIO, LensResult, LensSpec, Resolver } from "./types.js";
import { materialiseLenses } from "./materialise.js";
import { matchUrl } from "./url-pattern.js";
import { runIntercept } from "./resolvers/intercept.js";
import { runDom } from "./resolvers/dom.js";
import { runLlm } from "./resolvers/llm.js";
import { isPlainObject } from "./util.js";
import { fillAbsent, satisfiesReturns } from "./reconcile.js";

/**
 * Execute a lens against a target URL. Runs the resolver list in order,
 * cheapest first: intercept (free) -> dom (cheap) -> llm (paid).
 *
 * Object results *reconcile*: each tier fills only the keys still absent.
 * Every result shape is checked against `returns`; an incomplete value is
 * passed to the LLM tier as gathered context or returned as explicitly partial.
 * An outcome detected at any tier returns early.
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
      lastMiss = `${resolver.kind} resolver missed`;
      continue;
    }
    // Outcomes / errors are terminal — never reconciled. agent_extract
    // additionally carries whatever fields cheaper tiers already gathered.
    if (result.kind !== "value") {
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
    if (satisfiesReturns(gathered, spec.returns)) {
      return {
        kind: "value",
        value: await materialiseLenses(gathered, spec.returns),
        resolver: settledResolver(contributors),
      };
    }
  }
  // Out of tiers without completing `returns`: return what we gathered, but
  // flag it partial so the host won't cache a degraded result.
  if (gathered !== undefined) {
    return {
      kind: "value",
      value: await materialiseLenses(gathered, spec.returns),
      resolver: settledResolver(contributors),
      partial: true,
    };
  }
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}
