import jsonata from "jsonata";

/**
 * Compiled helper lambdas, keyed by their source. A helper is defined once per
 * catalogue but evaluated on every field of every row, so compiling it per call
 * would be the dominant cost of using one. The key is the expression itself, so
 * two catalogues defining the same lambda share an entry and a redefinition
 * never collides with the old one.
 */
const helperCache = new Map<string, Promise<unknown>>();

function compileHelper(source: string): Promise<unknown> {
  let compiled = helperCache.get(source);
  if (!compiled) {
    // Evaluating a `function(...)` expression yields the lambda itself.
    compiled = jsonata(source).evaluate(undefined);
    helperCache.set(source, compiled);
  }
  return compiled;
}

/**
 * The variables an expression site binds, by name without the `$`:
 * `{ response, params }`, `{ value, params }`, and so on.
 */
export type ExprVars = Record<string, unknown>;

/**
 * Evaluate sandboxed JSONata with NO input context: every expression reads
 * named variables (`$res`, `$item`, `$params`, …), so a bare path such as
 * `title` yields nothing at runtime. Validation rejects bare paths before an
 * expression gets here; see expr-check.ts.
 *
 * Helper lambdas are bound first and the site variables over them, though
 * validation already forbids a helper from taking a reserved variable name.
 */
export async function evaluate(
  expr: string,
  vars: ExprVars = {},
  helpers: Record<string, string> = {}
): Promise<unknown> {
  const compiled = jsonata(expr);
  const bindings: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(helpers)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) bindings[name] = await compileHelper(source);
  }
  for (const [name, value] of Object.entries(vars)) {
    // An absent variable stays unbound, so `$item` outside a row is undefined.
    if (value !== undefined) bindings[name] = value;
  }
  return compiled.evaluate(undefined, bindings);
}

/**
 * Evaluate detection and let authoring errors propagate. The result follows
 * JSONata's `$boolean`, so an empty array, an empty object and a function are
 * false where JavaScript's `Boolean` would call them true.
 */
export async function evaluateBool(
  expr: string,
  vars: ExprVars = {},
  helpers: Record<string, string> = {}
): Promise<boolean> {
  return jsonataBoolean(await evaluate(expr, vars, helpers));
}

function jsonataBoolean(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length === 1) return jsonataBoolean(value[0]);
    return value.some(jsonataBoolean);
  }
  if (typeof value === "function") return false;
  if (typeof value === "object" && value !== null) {
    // JSONata lambdas are plain objects tagged with one of these flags.
    const tagged = value as { _jsonata_lambda?: unknown; _jsonata_function?: unknown };
    if (tagged._jsonata_lambda === true || tagged._jsonata_function === true) return false;
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}
