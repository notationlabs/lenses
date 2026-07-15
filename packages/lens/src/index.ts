export * from "./types.js";
export { executeLens } from "./engine.js";
export { evaluate, evaluateBool } from "./expr.js";
export { matchUrl, compilePattern, matchRequestPattern } from "./url-pattern.js";
export { validateSpec } from "./validate.js";
export * from "./author.js";

import type { LensSpec } from "./types.js";
import type { LensInput } from "./author.js";
import { validateSpec } from "./validate.js";

/**
 * Authoring convenience: validates at definition time and returns canonical
 * JSON. Accepts typed builder output (`LensInput`) or a plain JSON `LensSpec`.
 */
export function defineLens(spec: LensInput | LensSpec): LensSpec {
  return validateSpec(spec);
}
