import { isPlainObject } from "./util.js";

/** Fill fields missing from an earlier resolver without replacing its values. */
export function fillAbsent(current: unknown, incoming: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(incoming)) return current;

  const merged: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(incoming)) {
    if (!(field in merged) || merged[field] === undefined) {
      merged[field] = value;
    } else if (isPlainObject(merged[field]) && isPlainObject(value)) {
      merged[field] = fillAbsent(merged[field], value);
    }
  }
  return merged;
}

/** Whether a value contains every object field declared by a returns schema. */
export function satisfiesReturns(value: unknown, schema: unknown): boolean {
  if (!isPlainObject(schema)) return value !== undefined;

  if (schema.type === "object" && isPlainObject(schema.fields)) {
    if (!isPlainObject(value)) return false;
    return Object.entries(schema.fields).every(
      ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema)
    );
  }

  if (schema.type === "array" && isPlainObject(schema.items)) {
    const itemFields = schema.items;
    return Array.isArray(value) && value.every((item) => satisfiesFieldMap(item, itemFields));
  }

  return value !== undefined;
}

function satisfiesFieldMap(value: unknown, fields: Record<string, unknown>): boolean {
  if (!isPlainObject(value)) return false;
  return Object.entries(fields).every(
    ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema)
  );
}
