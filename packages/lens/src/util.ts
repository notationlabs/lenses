export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a thrown value's message structurally rather than via `instanceof Error`.
 * JSONata throws plain objects — `{code, position, token, message}` — so an
 * `instanceof` guard falls through to `String(error)` and prints "[object
 * Object]", discarding a diagnosis that already names the failing function and
 * its argument position.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isPlainObject(error)) return String(error);

  // Without a message there is nothing for a code and position to locate.
  if (typeof error.message !== "string") return String(error);
  const message = error.message;
  if (typeof error.code !== "string") return message;

  const at = typeof error.position === "number" ? ` at position ${error.position}` : "";
  const near = typeof error.token === "string" ? `, near "${error.token}"` : "";
  return `${message} [${error.code}${at}${near}]`;
}
