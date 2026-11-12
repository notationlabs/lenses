/** A TCP port from a flag, an environment variable, or an option; `name` labels the error. */
export function parsePort(value: string | number, name: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}
