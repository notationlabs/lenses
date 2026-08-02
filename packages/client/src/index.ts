import {
  deriveJsonSchema,
  errorMessage,
  expandUrl,
  paramLensDefault,
  resolveParams,
  specWarnings,
  validateResult,
  type LensParam,
  type LensResult,
  type LensSpec,
  type ParamLensDefault,
  type ValidationIssue,
} from "@djgrant/lens";
import {
  BrowserBridge,
  type BrokerControlAction,
  type BrokerLease,
  type LensLogger,
  type LensTransport,
  type LensTransportResult,
} from "./bridge.js";
import { LensStore, type CatalogUpdate } from "./lens-store.js";
import { parseCatalogSource, scanLensFiles, type CatalogSource, type LensFile } from "./catalog.js";

const DEFAULT_PORT_START = 4319;

export interface LensClientOptions {
  /**
   * One or more lens catalog sources, tried in order — never assumed.
   * A source is a directory path (`./examples` or `file:./examples`), a git
   * reference (`git:github.com/owner/repo#ref/subdir`), or an HTTP catalog
   * index URL (`https://…/catalog.json`). May be omitted for catalog-independent
   * operations (status, observe, calling a lens by file path or URL).
   */
  catalog?: string | string[];
  port?: number;
  transport?: LensTransport;
  log?: LensLogger;
}

export interface LensCall {
  lens: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /**
   * Consent for a lens with `perform` steps (writes). Default false: the
   * broker denies with code "writes_not_allowed". Never inherited by nested
   * calls or {$lens} parameter defaults.
   */
  allowWrites?: boolean;
  /** when false, demote `returns` schema violations from an error result to warnings (default true) */
  strict?: boolean;
}

export interface LensObservation {
  target: string;
  waitMs?: number;
  timeoutMs?: number;
  /** include the page's body HTML (scripts and styles stripped) for selector authoring */
  html?: boolean;
  /**
   * Drill into captured request bodies: a request index from a prior observation,
   * or a URL substring matching one or more requests. Without this, observations
   * return an index of captured requests (method, url, status, size, preview)
   * with bodies omitted.
   */
  request?: number | string;
}

interface CapturedRequest {
  method: string;
  url: string;
  status: number;
  bodyPreview: string;
}

const REQUEST_MATCH_LIMIT = 5;

export interface LensSummary {
  name: string;
  shortname: string;
  url: string;
  description?: string;
  params: LensSpec["params"];
  effects: LensSpec["effects"];
  outcomes: string[];
  /** non-fatal problems with the document; absent when there are none */
  warnings?: string[];
}

export type LensCallResult = LensResult & { cached?: boolean; warnings?: ValidationIssue[] };

/** A named outcome, thrown by `value()`. `hint` is the remediation text declared in the lens document. */
export class LensOutcomeError extends Error {
  constructor(
    readonly outcome: string,
    readonly value: unknown,
    readonly hint?: string
  ) {
    super(hint ? `lens outcome "${outcome}": ${hint}` : `lens outcome "${outcome}"`);
    this.name = "LensOutcomeError";
  }
}

/** An error result, thrown by `value()`. `issues` names failing JSON pointers, when present. */
export class LensResultError extends Error {
  constructor(
    message: string,
    readonly issues?: ValidationIssue[]
  ) {
    super(message);
    this.name = "LensResultError";
  }
}

interface CacheEntry {
  result: LensResult;
  expiresAt: number;
}

/** Bounds on resolving {$lens} parameter defaults within one outer call. */
const REF_DEFAULT_MAX_CALLS = 8;
const REF_DEFAULT_MAX_DEPTH = 4;

interface RefDefaultContext {
  /** shared across the whole outer call, including nested default chains */
  budget: { remaining: number };
  depth: number;
  /** canonical (lens, params) identities of calls in progress, for cycle detection */
  stack: Set<string>;
}

const freshRefDefaultContext = (): RefDefaultContext => ({
  budget: { remaining: REF_DEFAULT_MAX_CALLS },
  depth: 0,
  stack: new Set(),
});

const canonicalCallKey = (lens: string, params: Record<string, unknown>): string =>
  `${lens}|${JSON.stringify(
    Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
  )}`;

/**
 * A ref default must project a top-level non-nullable primitive that agrees
 * with the declared param type — checked before the call, so an authoring
 * mistake fails without spending a browser call.
 */
function checkRefDefaultTarget(
  target: LensSpec,
  ref: ParamLensDefault,
  declaration: LensParam,
  via: string
): void {
  const paramType = typeof declaration === "string" ? declaration : declaration.type;
  const returns = target.returns as { type?: unknown; fields?: Record<string, unknown> } | undefined;
  const field =
    returns && returns.type === "object" && returns.fields ? returns.fields[ref.field] : undefined;
  if (field === undefined) {
    throw new Error(
      `${via}: ${ref.$lens} does not declare a top-level "${ref.field}" field in its returns`
    );
  }
  const agrees = field === paramType || (paramType === "number" && field === "integer");
  if (!agrees) {
    throw new Error(
      `${via}: field "${ref.field}" of ${ref.$lens} is not a non-nullable ${paramType}`
    );
  }
}

export class LensClient {
  private readonly cache = new Map<string, CacheEntry>();
  private transportPromise?: Promise<LensTransport>;

  constructor(
    private readonly store: LensStore,
    private readonly connect: LensTransport | (() => Promise<LensTransport>),
    private readonly log: LensLogger = () => {}
  ) {}

  /** Bind the broker on first use, so constructing a client has no side effects. */
  private transport(): Promise<LensTransport> {
    return (this.transportPromise ??= this.bind());
  }

  /**
   * Brokers are disposable — they retire when idle or when a rebuild makes them
   * stale — so a cached transport outlives its socket. Dropping it on close
   * lets the next call rebind, which respawns a broker and gives a dormant
   * extension a fresh chance to attach.
   */
  private async bind(): Promise<LensTransport> {
    if (typeof this.connect !== "function") return this.connect;
    const transport = await this.connect();
    // Captured after the await, when transport() has stored the promise.
    const bound = this.transportPromise;
    transport.onClose?.(() => {
      if (this.transportPromise === bound) this.transportPromise = undefined;
    });
    return transport;
  }

  async list(): Promise<LensSummary[]> {
    this.log("loading lens listing");
    const specs = await this.store.load();
    this.log(`loaded ${specs.length} lenses`);
    return specs.map((spec) => {
      // The listing is where an undeclared outcome hides: it shows the outcomes
      // the document declares, which is precisely the set that is wrong.
      const warnings = specWarnings(spec);
      return {
        name: spec.name,
        shortname: spec.name.slice(spec.name.indexOf("/") + 1),
        url: spec.url,
        description: spec.description,
        params: spec.params,
        effects: spec.effects,
        outcomes: spec.outcomes ? Object.keys(spec.outcomes) : [],
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  async call(input: LensCall): Promise<LensCallResult> {
    return this.callWithin(input, freshRefDefaultContext());
  }

  private async callWithin(input: LensCall, refs: RefDefaultContext): Promise<LensCallResult> {
    this.log(`resolving lens ${input.lens}`);
    const spec = await this.store.resolve(input.lens);
    const supplied = input.params ?? {};
    const key = canonicalCallKey(spec.name, supplied);
    if (refs.stack.has(key)) {
      return {
        kind: "error",
        message: `circular parameter default: ${spec.name} called again with the same params while its defaults were being resolved`,
      };
    }
    refs.stack.add(key);
    try {
      return await this.dispatch(input, spec, supplied, refs);
    } finally {
      refs.stack.delete(key);
    }
  }

  private async dispatch(
    input: LensCall,
    spec: LensSpec,
    supplied: Record<string, unknown>,
    refs: RefDefaultContext
  ): Promise<LensCallResult> {
    let params: Record<string, unknown>;
    let url: string;
    try {
      params = resolveParams(spec, await this.applyRefDefaults(spec, supplied, refs));
      url = expandUrl(spec.url, params);
    } catch (error) {
      return { kind: "error", message: (error as Error).message };
    }
    this.log(`resolved ${spec.name} to ${url}`);

    const key = `${JSON.stringify(spec)}|${JSON.stringify(params)}`;
    const ttl = (spec.effects.cache ?? 0) * 1000;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt <= Date.now()) this.cache.delete(key);
    if (ttl > 0 && hit && hit.expiresAt > Date.now()) {
      this.log(`returning cached result for ${spec.name}`);
      return this.validate(spec, { ...hit.result, cached: true }, input.strict ?? true);
    }

    this.log(`calling ${spec.name}; params: ${Object.keys(params).join(", ") || "none"}`);
    const result = await (await this.transport()).call(
      spec,
      params,
      input.timeoutMs,
      input.allowWrites
    );
    if (result.kind === "value" && !result.partial && !result.cached && ttl > 0) {
      this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    }
    return this.validate(spec, result, input.strict ?? true);
  }

  /**
   * Fill omitted params whose default is a {$lens, field} reference by calling
   * the target lens and projecting the field. The engine only ever sees
   * concrete values; the projected value passes through the normal type and
   * enum checks in resolveParams like any caller-supplied input.
   */
  private async applyRefDefaults(
    spec: LensSpec,
    supplied: Record<string, unknown>,
    refs: RefDefaultContext
  ): Promise<Record<string, unknown>> {
    const filled = { ...supplied };
    for (const [key, declaration] of Object.entries(spec.params ?? {})) {
      const ref = paramLensDefault(declaration);
      if (!ref || Object.hasOwn(filled, key)) continue;
      const via = `default for "${key}" via ${ref.$lens}`;
      if (refs.depth >= REF_DEFAULT_MAX_DEPTH) {
        throw new Error(`${via}: parameter default chain exceeds depth ${REF_DEFAULT_MAX_DEPTH}`);
      }
      if (refs.budget.remaining <= 0) {
        throw new Error(
          `${via}: parameter default call budget of ${REF_DEFAULT_MAX_CALLS} exhausted`
        );
      }
      refs.budget.remaining -= 1;
      checkRefDefaultTarget(await this.store.resolve(ref.$lens), ref, declaration, via);
      this.log(`resolving ${via}`);
      const result = await this.callWithin(
        { lens: ref.$lens, params: ref.params ?? {} },
        { budget: refs.budget, depth: refs.depth + 1, stack: refs.stack }
      );
      if (result.kind === "outcome") throw new Error(`${via}: returned outcome "${result.name}"`);
      if (result.kind === "error") throw new Error(`${via}: ${result.message}`);
      if (result.partial) throw new Error(`${via}: returned a partial result`);
      const row = result.value;
      const value =
        typeof row === "object" && row !== null && !Array.isArray(row)
          ? (row as Record<string, unknown>)[ref.field]
          : undefined;
      if (value === undefined || value === null) {
        throw new Error(
          `${via}: field "${ref.field}" is ${value === null ? "null" : "missing"} in the result`
        );
      }
      filled[key] = value;
    }
    return filled;
  }

  /** `call()` unwrapped: the resolved value, or a thrown LensOutcomeError / LensResultError. */
  async value(input: LensCall): Promise<unknown> {
    const result = await this.call(input);
    if (result.kind === "value") return result.value;
    if (result.kind === "outcome") {
      const declared = (await this.store.resolve(input.lens)).outcomes?.[result.name];
      const hint =
        typeof declared === "object" && declared !== null && "hint" in declared
          ? (declared as { hint?: unknown }).hint
          : undefined;
      throw new LensOutcomeError(
        result.name,
        result.value,
        typeof hint === "string" ? hint : undefined
      );
    }
    throw new LensResultError(result.message, result.issues);
  }

  /** Validate a value result against the schema derived from `returns`. */
  private validate(spec: LensSpec, result: LensCallResult, strict: boolean): LensCallResult {
    if (result.kind !== "value") return result;
    const issues = validateResult(spec, result.value);
    if (issues.length === 0) return result;
    if (strict) {
      const missing = issues.filter((issue) => issue.missing);
      // Name where the value was actually read from. A signed-out redirect
      // lands somewhere else and fails every field, which is indistinguishable
      // from a broken selector until you can see the URL.
      const where = result.observed ? ` (read from ${result.observed})` : "";
      const message = missing.length
        ? `${spec.name}: no resolver produced field ${missing
            .map((issue) => issue.path)
            .join(", ")}${where}`
        : `${spec.name} result failed its schema at ${issues
            .map((issue) => issue.path)
            .join(", ")}${where}`;
      return { kind: "error", message, issues };
    }
    this.log(`${spec.name} result has ${issues.length} schema warning(s)`);
    return { ...result, warnings: issues };
  }

  /** Refresh cached catalog sources (git clones, HTTP indexes) from their origins. */
  async update(): Promise<CatalogUpdate[]> {
    return this.store.update();
  }

  /** Standard JSON Schema (draft 2020-12) for a lens's resolved value. */
  async schema(lens: string): Promise<Record<string, unknown>> {
    return deriveJsonSchema(await this.store.resolve(lens));
  }

  async observe(input: LensObservation): Promise<LensResult> {
    this.log(`observing ${input.target}`);
    const result = await (await this.transport()).observe(
      input.target,
      input.waitMs,
      input.timeoutMs,
      input.html
    );
    if (result.kind !== "value") return result;
    const value = result.value as { snapshot?: unknown; requests?: CapturedRequest[] };
    if (typeof value !== "object" || value === null || !Array.isArray(value.requests)) {
      return result;
    }
    const indexed = value.requests.map((request, index) => ({ index, ...request }));

    if (input.request !== undefined) {
      const selector = input.request;
      const matches =
        typeof selector === "number"
          ? indexed.filter((request) => request.index === selector)
          : indexed.filter((request) => request.url.includes(selector));
      if (matches.length === 0) {
        return {
          kind: "error",
          message: `no captured request matches ${JSON.stringify(selector)} (${indexed.length} requests captured; observe without "request" for the index)`,
        };
      }
      return {
        ...result,
        value: {
          matched: matches.length,
          ...(matches.length > REQUEST_MATCH_LIMIT
            ? { note: `showing first ${REQUEST_MATCH_LIMIT} of ${matches.length} matching bodies; narrow the request pattern or select by index` }
            : {}),
          requests: matches.slice(0, REQUEST_MATCH_LIMIT).map((request) => ({
            index: request.index,
            method: request.method,
            url: request.url,
            status: request.status,
            body: request.bodyPreview,
          })),
        },
      };
    }

    return {
      ...result,
      value: {
        ...value,
        requests: indexed.map((request) => ({
          index: request.index,
          method: request.method,
          url: request.url,
          status: request.status,
          bodyChars: request.bodyPreview.length,
          bodyPreview: request.bodyPreview.slice(0, 120),
        })),
        note: "request bodies elided; observe again with request set to an index or URL substring to read a body",
      },
    };
  }

  async status() {
    const transport = await this.transport();
    return {
      connected: transport.connected,
      lease: transport.lease ?? (transport.connected ? "held" : "disconnected"),
      broker: transport.info,
      port: transport.port,
    };
  }

  /**
   * Retire the broker daemon: it drains in-flight work, releases the CDP lease
   * and exits. The next client spawns a fresh one, which is also how a client
   * running newer code replaces a stale broker.
   */
  async shutdownBroker(timeoutMs?: number): Promise<{ shuttingDown: boolean }> {
    const transport = await this.transport();
    if (!transport.control) {
      throw new Error("this transport does not support broker control");
    }
    const result = await transport.control("shutdown", timeoutMs);
    if (result.kind === "error") throw new Error(result.message);
    return { shuttingDown: true };
  }

  /**
   * Control the broker's CDP lease on Chrome's single consented debugging slot.
   * "release" frees the slot for other CDP tools; "acquire" reconnects (Chrome
   * shows a fresh Allow dialog); "status" reports without side effects.
   */
  async broker(
    action: BrokerControlAction,
    timeoutMs?: number
  ): Promise<{ connected: boolean; lease: BrokerLease }> {
    const transport = await this.transport();
    if (!transport.control) {
      throw new Error("this transport does not support broker lease control");
    }
    const result = await transport.control(action, timeoutMs);
    if (result.kind === "error") throw new Error(result.message);
    return result.kind === "value"
      ? (result.value as { connected: boolean; lease: BrokerLease })
      : { connected: transport.connected, lease: transport.lease ?? "disconnected" };
  }

  async waitForConnection(timeoutMs = 5_000): Promise<boolean> {
    return (await this.transport()).waitForConnection(timeoutMs);
  }

  async close(): Promise<void> {
    if (!this.transportPromise) return;
    const transport = await this.transportPromise.catch(() => null);
    await transport?.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Construction is synchronous; the broker is bound lazily on first use. */
export function createLensClient(options: LensClientOptions): LensClient {
  if (options.transport && options.port !== undefined) {
    throw new Error("broker port cannot be combined with a custom transport");
  }
  if (options.port !== undefined) validatePort(options.port);
  const catalogs =
    options.catalog === undefined
      ? []
      : Array.isArray(options.catalog)
        ? options.catalog
        : [options.catalog];
  if (catalogs.some((catalog) => !catalog)) {
    throw new Error("lens catalog sources must be non-empty strings");
  }
  const sources = catalogs.map(parseCatalogSource);
  const log = options.log ?? (() => {});
  log(`using lens catalog(s) ${sources.map((source) => source.id).join(", ")}`);
  return new LensClient(
    new LensStore(sources),
    options.transport ??
      (() => BrowserBridge.bind(options.port ?? DEFAULT_PORT_START, "127.0.0.1", log)),
    log
  );
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("broker port must be an integer between 1 and 65535");
  }
}

export { BrowserBridge, LensStore, parseCatalogSource, scanLensFiles, errorMessage };
export type {
  BrokerControlAction,
  BrokerLease,
  CatalogSource,
  CatalogUpdate,
  LensFile,
  LensLogger,
  LensTransport,
  LensTransportResult,
};
