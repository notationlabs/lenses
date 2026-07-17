/**
 * Canonical JSON lens spec. Every executable field (`map`, `detect`, `items`,
 * `post`) is a JSONata expression string, never JavaScript — the host can
 * therefore trust the `effects` declaration without parsing per-site code.
 */

export type ExprString = string; // a JSONata expression

export interface LensSpec {
  /** Namespaced name, e.g. "hn/top" */
  lens: string;
  version: number;
  description?: string;
  /** URL patterns with named holes, e.g. "https://x.com/{handle}/status/{id}" */
  accepts: string[];
  /** JSON-schema-ish shape of the return value. Fields whose value is
   *  {"$lens": "<lens-url>", "target": "<jsonata expr>"} are lens references. */
  returns?: unknown;
  /** Named failure modes. Value is either null, a plain schema, or a $lens ref. */
  outcomes?: Record<string, unknown>;
  effects: LensEffects;
  resolve: Resolver[];
}

export interface LensEffects {
  reads: string[];
  writes: string[];
  idempotent?: boolean;
  /** result cache TTL in seconds */
  cache?: number;
}

export type Resolver = InterceptResolver | DomResolver | LlmResolver;

/** One named network response to capture within an intercept tier. */
export interface InterceptSource {
  /** "METHOD urlglob", e.g. "GET https://api.github.com/repos/*\/releases/latest" */
  request: string;
  /** JSONata over the parsed response body producing this source's bound value */
  items?: ExprString;
}

/**
 * A map projection: either a single JSONata expression producing the whole
 * result, or an object whose values are per-field JSONata expressions. The
 * object form lets each field draw from a different source binding.
 */
export type MapSpec = ExprString | Record<string, ExprString>;

export interface InterceptResolver {
  kind: "intercept";
  /** Single-source shorthand: "METHOD urlglob". Omit when using `sources`. */
  request?: string;
  /**
   * Compose several captured responses. Each key binds that source's body as a
   * JSONata variable ($name), so `map` can join across responses:
   * `"stars_per_day": "$repo.stars / $release.age_days"`. All sources must be
   * captured, or the tier misses as a whole.
   */
  sources?: Record<string, InterceptSource>;
  /** JSONata over the parsed response body producing the working value (single-source) */
  items?: ExprString;
  /** JSONata (or per-field object) over the working value / source bindings */
  map?: MapSpec;
  /** outcome name -> JSONata over {status, url, body}; truthy triggers the outcome */
  detect?: Record<string, ExprString>;
  /** if no captured response matches, reload the tab and wait for one */
  reloadOnMiss?: boolean;
  /** how long to wait for a matching response after (re)load, ms */
  waitMs?: number;
}

export interface DomFieldSpec {
  selector: string;
  /** read this attribute instead of textContent */
  attr?: string;
  /** search in item.nextElementSibling instead of the item (e.g. HN's two-row layout) */
  sibling?: boolean;
}

export interface DomResolver {
  kind: "dom";
  /** outcome name -> JSONata over {url, title}; truthy triggers the outcome */
  detect?: Record<string, ExprString>;
  /** if set, extract one object per matching element */
  item?: string;
  fields?: Record<string, DomFieldSpec>;
  /** JSONata applied to the extracted value */
  post?: ExprString;
}

export interface LlmResolver {
  kind: "llm";
  /** extraction instruction, returned to the calling agent alongside the page snapshot */
  prompt: string;
  /** max characters of page snapshot to send */
  maxSnapshotChars?: number;
}

/** A response captured by the main-world fetch/XHR patch. */
export interface InterceptedResponse {
  url: string;
  method: string;
  status: number;
  /** response body text (may be truncated) */
  body: string;
  timestamp: number;
}

export type LensResult =
  | { kind: "value"; value: unknown; resolver: Resolver["kind"] | "reconciled"; partial?: boolean }
  | { kind: "outcome"; name: string; value: unknown; resolver: Resolver["kind"] }
  | { kind: "error"; message: string };

/** IO the engine needs from its host environment (extension SW, or a test). */
export interface EngineIO {
  /** recently captured responses for the bound tab, newest last */
  getIntercepted(): Promise<InterceptedResponse[]>;
  /** reload the bound tab (used by reloadOnMiss); resolves when load committed */
  reload?(): Promise<void>;
  /** run a DOM extraction spec in the bound tab's content script */
  domExtract(spec: DomResolver): Promise<{ url: string; title: string; value: unknown }>;
  /** plain-text snapshot of the page for the LLM tier */
  snapshot(maxChars: number): Promise<{ url: string; title: string; text: string }>;
  sleep(ms: number): Promise<void>;
}
