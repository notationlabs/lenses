import { isPlainObject } from "./util.js";
import type { LensSpec } from "./types.js";

/** A `{"$lens": ..., "params"?: {...}}` node in a returns schema. */
export interface LensRefNode {
  $lens: string;
  params?: Record<string, string>;
  [key: string]: unknown;
}

/** A materialised `{$lens, params?}` reference in a resolved value. */
export interface LensRefValue {
  $lens: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The items of an array node: a `$defs` reference or a bare field map. */
export type ArrayItems =
  | { kind: "ref"; name: string }
  | { kind: "fields"; fields: Record<string, unknown> };

export function isLensRefNode(node: unknown): node is LensRefNode {
  return isPlainObject(node) && typeof node.$lens === "string";
}

export function isDefRefNode(node: unknown): node is { $ref: string; [key: string]: unknown } {
  return isPlainObject(node) && typeof node.$ref === "string";
}

/** Whether a resolved value is a callable lens reference. */
export function isLensRefValue(value: unknown): value is LensRefValue {
  return (
    isPlainObject(value) &&
    typeof value.$lens === "string" &&
    !("target" in value) &&
    (value.params === undefined || isPlainObject(value.params))
  );
}

/**
 * Classify an array node's `items`. Any plain object without a string `$ref`
 * is a field map, so a field map may declare fields named `type` or `$lens`.
 */
export function arrayItems(items: unknown): ArrayItems | undefined {
  if (!isPlainObject(items)) return undefined;
  if (isDefRefNode(items)) return { kind: "ref", name: items.$ref };
  return { kind: "fields", fields: items };
}

/** A spec's `$defs`, or an empty map when it declares none. */
export function defsOf(spec: Pick<LensSpec, "$defs"> | undefined): Record<string, unknown> {
  const defs = spec?.$defs;
  return isPlainObject(defs) ? defs : {};
}
