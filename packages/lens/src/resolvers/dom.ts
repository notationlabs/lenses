import type { DomResolver, EngineIO, LensResult, LensSpec } from "../types.js";
import { evaluate } from "../expr.js";
import { detectOutcome } from "./outcome.js";

export async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  outcomes: LensSpec["outcomes"]
): Promise<LensResult | null> {
  const extracted = await io.domExtract(r);
  const outcome = await detectOutcome(r.detect, { url: extracted.url, title: extracted.title }, params, outcomes, "dom");
  if (outcome) return outcome;

  let value = extracted.value;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (r.post) value = await evaluate(r.post, value, params);
  return { kind: "value", value, resolver: "dom" };
}
