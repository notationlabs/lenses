import { evaluate } from "./expr.js";
import { isPlainObject } from "./util.js";

/** Materialise declared lens fields as callable `{$lens, target}` references. */
export async function materialiseLenses(value: unknown, returns: unknown): Promise<unknown> {
  if (!isPlainObject(returns)) return value;
  return materialiseField(value, returns, {});
}

/** Apply field schemas to one object. */
async function applyFieldMap(
  obj: unknown,
  fieldMap: Record<string, unknown>
): Promise<unknown> {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const [field, fieldSchema] of Object.entries(fieldMap)) {
    // A target expression can materialise an absent field from its row.
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

/** Bind a lens field to its target. */
async function materialiseRef(
  value: unknown,
  schema: { $lens: string; target?: string },
  contextObj: Record<string, unknown>
): Promise<unknown> {
  // Preserve references emitted by the resolver.
  if (isPlainObject(value) && typeof value.$lens === "string") return value;

  let target: unknown;
  if (typeof schema.target === "string") {
    target = await evaluate(schema.target, contextObj, {});
  } else if (typeof value === "string") {
    target = value;
  } else {
    return value;
  }
  if (target === undefined || target === null) return value;
  return { $lens: schema.$lens, target };
}

function isLensRefSchema(s: unknown): s is { $lens: string; target?: string } {
  return isPlainObject(s) && typeof s.$lens === "string";
}
