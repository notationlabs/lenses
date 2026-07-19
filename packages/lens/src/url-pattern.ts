const HOLE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Expand a lens's canonical URL from its validated parameters. */
export function expandUrl(template: string, params: Record<string, unknown>): string {
  return template.replace(HOLE, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing URL parameter "${name}"`);
    return encodeURIComponent(String(value));
  });
}

/** Match "METHOD urlglob" request patterns against a captured response. */
export function matchRequestPattern(pattern: string, method: string, url: string): boolean {
  const space = pattern.indexOf(" ");
  const pMethod = space === -1 ? "GET" : pattern.slice(0, space).toUpperCase();
  const pUrl = space === -1 ? pattern : pattern.slice(space + 1);
  if (pMethod !== method.toUpperCase()) return false;
  const re = new RegExp(
    "^" + pUrl.split("*").map(escapeRegex).join(".*") + "$"
  );
  return re.test(url);
}
