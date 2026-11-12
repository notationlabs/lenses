import { evaluate } from "./expr.js";
import { arrayItems, isDefRefNode, isLensRefNode, isLensRefValue, type LensRefNode } from "./returns.js";
import { isPlainObject } from "./util.js";

/**
 * Marks a ref the resolver never emitted. Distinguishing it from an emitted
 * value decides what an unbindable ref becomes: a field that was present drops
 * to null, while one that was never there is held back until the last pass,
 * which is what tells the engine a later tier still has work to do.
 */
const ABSENT = Symbol("absent");

interface Ctx {
  callParams: Record<string, unknown>;
  helpers?: Record<string, string>;
  /** the spec's `$defs`, so a `$ref` field schema can be followed */
  defs: Record<string, unknown>;
  /**
   * True on the pass whose result is returned. Until then an unbindable ref
   * that no resolver emitted stays absent, so the return contract reads as
   * unsatisfied and the next tier runs — hn/top's `next_page` binds from a URL
   * only its second tier extracts. On the last pass there is no next tier, so
   * the same ref settles to null rather than leaving a hole in the result.
   */
  final: boolean;
}

/** Materialise declared lens fields as callable `{$lens, params}` references. */
export async function materialiseLenses(
  value: unknown,
  returns: unknown,
  callParams: Record<string, unknown> = {},
  final = true,
  helpers?: Record<string, string>,
  defs?: Record<string, unknown>
): Promise<unknown> {
  if (!isPlainObject(returns)) return value;
  return materialiseField(value, returns, {}, { callParams, final, helpers, defs: defs ?? {} });
}

/** Apply field schemas to one object. */
async function applyFieldMap(
  obj: unknown,
  fieldMap: Record<string, unknown>,
  ctx: Ctx
): Promise<unknown> {
  if (!isPlainObject(obj)) return obj;
  const out: Record<string, unknown> = { ...obj };
  for (const [field, fieldSchema] of Object.entries(fieldMap)) {
    if (!(field in out)) {
      // A declared $lens ref needs nothing from the page: its params are
      // expressions over the sibling fields ($item), so the row alone can build it.
      // Skipping it made a purely declarative ref silently never materialise,
      // surfacing as "no resolver produced field /0/detail" — which reads as a
      // broken selector for a field no selector was ever meant to fill.
      if (!isLensRefNode(fieldSchema)) continue;
      const ref = await materialiseRef(ABSENT, fieldSchema, out, ctx);
      if (ref !== ABSENT) out[field] = ref;
      continue;
    }
    out[field] = await materialiseField(out[field], fieldSchema, out, ctx);
  }
  return out;
}

async function materialiseField(
  value: unknown,
  schema: unknown,
  contextObj: Record<string, unknown>,
  ctx: Ctx
): Promise<unknown> {
  if (isLensRefNode(schema)) return materialiseRef(value, schema, contextObj, ctx);
  if (isPlainObject(schema)) {
    if (isDefRefNode(schema)) {
      const def = ctx.defs[schema.$ref];
      // deref follows the value, so a self-referencing def bottoms out with it
      return def === undefined ? value : materialiseField(value, def, contextObj, ctx);
    }
    const items = schema.type === "array" ? arrayItems(schema.items) : undefined;
    if (items !== undefined) {
      if (!Array.isArray(value)) return value;
      const out: unknown[] = [];
      for (const row of value) {
        out.push(
          items.kind === "ref"
            ? await materialiseField(row, schema.items, isPlainObject(row) ? row : {}, ctx)
            : await applyFieldMap(row, items.fields, ctx)
        );
      }
      return out;
    }
    if (schema.type === "object" && isPlainObject(schema.fields)) {
      return applyFieldMap(value, schema.fields, ctx);
    }
  }
  return value;
}

/** Bind a lens field to its declared parameter expressions. */
async function materialiseRef(
  value: unknown,
  schema: LensRefNode,
  contextObj: Record<string, unknown>,
  ctx: Ctx
): Promise<unknown> {
  if (value === null) return null;
  // Preserve references emitted by the resolver.
  if (isLensRefValue(value)) return value;

  // A ref whose params read a field a later tier still has to extract will
  // throw or yield nothing here; that is not an error, just "not yet".
  const params: Record<string, unknown> = {};
  let bound = true;
  for (const [key, expression] of Object.entries(schema.params ?? {})) {
    try {
      params[key] = await evaluate(expression, { item: contextObj, params: ctx.callParams }, ctx.helpers);
    } catch {
      bound = false;
      break;
    }
  }
  // A row whose params do not bind has no callable reference. Returning the
  // input left a bare {} placeholder in place, which is neither a ref nor null
  // and fails the field's own schema; null is what that schema endorses.
  if (!bound || Object.values(params).some((param) => param === undefined || param === null)) {
    return value === ABSENT && !ctx.final ? ABSENT : null;
  }
  return Object.keys(params).length > 0
    ? { $lens: schema.$lens, params }
    : { $lens: schema.$lens };
}
