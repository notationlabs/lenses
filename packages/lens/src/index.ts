export * from "./types.js";
export { executeLens } from "./engine.js";
export { evaluate, evaluateBool } from "./expr.js";
export { materialiseLenses } from "./materialise.js";
export { matchUrl, compilePattern, matchRequestPattern } from "./url-pattern.js";
export { validateSpec } from "./validate.js";

import type { LensSpec } from "./types.js";
import { validateSpec } from "./validate.js";

/** Authoring convenience: validates at definition time. */
export function defineLens(spec: LensSpec): LensSpec {
  return validateSpec(spec);
}
