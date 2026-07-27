import type { LensResult, LensSpec, Resolver } from "../types.js";
import { evaluate, evaluateBool } from "../expr.js";
import { isPlainObject } from "../util.js";

/**
 * A tier's detection is its own, then the spec's. Resolver entries come first
 * so the more specific expression wins when both would fire, and a resolver
 * entry of the same name replaces the spec's outright.
 */
export function mergeDetect(
  specDetect: Record<string, string> | undefined,
  resolverDetect: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!specDetect) return resolverDetect;
  if (!resolverDetect) return specDetect;
  return { ...resolverDetect, ...omit(specDetect, Object.keys(resolverDetect)) };
}

function omit(source: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

export async function detectOutcome(
  detect: Record<string, string> | undefined,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"],
  resolver: Resolver["kind"],
  helpers?: Record<string, string>
): Promise<LensResult | null> {
  if (!detect) return null;
  for (const [name, expr] of Object.entries(detect)) {
    if (await evaluateBool(expr, ctx, params, helpers)) {
      const value = await outcomeValue(name, ctx, params, outcomes, helpers);
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
  outcomes: LensSpec["outcomes"],
  helpers?: Record<string, string>
): Promise<unknown> {
  const declared = outcomes?.[name];
  if (isPlainObject(declared) && typeof declared.$lens === "string") {
    const { $lens, params: paramExpressions, ...rest } = declared;
    const bound: Record<string, unknown> = {};
    if (isPlainObject(paramExpressions)) {
      for (const [key, expression] of Object.entries(paramExpressions)) {
        if (typeof expression === "string") bound[key] = await evaluate(expression, ctx, params, helpers);
      }
    }
    return Object.keys(bound).length > 0
      ? { $lens, params: bound, ...rest }
      : { $lens, ...rest };
  }
  return ctx;
}
