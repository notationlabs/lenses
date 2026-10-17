/**
 * Canonical JSON lens spec. Every executable field (`map`, `matches`, `items`,
 * `post`) is a JSONata expression string, never JavaScript — the host can
 * therefore trust the `effects` declaration without parsing per-site code.
 *
 * Expressions are evaluated with no input context: every path starts at a
 * named variable (`$res`, `$item`, `$sources`, `$params`, `$value`,
 * `$page`), and which of them a site binds is fixed per site — see
 * `checkExpressionsAndTemplates` in validate.ts and the table in skill/SKILL.md. Templates (`url`, request URLs,
 * selectors) take rooted holes: `{params.id}`, and in chained http sources
 * `{sources.orgs.0.uuid}`.
 */

export type ExprString = string; // a JSONata expression

/** An HTTP request (http tier) or request pattern (intercept tier). */
export interface RequestSpec {
  /** HTTP method, e.g. "GET" or "POST"; matched case-insensitively. */
  method: string;
  /**
   * URL template with `{params.name}` holes (http sources also take
   * `{sources.name.path}`); for intercept, a `*`-only glob.
   */
  url: string;
}

export interface LensSpec {
  /** Globally scoped name, e.g. "@djgrant/hn/top". */
  name: string;
  description?: string;
  /** Canonical page URL. `{params.name}` holes are expanded from call parameters. */
  url: string;
  /** Inputs, read as `{params.name}` in templates and `$params.name` in expressions. */
  params?: Record<string, LensParam>;
  /** Maximum time to wait for the target page to finish loading, in milliseconds. */
  loadTimeoutMs?: number;
  /**
   * `"reuse"`: run in the tab this origin used last (adopting an open tab on
   * the origin when there is none) and never close it. A new tab is opened
   * only when no tab on the origin is open.
   */
  tab?: "reuse";
  /**
   * `"in-page"`: reach the lens URL in an existing tab with history.pushState
   * plus popstate, never by loading or reloading the document.
   */
  navigate?: "in-page";
  /**
   * CSS selector for "this page has rendered": after the call navigates, tiers
   * wait until it matches, or until the page matches a needs_* exception (a
   * sign-in redirect), up to the load timeout. Use for apps that show a
   * transient screen or redirect after `load`. Pick a selector unique to the
   * destination page: an in-page route can still show the previous page's DOM.
   */
  ready?: string;
  /** JSON-schema-ish shape of the return value. Fields whose value is
   *  {"$lens": "<lens-name>", "params": {"key": "<jsonata expr>"}} are lens references;
   *  their param expressions read the containing object as `$item`. */
  returns?: unknown;
  /** Named object schemas that `returns` can reference via {"$ref": <name>};
   *  a def may reference itself, which is how a recursive shape (a comment
   *  tree) is declared without infinite nesting. */
  $defs?: Record<string, unknown>;
  /** Named exceptions, including their matching expression and recovery advice. */
  exceptions?: ExceptionMap;
  /**
   * Named JSONata lambdas bound as `$name` in every expression this document
   * evaluates — `"norm": "function($s) { ... }"` is called as `$norm(x)`.
   * A catalogue supplies these to all its documents, so a fix to one is a fix
   * everywhere rather than an edit per document; a document's own definition of
   * the same name wins. A helper may not take a reserved variable name
   * (response, item, sources, params, value, page).
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

/** A null entry disables an inherited exception. */
export type ExceptionMap = Record<string, ExceptionEntry | null>;
export interface ExceptionEntry {
  /**
   * JSONata predicate over the site's variables: `$page` ({url, title}) for a
   * page, `$res` ({status, url, body}) for a response, plus `$value` in a
   * dom tier's own exceptions and `$sources` in a sources tier's own exceptions.
   */
  matches?: ExprString | null;
  hint?: string;
  $lens?: string;
  params?: Record<string, ExprString>;
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
  /** a template the matched elements' text must contain, as on click */
  text?: string;
  /** how long to poll before the step fails, ms (default 10000) */
  timeoutMs?: number;
}

export type PerformStep =
  | { fill: string; value: string } // value is a JSONata expression over $params
  | { click: string; text?: string } // text: a template the clicked element's text must contain
  | { submit: string; form?: Record<string, ExprString> } // $params expressions, resolved before requestSubmit()
  | { press: string } // named key, e.g. "Enter"
  | { drop: string; file: string } // file names a string param; hosts receive its absolute path
  | { wait: PerformWait }
  | { navigate: "fresh" };

/** What a host's `perform` reports back to the engine. */
export interface PerformResult {
  /** 0-based index of the step that failed; absent when every step succeeded */
  failedStep?: number;
  message?: string;
  /** the page's location after the last executed step, used for exception matching on failure */
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
 * A direct HTTP request. Credential-free requests run in the broker's own
 * process; `credentials: true` asks any browser backend to send cookies, while
 * `credentials: "same-origin-page"` requires execution in a page whose origin
 * matches the request URL.
 */
export interface HttpResolver {
  kind: "http";
  /** e.g. {"method": "GET", "url": "https://api.example.com/items/{params.id}"}.
   *  Omitted (and without `sources`), the resolver GETs the lens's canonical `url`. */
  request?: RequestSpec;
  /** Request body for the single-request form. Each value is JSONata over `$params`. */
  body?: HttpBody;
  /**
   * Chain several requests, fired in declaration order. Each source's body
   * (through its `items` expression) is bound as `$sources.name` for `map`,
   * and for the bodies, headers, `items` and `{sources.name…}` URL holes of
   * the sources after it — which is how an id only another response knows (an
   * organisation UUID) reaches a URL.
   */
  sources?: Record<string, HttpSource>;
  /** extra request headers; values are templates with `{params.name}` holes */
  headers?: Record<string, string>;
  /** Browser credential/context requirement, inherited by chained sources. */
  credentials?: HttpCredentials;
  /** JSONata over `$res` (the parsed body) selecting the rows `map` shapes */
  items?: ExprString;
  /** JSONata (or object of them) over `$item` (with `items`) or `$res` */
  map?: MapSpec;
  /** Tier-specific exceptions, evaluated before document exceptions. */
  exceptions?: ExceptionMap;
}

/** A declarative request body. `form` is multipart FormData; `search` is URL-encoded. */
export type HttpBody =
  | { json: ExprString }
  | { form: Record<string, ExprString> }
  | { search: Record<string, ExprString> }
  | { text: ExprString };

/** One named direct request in an HTTP chain. */
export interface HttpSource {
  request: RequestSpec;
  body?: HttpBody;
  /** Override the resolver's browser credential/context requirement for this request. */
  credentials?: HttpCredentials;
  /** Header values are templates: `{params.name}` and `{sources.name.…}` holes for earlier sources, filled verbatim. */
  headers?: Record<string, string>;
  /** JSONata over `$res` (this source's parsed body) producing its bound value */
  items?: ExprString;
}

export type HttpCredentials = boolean | "same-origin-page";

/** One named network response to capture within an intercept tier. */
export interface InterceptSource {
  /** e.g. {"method": "GET", "url": "https://api.github.com/repos/*\/releases/latest"} */
  request: RequestSpec;
  /** JSONata over `$res` (this source's parsed body) producing its bound value */
  items?: ExprString;
}

/**
 * A map projection: either a single JSONata expression producing the whole
 * result, or an object whose values are per-field JSONata expressions or,
 * recursively, nested objects of them. Constants are JSONata literals
 * (`"'base64'"`, `"true"`).
 */
export type MapSpec = ExprString | MapObject;
export interface MapObject {
  [field: string]: MapSpec;
}

export interface InterceptResolver {
  kind: "intercept";
  /** Single-source form: {"method", "url": urlglob}. Omit when using `sources`. */
  request?: RequestSpec;
  /**
   * Compose several captured responses. Each key binds that source's body as
   * `$sources.name`, so `map` can join across responses:
   * `"stars_per_day": "$sources.repo.stars / $sources.release.age_days"`. All
   * sources must be captured, or the tier misses as a whole.
   */
  sources?: Record<string, InterceptSource>;
  /** JSONata over `$res` (the parsed body) selecting the rows `map` shapes */
  items?: ExprString;
  /** JSONata (or object of them) over `$item`/`$res`, or `$sources` */
  map?: MapSpec;
  /** Tier-specific exceptions, evaluated before document exceptions. */
  exceptions?: ExceptionMap;
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
  /** Tier-specific exceptions, evaluated before document exceptions. */
  exceptions?: ExceptionMap;
  /** if set, extract one object per matching element */
  item?: string;
  fields?: Record<string, DomFieldSpec>;
  /** JSONata over `$value`, the extracted value */
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

export interface MutationState {
  /** True once the broker dispatched the first perform step. */
  performStarted: boolean;
  /** Last 0-based step whose completion was acknowledged by the browser. */
  lastAcknowledgedStep?: number;
  /** Conservative warning: an unacknowledged action may already have reached the page. */
  submissionMayHaveHappened: boolean;
  /** Whether completion of every perform step is known. */
  performed: "no" | "yes" | "unknown";
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
      /** Broker id of the tab the call ran in; pass it back as `tab` to target it again. */
      tab?: string;
    }
  | {
      kind: "outcome";
      name: string;
      value: unknown;
      /** Recovery advice from the matched exception (including inherited fields). */
      hint?: string;
      resolver: Resolver["kind"];
      performed?: true;
      /** Broker id of the tab the call ran in; pass it back as `tab` to target it again. */
      tab?: string;
    }
  | {
      kind: "error";
      message: string;
      /** present when a resolved value failed its declared `returns` schema */
      issues?: ValidationIssue[];
      /** Host consent, execution-context, perform, or broker failure classification. */
      code?:
        | "writes_not_allowed"
        | "required_backend_unavailable"
        | "perform_failed"
        | "broker_busy"
        | "tab_closed"
        | "out_dir_required"
        | "out_dir_invalid"
        | "file_invalid";
      /** 0-based index of the perform step that failed */
      step?: number;
      performed?: true;
      /** Present on ambiguous non-idempotent timeouts so callers can assess retry risk. */
      mutation?: MutationState;
      /** Broker id of the tab the call ran in, when it is still open. */
      tab?: string;
    };

/** A concrete request an http tier asks its host to perform. */
export type HttpFetchBody =
  | { kind: "json"; value: string }
  | { kind: "text"; value: string }
  | { kind: "form"; entries: [string, string][] }
  | { kind: "search"; entries: [string, string][] };

export interface HttpFetchRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: HttpFetchBody;
  /** Browser credential/context requirement. */
  credentials: HttpCredentials;
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
      /** Maximum additional time to wait for interactive authentication; 0 disables it. */
      authLeaseMs?: number;
      /** Absolute deadline for the initial execution attempt (before auth waiting). */
      deadline?: number;
      /** consent for a spec with `perform` steps; default false at every layer */
      allowWrites?: boolean;
      /** bypass cached results and do not cache the result of this call */
      noCache?: boolean;
      /** absolute directory a `returns: {"type": "file"}` lens writes its file into */
      outDir?: string;
      /** Per-call target supplied only by the client instance with an active recorder. */
      recording?: { path: string; callId: string; lens: string };
      /** Run in this broker tab id (an earlier result's `tab`). */
      tab?: string;
    }
  | {
      type: "observe";
      id: string;
      /** Omitted with `tab`: read the tab where it is. */
      target?: string;
      /** Observe this broker tab id; a target is reached without opening a tab. */
      tab?: string;
      waitMs: number;
      html?: boolean;
      deadline?: number;
    }
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
