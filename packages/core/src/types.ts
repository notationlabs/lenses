/**
 * Canonical JSON lens spec. Every executable field (`map`, `detect`, `items`,
 * `post`) is a JSONata expression string, never JavaScript — the host can
 * therefore trust the `effects` declaration without parsing per-site code.
 */

export type ExprString = string; // a JSONata expression

export interface LensSpec {
  /** Globally scoped name, e.g. "@djgrant/hn/top". */
  name: string;
  description?: string;
  /** Canonical page URL. Named holes are expanded from call parameters. */
  url: string;
  /** Inputs available to URL expansion and every resolver expression. */
  params?: Record<string, LensParam>;
  /** Maximum time to wait for the target page to finish loading, in milliseconds. */
  loadTimeoutMs?: number;
  /** JSON-schema-ish shape of the return value. Fields whose value is
   *  {"$lens": "<lens-name>", "params": {"key": "<jsonata expr>"}} are lens references. */
  returns?: unknown;
  /** Named object schemas that `returns` can reference via {"$ref": <name>};
   *  a def may reference itself, which is how a recursive shape (a comment
   *  tree) is declared without infinite nesting. */
  $defs?: Record<string, unknown>;
  /** Named failure modes. Value is either null, a plain schema, or a $lens ref. */
  outcomes?: Record<string, unknown>;
  /**
   * Detection that applies to every tier, so a lens does not paste the same
   * expired-session check into each one. Each tier evaluates it against its own
   * context — `{url, title}` for dom, `{status, url, body}` for intercept — so
   * write one expression per outcome only if it makes sense in both; otherwise
   * keep the tier-specific form on the resolver, which takes precedence here.
   */
  detect?: Record<string, ExprString>;
  /**
   * Named JSONata lambdas bound as `$name` in every expression this document
   * evaluates — `"norm": "function($s) { ... }"` is called as `$norm(x)`.
   * A catalogue supplies these to all its documents, so a fix to one is a fix
   * everywhere rather than an edit per document; a document's own definition of
   * the same name wins. Declared params shadow a helper of the same name.
   */
  helpers?: Record<string, ExprString>;
  effects: LensEffects;
  /**
   * Write steps run once against the bound page, before the resolve walk.
   * A step failure aborts the call — no tier runs, nothing retries (a second
   * attempt could double-send). A document with `perform` always binds a
   * browser.
   */
  perform?: PerformStep[];
  resolve: Resolver[];
}

/**
 * A perform step's wait condition; exactly one of the three selector keys.
 * `appears` is satisfied by ≥1 match, `gone` by 0 (immediately true when
 * already satisfied), `increases` when the match count exceeds the baseline
 * sampled at step entry — so place it immediately after the step that triggers
 * the change, or it never fires.
 */
export interface PerformWait {
  appears?: string;
  gone?: string;
  increases?: string;
  /** how long to poll before the step fails, ms (default 10000) */
  timeoutMs?: number;
}

export type PerformStep =
  | { fill: string; value: string } // value is a JSONata expression over params
  | { click: string }
  | { press: string } // named key, e.g. "Enter"
  | { wait: PerformWait }
  | { navigate: "fresh" };

/** What a host's `perform` reports back to the engine. */
export interface PerformResult {
  /** 0-based index of the step that failed; absent when every step succeeded */
  failedStep?: number;
  message?: string;
  /** the page's location after the last executed step, used for detect on failure */
  url?: string;
  title?: string;
}

export type LensParamType = "string" | "number" | "integer" | "boolean";

export type LensParam =
  | LensParamType
  | {
      type: LensParamType;
      default?: string | number | boolean | ParamLensDefault;
      /** closed set of accepted values; only valid on string params */
      enum?: string[];
    };

/**
 * A parameter default supplied by another lens: when the caller omits the key,
 * the host calls `$lens` (with literal `params`) and projects `field` — a
 * top-level key of the target's returns — as the value. Only legal under a
 * parameter's `default`; a `returns` reference stays `{$lens, params?}`,
 * because result refs are lazy join tokens while a default must become an
 * eager scalar before URL expansion.
 */
export interface ParamLensDefault {
  $lens: string;
  field: string;
  params?: Record<string, string | number | boolean>;
}

export interface LensEffects {
  reads: string[];
  writes: string[];
  idempotent?: boolean;
  /** result cache TTL in seconds */
  cache?: number;
}

export type Resolver = HttpResolver | InterceptResolver | DomResolver | LlmResolver;

/**
 * A direct HTTP request, made without binding a page. Credential-free requests
 * run in the broker's own process; `credentials: true` asks the host to send
 * the browser's cookies, which needs a browser-backed host (the extension's
 * service worker) — where none is reachable the tier misses and the page tiers
 * take over.
 */
export interface HttpResolver {
  kind: "http";
  /** "METHOD url-template" with named holes, e.g. "GET https://api.example.com/items/{id}".
   *  Omitted (and without `sources`), the resolver GETs the lens's canonical `url`. */
  request?: string;
  /**
   * Chain several requests, fired in declaration order. Each source binds its
   * body (through its `items` expression) as a JSONata variable `$name` for
   * `map` and `detect`; a source whose bound value is a scalar also fills
   * `{name}` holes in the request templates of the sources after it — which is
   * how an id only another response knows (an organisation UUID) reaches a URL.
   */
  sources?: Record<string, InterceptSource>;
  /** extra request headers; values take the same named holes as `request` */
  headers?: Record<string, string>;
  /** send the browser's cookies with the request */
  credentials?: boolean;
  /** JSONata over the parsed response body producing the working value */
  items?: ExprString;
  /** JSONata (or per-field object) over the working value */
  map?: MapSpec;
  /** outcome name -> JSONata over {status, url, body}; truthy triggers the outcome */
  detect?: Record<string, ExprString>;
}

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
  /**
   * Move the root this field's selector runs from. "+" (or "+ sel") crosses to
   * the next element sibling, for two-row layouts; anything else is an ancestor
   * selector resolved with closest(), for context a row cannot see — a year on
   * the tab panel enclosing the table.
   */
  scope?: string;
  /** @deprecated the older spelling of `scope: "+"` */
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

/** A JSON response captured from the bound page's network activity. */
export interface InterceptedResponse {
  url: string;
  method: string;
  status: number;
  /** response body text (may be truncated) */
  body: string;
  timestamp: number;
}

/** One violation of a lens's declared `returns` schema. */
export interface ValidationIssue {
  /** JSON pointer into the resolved value, e.g. "/stories/3/score". */
  path: string;
  message: string;
  /** true when the field is absent entirely, i.e. no resolver produced it */
  missing?: boolean;
}

/**
 * A tier that produced nothing. `observed` names what the tier actually saw, so
 * the exhausted-resolvers error can distinguish a broken selector from a page
 * that was never the page asked for — a signed-out redirect misses every
 * selector, and a bare miss reads identically to a typo.
 */
export interface ResolverMiss {
  kind: "miss";
  observed?: string;
}

export type LensResult =
  | {
      kind: "value";
      value: unknown;
      resolver: Resolver["kind"] | "reconciled";
      partial?: boolean;
      /** where the value was read from — the landed URL, not the requested one */
      observed?: string;
      /** every perform step ran — the write committed; absence means it did not */
      performed?: true;
    }
  | {
      kind: "outcome";
      name: string;
      value: unknown;
      resolver: Resolver["kind"];
      performed?: true;
    }
  | {
      kind: "error";
      message: string;
      /** present when a resolved value failed its declared `returns` schema */
      issues?: ValidationIssue[];
      /** "writes_not_allowed" is the host's consent gate; "perform_failed" is a step failure */
      code?: "writes_not_allowed" | "perform_failed";
      /** 0-based index of the perform step that failed */
      step?: number;
      performed?: true;
    };

/** A concrete request an http tier asks its host to perform. */
export interface HttpFetchRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** true asks for the browser's cookies; hosts without a browser resolve undefined */
  credentials: boolean;
}

/** IO the engine needs from a bound browser session or a test. */
export interface EngineIO {
  /** recently captured responses for the bound tab, newest last */
  getIntercepted(): Promise<InterceptedResponse[]>;
  /**
   * Perform an HTTP request outside the page, following redirects; `url` on the
   * response is the landed URL. Absent when the host cannot make requests at
   * all; resolving undefined means this particular request (a credentialed one)
   * is unsupported. Either way the http tier misses rather than errors.
   */
  httpFetch?(request: HttpFetchRequest): Promise<InterceptedResponse | undefined>;
  /** reload the bound tab (used by reloadOnMiss); resolves when load committed */
  reload?(): Promise<void>;
  /** run a DOM extraction spec in the bound page */
  domExtract(spec: DomResolver): Promise<{ url: string; title: string; value: unknown }>;
  /** execute perform steps against the bound page; absent when the host cannot act */
  perform?(steps: PerformStep[]): Promise<PerformResult>;
  /** plain-text snapshot of the page for the LLM tier */
  snapshot(maxChars: number): Promise<{ url: string; title: string; text: string }>;
  /**
   * Pause resolver polling. Hosts may treat this as a poll-deadline hint
   * rather than a wall-clock delay; resolvers must not rely on it for real waits.
   */
  sleep(ms: number): Promise<void>;
  /** Optional progress diagnostics for interactive hosts. */
  log?(message: string): void;
}

/** Requests a Lens client sends to the local broker. */
export type LensBridgeRequest =
  | {
      type: "call";
      id: string;
      spec: LensSpec;
      params: Record<string, unknown>;
      timeoutMs: number;
      /** consent for a spec with `perform` steps; default false at every layer */
      allowWrites?: boolean;
    }
  | { type: "observe"; id: string; target: string; waitMs: number; html?: boolean }
  /**
   * Broker lease control. "release" drops the CDP connection so other tools can
   * use Chrome's single consented debugging slot; "acquire" reconnects (Chrome
   * shows a fresh Allow dialog); "status" reports the lease without side effects.
   * "shutdown" retires the broker itself: it drains in-flight work, releases the
   * lease and exits, so a client running newer code can respawn it.
   */
  | {
      type: "control";
      id: string;
      action: "release" | "acquire" | "status" | "shutdown";
    };
