import type { LensResult, LensSpec, Resolver } from "../types.js";
import { evaluate, evaluateBool } from "../expr.js";
import { isPlainObject } from "../util.js";

export async function detectOutcome(
  detect: Record<string, string> | undefined,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"],
  resolver: Resolver["kind"]
): Promise<LensResult | null> {
  if (!detect) return null;
  for (const [name, expr] of Object.entries(detect)) {
    if (await evaluateBool(expr, ctx, params)) {
      const value = await outcomeValue(name, ctx, params, outcomes);
      return { kind: "outcome", name, value, resolver };
    }
  }
  return null;
}

// An outcome declared as a `$lens` ref becomes a callable ref with `target`
// bound (declared JSONata against the detect ctx, else the original target).
// Otherwise the raw detect ctx is returned.
async function outcomeValue(
  name: string,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"]
): Promise<unknown> {
  const declared = outcomes?.[name];
  if (isPlainObject(declared) && typeof declared.$lens === "string") {
    const { $lens, target: targetExpr, ...rest } = declared;
    const target =
      typeof targetExpr === "string" ? await evaluate(targetExpr, ctx, params) : params.target;
    return { $lens, target, ...rest };
  }
  return ctx;
}
