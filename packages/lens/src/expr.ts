import jsonata from "jsonata";

/**
 * Evaluate sandboxed JSONata with call arguments exposed as `$name` and `$params`.
 */
export async function evaluate(
  expr: string,
  data: unknown,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const compiled = jsonata(expr);
  const bindings: Record<string, unknown> = { params };
  for (const [k, v] of Object.entries(params)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) bindings[k] = v;
  }
  return compiled.evaluate(data, bindings);
}

/** Evaluate detection and let authoring errors propagate. */
export async function evaluateBool(
  expr: string,
  data: unknown,
  params: Record<string, unknown> = {}
): Promise<boolean> {
  return Boolean(await evaluate(expr, data, params));
}
