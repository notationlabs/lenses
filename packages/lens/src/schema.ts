import * as z from "zod/v4";
import { isPlainObject } from "./util.js";
import type { LensSpec, ValidationIssue } from "./types.js";

/** Shape of a materialised `{$lens, params?}` reference, shared by every lens. */
const lensRef = z
  .looseObject({
    $lens: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "lensRef" });

const primitives: Record<string, z.ZodType> = {
  string: z.string(),
  number: z.number(),
  integer: z.int(),
  boolean: z.boolean(),
  null: z.null(),
};

/** Zod schema for a lens's resolved value, built from its `returns` declaration. */
export function returnsSchema(spec: LensSpec): z.ZodType {
  return toZod(spec.returns);
}

function toZod(node: unknown): z.ZodType {
  if (typeof node === "string" && node in primitives) return primitives[node];
  if (!isPlainObject(node)) return z.unknown();
  if (typeof node.$lens === "string") return lensRef.nullable();
  if (node.nullable === true && typeof node.type === "string" && node.type in primitives) {
    return primitives[node.type].nullable();
  }
  if (node.type === "object") {
    return isPlainObject(node.fields) ? fieldMap(node.fields) : z.record(z.string(), z.unknown());
  }
  if (node.type === "array") {
    return isPlainObject(node.items) ? z.array(fieldMap(node.items)) : z.array(z.unknown());
  }
  return z.unknown();
}

/** Declared fields are required; undeclared fields pass through untouched. */
function fieldMap(fields: Record<string, unknown>): z.ZodType {
  return z.looseObject(
    Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, toZod(field)]))
  );
}

/**
 * Standard JSON Schema (draft 2020-12) for a lens's resolved value. `$lens`
 * fields reference the shared `$defs/lensRef` object schema (or null,
 * matching materialisation).
 */
export function deriveJsonSchema(spec: LensSpec): Record<string, unknown> {
  const { $schema, ...body } = z.toJSONSchema(returnsSchema(spec), { target: "draft-2020-12" });
  return {
    $schema,
    $id: `lens:${spec.name}`,
    title: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    ...body,
  };
}

/** Validate a resolved value against a lens's `returns` declaration. */
export function validateResult(spec: LensSpec, value: unknown): ValidationIssue[] {
  if (spec.returns === undefined) return [];
  const result = returnsSchema(spec).safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: pointerOf(issue.path),
    message: issue.message,
    // An absent field means a resolver tier underfilled, not a type mismatch.
    ...(valueAt(value, issue.path) === undefined ? { missing: true } : {}),
  }));
}

function valueAt(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function pointerOf(path: PropertyKey[]): string {
  return `/${path
    .map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}
