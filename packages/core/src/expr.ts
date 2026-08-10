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
 * Evaluate sandboxed JSONata with call arguments exposed as `$name` and
 * `$params`, over any helper lambdas the document carries.
 *
 * Params are bound after helpers, so a declared param shadows a helper of the
 * same name: the document's own declaration is the more local one, and a
 * catalogue must not be able to change what an expression means by adding a
 * helper whose name a document was already using.
 */
export async function evaluate(
  expr: string,
  data: unknown,
  params: Record<string, unknown> = {},
  helpers: Record<string, string> = {}
): Promise<unknown> {
  const compiled = jsonata(expr);
  const bindings: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(helpers)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) bindings[name] = await compileHelper(source);
  }
  bindings.params = params;
  for (const [k, v] of Object.entries(params)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) bindings[k] = v;
  }
  return compiled.evaluate(data, bindings);
}

/** Evaluate detection and let authoring errors propagate. */
export async function evaluateBool(
  expr: string,
  data: unknown,
  params: Record<string, unknown> = {},
  helpers: Record<string, string> = {}
): Promise<boolean> {
  return Boolean(await evaluate(expr, data, params, helpers));
}
