import { evaluate } from "./expr.js";
import { isPlainObject } from "./util.js";

/** Materialise declared lens fields as callable `{$lens, params}` references. */
export async function materialiseLenses(
  value: unknown,
  returns: unknown,
  callParams: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isPlainObject(returns)) return value;
  return materialiseField(value, returns, {}, callParams);
}

/** Apply field schemas to one object. */
async function applyFieldMap(
  obj: unknown,
  fieldMap: Record<string, unknown>,
  callParams: Record<string, unknown>
): Promise<unknown> {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const [field, fieldSchema] of Object.entries(fieldMap)) {
    if (!(field in out)) continue;
    out[field] = await materialiseField(out[field], fieldSchema, out, callParams);
  }
  return out;
}

async function materialiseField(
  value: unknown,
  schema: unknown,
  contextObj: Record<string, unknown>,
  callParams: Record<string, unknown>
): Promise<unknown> {
  if (isLensRefSchema(schema)) return materialiseRef(value, schema, contextObj, callParams);
  if (isPlainObject(schema)) {
    if (schema.type === "array" && isPlainObject(schema.items)) {
      if (!Array.isArray(value)) return value;
      const out: unknown[] = [];
      for (const row of value) out.push(await applyFieldMap(row, schema.items, callParams));
      return out;
    }
    if (schema.type === "object" && isPlainObject(schema.fields)) {
      return applyFieldMap(value, schema.fields, callParams);
    }
  }
  return value;
}

/** Bind a lens field to its declared parameter expressions. */
async function materialiseRef(
  value: unknown,
  schema: { $lens: string; params?: Record<string, string> },
  contextObj: Record<string, unknown>,
  callParams: Record<string, unknown>
): Promise<unknown> {
  if (value === null) return null;
  // Preserve references emitted by the resolver.
  if (isCallableRef(value)) return value;

  const params: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(schema.params ?? {})) {
    params[key] = await evaluate(expression, contextObj, callParams);
  }
  if (Object.values(params).some((param) => param === undefined || param === null)) return value;
  return Object.keys(params).length > 0
    ? { $lens: schema.$lens, params }
    : { $lens: schema.$lens };
}

function isLensRefSchema(s: unknown): s is { $lens: string; params?: Record<string, string> } {
  return isPlainObject(s) && typeof s.$lens === "string";
}

function isCallableRef(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.$lens === "string" &&
    !("target" in value) &&
    (value.params === undefined || isPlainObject(value.params))
  );
}
