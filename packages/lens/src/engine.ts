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
 * Object results *reconcile*: each tier fills only the keys still absent, and
 * the engine stops once every field in `returns` is present. Non-object
 * results (e.g. arrays) don't reconcile: the first one wins. An outcome
 * detected at any tier returns early.
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
  let acc: Record<string, unknown> | undefined;
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
      if (result.kind === "outcome" && result.name === "agent_extract" && acc && Object.keys(acc).length) {
        return {
          ...result,
          value: {
            ...(result.value as Record<string, unknown>),
            gathered: await materialiseLenses(acc, spec.returns),
          },
        };
      }
      return result;
    }
    if (!isPlainObject(result.value)) {
      if (acc === undefined) {
        return { ...result, value: await materialiseLenses(result.value, spec.returns) };
      }
      continue;
    }
    acc = fillAbsent(acc ?? {}, result.value) as Record<string, unknown>;
    contributors.push(resolver.kind);
    if (satisfiesReturns(acc, spec.returns)) {
      return {
        kind: "value",
        value: await materialiseLenses(acc, spec.returns),
        resolver: settledResolver(contributors),
      };
    }
  }
  // Out of tiers without completing `returns`: return what we gathered, but
  // flag it partial so the host won't cache a degraded result.
  if (acc && Object.keys(acc).length) {
    return {
      kind: "value",
      value: await materialiseLenses(acc, spec.returns),
      resolver: settledResolver(contributors),
      partial: true,
    };
  }
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}
