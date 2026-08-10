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

/**
 * Whether a value contains every object field declared by a returns schema.
 * `defs` resolves `$ref` nodes; recursion terminates because each deref
 * descends into the (finite) value, never the schema alone.
 */
export function satisfiesReturns(
  value: unknown,
  schema: unknown,
  defs?: Record<string, unknown>
): boolean {
  if (typeof schema === "string") return primitiveMatches(value, schema);
  if (!isPlainObject(schema)) return value !== undefined;
  if (value === null && schema.nullable === true) return true;

  if (typeof schema.$lens === "string") {
    return value === null || typeof value === "string" || isLensRef(value);
  }

  if (typeof schema.$ref === "string") {
    const def = defs?.[schema.$ref];
    return def === undefined || satisfiesReturns(value, def, defs);
  }

  if (schema.type === "object" && isPlainObject(schema.fields)) {
    if (!isPlainObject(value)) return false;
    return Object.entries(schema.fields).every(
      ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema, defs)
    );
  }

  if (schema.type === "object") return isPlainObject(value);

  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    const items = schema.items;
    if (!isPlainObject(items)) return true;
    if (typeof items.$ref === "string") {
      return value.every((item) => satisfiesReturns(item, items, defs));
    }
    return value.every((item) => satisfiesFieldMap(item, items, defs));
  }

  if (typeof schema.type === "string") return primitiveMatches(value, schema.type);

  return value !== undefined;
}

/**
 * Satisfaction is tested against the *materialised* value, so a declared $lens
 * field that binds from its siblings is present by then and counts. One that
 * cannot bind — hn/top's next_page, whose params read a URL a later tier still
 * has to extract — is left absent by materialisation and correctly fails here,
 * so the engine goes on to the tier that supplies it.
 */
function satisfiesFieldMap(
  value: unknown,
  fields: Record<string, unknown>,
  defs?: Record<string, unknown>
): boolean {
  if (!isPlainObject(value)) return false;
  return Object.entries(fields).every(
    ([field, fieldSchema]) => field in value && satisfiesReturns(value[field], fieldSchema, defs)
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
  return (
    isPlainObject(value) &&
    typeof value.$lens === "string" &&
    !("target" in value) &&
    (value.params === undefined || isPlainObject(value.params))
  );
}
