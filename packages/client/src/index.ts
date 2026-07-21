import { resolve } from "node:path";
import {
  deriveJsonSchema,
  expandUrl,
  resolveParams,
  validateResult,
  type LensResult,
  type LensSpec,
  type ValidationIssue,
} from "@djgrant/lens";
import {
  BrowserBridge,
  type LensLogger,
  type LensTransport,
  type LensTransportResult,
} from "./bridge.js";
import { LensStore } from "./lens-store.js";

const DEFAULT_PORT_START = 4319;

export interface LensClientOptions {
  directory?: string;
  port?: number;
  transport?: LensTransport;
  log?: LensLogger;
}

export interface LensCall {
  lens: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  /** when false, demote `returns` schema violations from an error result to warnings (default true) */
  strict?: boolean;
}

export interface LensObservation {
  target: string;
  waitMs?: number;
  timeoutMs?: number;
}

export interface LensSummary {
  name: string;
  shortname: string;
  url: string;
  description?: string;
  params: LensSpec["params"];
  effects: LensSpec["effects"];
  outcomes: string[];
}

export type LensCallResult = LensResult & { cached?: boolean; warnings?: ValidationIssue[] };

interface CacheEntry {
  result: LensResult;
  expiresAt: number;
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
    return (this.transportPromise ??=
      typeof this.connect === "function" ? this.connect() : Promise.resolve(this.connect));
  }

  async list(): Promise<LensSummary[]> {
    this.log("loading local lens listing");
    const specs = await this.store.loadLocal();
    this.log(`loaded ${specs.length} lenses`);
    return specs.map((spec) => ({
      name: spec.name,
      shortname: spec.name.slice(spec.name.indexOf("/") + 1),
      url: spec.url,
      description: spec.description,
      params: spec.params,
      effects: spec.effects,
      outcomes: spec.outcomes ? Object.keys(spec.outcomes) : [],
    }));
  }

  async call(input: LensCall): Promise<LensCallResult> {
    this.log(`resolving lens ${input.lens}`);
    const spec = await this.store.resolve(input.lens);
    let params: Record<string, unknown>;
    let url: string;
    try {
      params = resolveParams(spec, input.params ?? {});
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
    const result = await (await this.transport()).call(spec, params, input.timeoutMs);
    if (result.kind === "value" && !result.partial && !result.cached && ttl > 0) {
      this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    }
    return this.validate(spec, result, input.strict ?? true);
  }

  /** Validate a value result against the schema derived from `returns`. */
  private validate(spec: LensSpec, result: LensCallResult, strict: boolean): LensCallResult {
    if (result.kind !== "value") return result;
    const issues = validateResult(spec, result.value);
    if (issues.length === 0) return result;
    if (strict) {
      return {
        kind: "error",
        message: `${spec.name} result failed its schema at ${issues
          .map((issue) => issue.path)
          .join(", ")}`,
        issues,
      };
    }
    this.log(`${spec.name} result has ${issues.length} schema warning(s)`);
    return { ...result, warnings: issues };
  }

  /** Standard JSON Schema (draft 2020-12) for a lens's resolved value. */
  async schema(lens: string): Promise<Record<string, unknown>> {
    return deriveJsonSchema(await this.store.resolve(lens));
  }

  async observe(input: LensObservation): Promise<LensResult> {
    this.log(`observing ${input.target}`);
    return (await this.transport()).observe(input.target, input.waitMs, input.timeoutMs);
  }

  async status() {
    const transport = await this.transport();
    return {
      connected: transport.connected,
      broker: transport.info,
      port: transport.port,
    };
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
export function createLensClient(options: LensClientOptions = {}): LensClient {
  if (options.transport && options.port !== undefined) {
    throw new Error("broker port cannot be combined with a custom transport");
  }
  if (options.port !== undefined) validatePort(options.port);
  const directory = resolve(options.directory ?? "lenses");
  const log = options.log ?? (() => {});
  log(`using lens directory ${directory}`);
  return new LensClient(
    new LensStore(directory),
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

export { BrowserBridge, LensStore };
export type { LensLogger, LensTransport, LensTransportResult };
