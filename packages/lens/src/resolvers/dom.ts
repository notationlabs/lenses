import type { DomResolver, EngineIO, LensResult, LensSpec, ResolverMiss } from "../types.js";
import { evaluate } from "../expr.js";
import { expandTemplate } from "../url-pattern.js";
import { detectOutcome, mergeDetect } from "./outcome.js";

/**
 * Substitute declared params into every selector before the spec crosses into
 * the page. Doing it here keeps the page functions free of params — they see
 * concrete selectors — and covers both browser backends at once.
 */
export function expandSelectors(r: DomResolver, params: Record<string, unknown>): DomResolver {
  const fields = r.fields
    ? Object.fromEntries(
        Object.entries(r.fields).map(([name, f]) => [
          name,
          { ...f, selector: expandTemplate(f.selector, params) },
        ])
      )
    : undefined;
  return {
    ...r,
    ...(r.item ? { item: expandTemplate(r.item, params) } : {}),
    ...(fields ? { fields } : {}),
  };
}

export async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  spec: LensSpec
): Promise<LensResult | ResolverMiss> {
  const extracted = await io.domExtract(expandSelectors(r, params));
  const detect = mergeDetect(spec.detect, r.detect);
  const outcome = await detectOutcome(detect, { url: extracted.url, title: extracted.title }, params, spec.outcomes, "dom");
  if (outcome) return outcome;

  // The landed URL is the one piece of evidence the tier holds; carry it into
  // every miss so the caller can see it was reading the wrong page.
  const miss: ResolverMiss = { kind: "miss", observed: extracted.url };

  let value = extracted.value;
  if (value === undefined || value === null) return miss;
  if (Array.isArray(value) && value.length === 0) return miss;
  if (r.post) value = await evaluate(r.post, value, params);
  if (value === undefined || value === null) return miss;
  return { kind: "value", value, resolver: "dom", observed: extracted.url };
}
