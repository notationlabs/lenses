import { evaluate } from "./expr.js";
import { isPlainObject } from "./util.js";

/**
 * "Results are lenses too": walk a produced value against its `returns` schema
 * and turn every field declared as a lens reference into a callable ref
 * `{$lens, target}` an agent can feed straight back into `lens_call`.
 * `target` comes from the declared JSONata (against the containing row) when
 * present, else the field's own string value.
 */
export async function materialiseLenses(value: unknown, returns: unknown): Promise<unknown> {
  if (!isPlainObject(returns)) return value;
  return materialiseField(value, returns, {});
}

/** Apply a field map (fieldName -> field schema) to a single object. */
async function applyFieldMap(
  obj: unknown,
  fieldMap: Record<string, unknown>
): Promise<unknown> {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const [field, fieldSchema] of Object.entries(fieldMap)) {
    // Absent field: only worth touching if it's a lens ref whose target is a
    // JSONata expression we can synthesise from the row (else leave it absent).
    if (!(field in out) && !(isLensRefSchema(fieldSchema) && typeof fieldSchema.target === "string")) {
      continue;
    }
    out[field] = await materialiseField(out[field], fieldSchema, out);
  }
  return out;
}

async function materialiseField(
  value: unknown,
  schema: unknown,
  contextObj: Record<string, unknown>
): Promise<unknown> {
  if (isLensRefSchema(schema)) return materialiseRef(value, schema, contextObj);
  if (isPlainObject(schema)) {
    if (schema.type === "array" && isPlainObject(schema.items)) {
      if (!Array.isArray(value)) return value;
      const out: unknown[] = [];
      for (const row of value) out.push(await applyFieldMap(row, schema.items));
      return out;
    }
    if (schema.type === "object" && isPlainObject(schema.fields)) {
      return applyFieldMap(value, schema.fields);
    }
  }
  return value;
}

/** Bind a lens-reference field into a callable `{$lens, target}` ref. */
async function materialiseRef(
  value: unknown,
  schema: { $lens: string; target?: string },
  contextObj: Record<string, unknown>
): Promise<unknown> {
  // Already a ref (e.g. the resolver emitted one): don't double-wrap.
  if (isPlainObject(value) && typeof value.$lens === "string") return value;

  let target: unknown;
  if (typeof schema.target === "string") {
    target = await evaluate(schema.target, contextObj, {});
  } else if (typeof value === "string") {
    target = value;
  } else {
    // No target JSONata and the field isn't a URL string — nothing to bind.
    return value;
  }
  if (target === undefined || target === null) return value;
  return { $lens: schema.$lens, target };
}

function isLensRefSchema(s: unknown): s is { $lens: string; target?: string } {
  return isPlainObject(s) && typeof s.$lens === "string";
}
