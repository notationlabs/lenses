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

// Bind declared lens outcomes; otherwise return the detection context.
async function outcomeValue(
  name: string,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"]
): Promise<unknown> {
  const declared = outcomes?.[name];
  if (isPlainObject(declared) && typeof declared.$lens === "string") {
    const { $lens, params: paramExpressions, ...rest } = declared;
    const bound: Record<string, unknown> = {};
    if (isPlainObject(paramExpressions)) {
      for (const [key, expression] of Object.entries(paramExpressions)) {
        if (typeof expression === "string") bound[key] = await evaluate(expression, ctx, params);
      }
    }
    return Object.keys(bound).length > 0
      ? { $lens, params: bound, ...rest }
      : { $lens, ...rest };
  }
  return ctx;
}
