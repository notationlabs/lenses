import type { DomResolver, EngineIO, LensResult, LensSpec, ResolverMiss } from "../types.js";
import { evaluate } from "../expr.js";
import { detectOutcome, mergeDetect } from "./outcome.js";

export async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  spec: LensSpec
): Promise<LensResult | ResolverMiss> {
  const extracted = await io.domExtract(r);
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
