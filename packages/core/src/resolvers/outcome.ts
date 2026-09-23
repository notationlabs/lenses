import type { ExceptionEntry, ExceptionMap, LensResult, LensSpec, Resolver } from "../types.js";
import { evaluate, evaluateBool } from "../expr.js";

/** Evaluate a response/page on its own, independent of the tier's named sources. */
export async function matchPageException(
  spec: LensSpec,
  ctx: unknown,
  params: Record<string, unknown>,
  resolver: Resolver["kind"],
  tier?: ExceptionMap
): Promise<LensResult | null> {
  const entries: ExceptionMap = { ...spec.exceptions };
  for (const [name, entry] of Object.entries(tier ?? {})) {
    if (entry === null) entries[name] = null;
    else if (entries[name]) entries[name] = { ...entries[name], ...entry, matches: entries[name].matches };
  }
  return matchExceptions(entries, ctx, params, resolver, spec.helpers);
}

/** Tier entries run first; inherited entries remain active unless nullified. */
export async function matchTierException(
  spec: LensSpec,
  tier: ExceptionMap | undefined,
  ctx: unknown,
  params: Record<string, unknown>,
  resolver: Resolver["kind"]
): Promise<LensResult | null> {
  const merged: ExceptionMap = { ...spec.exceptions };
  for (const [name, entry] of Object.entries(tier ?? {})) {
    const parent = merged[name];
    merged[name] = entry === null ? null : { ...(parent ?? {}), ...entry };
  }
  // Only tier-local predicates run here. A page predicate must never run against
  // a named-source context (where `url` and `status` do not exist).
  const local: ExceptionMap = {};
  for (const [name, entry] of Object.entries(tier ?? {})) {
    if (entry !== null && typeof entry.matches === "string") local[name] = merged[name];
  }
  return matchExceptions(local, ctx, params, resolver, spec.helpers);
}

async function matchExceptions(
  entries: ExceptionMap | undefined,
  ctx: unknown,
  params: Record<string, unknown>,
  resolver: Resolver["kind"],
  helpers?: Record<string, string>
): Promise<LensResult | null> {
  for (const [name, entry] of Object.entries(entries ?? {})) {
    if (!entry || typeof entry.matches !== "string") continue;
    if (!(await evaluateBool(entry.matches, ctx, params, helpers))) continue;
    let value: unknown = ctx;
    if (entry.$lens) {
      const bound: Record<string, unknown> = {};
      for (const [key, expression] of Object.entries(entry.params ?? {})) {
        bound[key] = await evaluate(expression, ctx, params, helpers);
      }
      value = Object.keys(bound).length ? { $lens: entry.$lens, params: bound, ...(entry.hint ? { hint: entry.hint } : {}) }
        : { $lens: entry.$lens, ...(entry.hint ? { hint: entry.hint } : {}) };
    }
    return { kind: "outcome", name, value, resolver, ...(entry.hint ? { hint: entry.hint } : {}) };
  }
  return null;
}
