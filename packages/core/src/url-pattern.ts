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

/**
 * Expand the same named holes outside a URL, substituting the value verbatim.
 * Percent-encoding is a URL's escape and means nothing to a CSS selector:
 * `#row-{year}` wants `#row-2024`, not `#row-2024` via encodeURIComponent's
 * rules for a different grammar. There is no one correct escape for a selector
 * either — an identifier position and a quoted attribute position want
 * different things — so the value goes in as written, and a lens that
 * interpolates a caller-supplied string should declare it as an integer where
 * it can.
 */
export function expandTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(HOLE, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing parameter "${name}"`);
    return String(value);
  });
}

/**
 * Whether a live URL is the lens's bind target, tolerating only the trailing
 * slash browsers add — anything looser would rebind to the wrong page.
 */
export function sameTarget(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

/** The URL's origin, or the string itself when it does not parse as a URL. */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
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
