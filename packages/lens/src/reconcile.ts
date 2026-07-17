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
  if (typeof schema === "string") return primitiveMatches(value, schema);
  if (!isPlainObject(schema)) return value !== undefined;

  if (typeof schema.$lens === "string") {
    return value === null || typeof value === "string" || isLensRef(value);
  }

  if (schema.type === "object" && isPlainObject(schema.fields)) {
    if (!isPlainObject(value)) return false;
    return Object.entries(schema.fields).every(
      ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema)
    );
  }

  if (schema.type === "object") return isPlainObject(value);

  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    const itemFields = schema.items;
    return !isPlainObject(itemFields) || value.every((item) => satisfiesFieldMap(item, itemFields));
  }

  if (typeof schema.type === "string") return primitiveMatches(value, schema.type);

  return value !== undefined;
}

function satisfiesFieldMap(value: unknown, fields: Record<string, unknown>): boolean {
  if (!isPlainObject(value)) return false;
  return Object.entries(fields).every(
    ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema)
  );
}

function primitiveMatches(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  return typeof value === type;
}

function isLensRef(value: unknown): boolean {
  return isPlainObject(value) && typeof value.$lens === "string" && typeof value.target === "string";
}
