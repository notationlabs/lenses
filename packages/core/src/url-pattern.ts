/** A template hole: `{params.id}`, `{sources.orgs.0.uuid}`. */
export const HOLE = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\}/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What a template hole may read: `{params.name}` from the call parameters and,
 * in a chained http source, `{sources.name.path}` from an earlier source.
 */
export interface HoleScope {
  params: Record<string, unknown>;
  sources?: Record<string, unknown>;
}

/** Resolve one hole's path to a scalar, or throw naming the hole. */
function holeValue(path: string, scope: HoleScope, missing: string): string {
  const [root, ...rest] = path.split(".");
  if (rest.length === 0 || (root !== "params" && root !== "sources")) {
    throw new Error(`template hole "{${path}}" must start with "params." or "sources."`);
  }
  if (root === "params" && !Object.hasOwn(scope.params, rest[0])) {
    throw new Error(`${missing} "${rest[0]}"`);
  }
  let value: unknown = root === "params" ? scope.params : scope.sources;
  for (const segment of rest) {
    if (value === null || typeof value !== "object") value = undefined;
    else value = (value as Record<string, unknown>)[segment];
  }
  if (value === undefined || value === null || typeof value === "object") {
    throw new Error(`hole "{${path}}" did not resolve to a scalar`);
  }
  return String(value);
}

function fill(
  template: string,
  scope: HoleScope,
  encode: (value: string) => string,
  missing = "missing parameter"
): string {
  return template.replace(HOLE, (_, path: string) => encode(holeValue(path, scope, missing)));
}

/** Expand a URL template's `{params.name}` (and `{sources.…}`) holes, percent-encoded. */
export function expandUrl(
  template: string,
  params: Record<string, unknown>,
  sources?: Record<string, unknown>
): string {
  return fill(template, { params, sources }, encodeURIComponent, "missing URL parameter");
}

/**
 * Expand a request pattern's holes as in a URL, with `*` also encoded: the
 * glob has no escape, and a value must never widen the pattern to match
 * another account's (or item's) requests.
 */
export function expandRequestPattern(template: string, params: Record<string, unknown>): string {
  return fill(template, { params }, (value) => encodeURIComponent(value).replace(/\*/g, "%2A"));
}

/**
 * Expand the same holes outside a URL, substituting the value verbatim.
 * Percent-encoding is a URL's escape and means nothing to a CSS selector:
 * `#row-{params.year}` wants `#row-2024`, not encodeURIComponent's rules for a
 * different grammar. There is no one correct escape for a selector either —
 * an identifier position and a quoted attribute position want different
 * things — so the value goes in as written, and a lens that interpolates a
 * caller-supplied string should declare it as an integer where it can.
 */
export function expandTemplate(
  template: string,
  params: Record<string, unknown>,
  sources?: Record<string, unknown>
): string {
  return fill(template, { params, sources }, (value) => value);
}

/**
 * A drop's `file` names the call parameter holding the path, written
 * `$params.name`; undefined when it is not exactly that form.
 */
export function dropFileParam(file: string): string | undefined {
  return /^\$params\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(file)?.[1];
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

/**
 * A sign-in gate: a tab an earlier needs_* outcome kept open, still sitting
 * where it was kept. `url` is the tab's current URL; `target` is the page the
 * gated call originally asked for.
 */
export interface AuthGate {
  url: string;
  target: string;
}

/**
 * Query and hash are ignored because sign-in pages rewrite them (state nonces,
 * hash routing) without leaving the sign-in flow; a change of path or origin
 * means the flow moved on and the gate must dissolve.
 */
export function sameGatePlace(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

/** Match a *-only URL glob against a URL or an unexpanded URL template. */
export function matchUrlGlob(glob: string, url: string): boolean {
  return new RegExp("^" + glob.split("*").map(escapeRegex).join(".*") + "$").test(url);
}

/** Match a {method, url-glob} request pattern against a captured response. */
export function matchRequestPattern(
  pattern: { method: string; url: string },
  method: string,
  url: string
): boolean {
  if (pattern.method.toUpperCase() !== method.toUpperCase()) return false;
  return matchUrlGlob(pattern.url, url);
}
