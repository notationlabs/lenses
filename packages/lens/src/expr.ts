import jsonata from "jsonata";

/**
 * Evaluate a JSONata expression against data. JSONata is the whole
 * "scripting" surface a lens gets — no host access, pure data-to-data —
 * which is what makes third-party lens documents safe to execute.
 *
 * `params` (URL hole bindings and call args) are exposed as JSONata
 * variables, e.g. `$handle`, plus `$params` for the whole bag.
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

export async function evaluateBool(
  expr: string,
  data: unknown,
  params: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    return Boolean(await evaluate(expr, data, params));
  } catch {
    return false;
  }
}
