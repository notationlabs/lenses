import type { DomResolver, EngineIO, LensResult, LensSpec, ResolverMiss } from "../types.js";
import { evaluate } from "../expr.js";
import { detectOutcome } from "./outcome.js";

export async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  outcomes: LensSpec["outcomes"]
): Promise<LensResult | ResolverMiss> {
  const extracted = await io.domExtract(r);
  const outcome = await detectOutcome(r.detect, { url: extracted.url, title: extracted.title }, params, outcomes, "dom");
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
