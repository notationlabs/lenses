/**
 * URL patterns with named holes: "https://x.com/{handle}/status/{id}".
 * A hole matches one path/query segment (no `/`, `?`, `#`, `&`).
 * A trailing "*" matches anything.
 */

export interface UrlMatch {
  params: Record<string, string>;
}

const HOLE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function compilePattern(pattern: string): RegExp {
  let out = "";
  let last = 0;
  for (const m of pattern.matchAll(HOLE)) {
    out += escapeRegex(pattern.slice(last, m.index));
    out += `(?<${m[1]}>[^/?#&]+)`;
    last = m.index! + m[0].length;
  }
  out += escapeRegex(pattern.slice(last));
  // allow a trailing * as a wildcard
  out = out.replace(/\\\*/g, ".*");
  return new RegExp(`^${out}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchUrl(patterns: string[], url: string): UrlMatch | null {
  for (const p of patterns) {
    const re = compilePattern(p);
    const m = re.exec(url);
    if (m) return { params: { ...(m.groups ?? {}) } };
  }
  return null;
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
