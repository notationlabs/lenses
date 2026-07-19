import { resolve } from "node:path";
import { expandUrl, resolveParams, type LensResult, type LensSpec } from "@djgrant/lens";
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

export type LensCallResult = LensResult & { cached?: boolean };

interface CacheEntry {
  result: LensResult;
  expiresAt: number;
}

export class LensClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: LensStore,
    private readonly transport: LensTransport,
    private readonly log: LensLogger = () => {}
  ) {}

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
      return { ...hit.result, cached: true };
    }

    this.log(`calling ${spec.name}; params: ${Object.keys(params).join(", ") || "none"}`);
    const result = await this.transport.call(spec, params, input.timeoutMs);
    if (result.kind === "value" && !result.partial && !result.cached && ttl > 0) {
      this.cache.set(key, { result, expiresAt: Date.now() + ttl });
    }
    return result;
  }

  observe(input: LensObservation): Promise<LensResult> {
    this.log(`observing ${input.target}`);
    return this.transport.observe(input.target, input.waitMs, input.timeoutMs);
  }

  status() {
    return {
      connected: this.transport.connected,
      broker: this.transport.info,
      port: this.transport.port,
    };
  }

  waitForConnection(timeoutMs = 5_000): Promise<boolean> {
    return this.transport.waitForConnection(timeoutMs);
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function createLensClient(options: LensClientOptions = {}): Promise<LensClient> {
  if (options.transport && options.port !== undefined) {
    throw new Error("broker port cannot be combined with a custom transport");
  }
  if (options.port !== undefined) validatePort(options.port);
  const directory = resolve(options.directory ?? "lenses");
  const log = options.log ?? (() => {});
  log(`using lens directory ${directory}`);
  const store = new LensStore(directory);
  const loaded = await store.loadLocal();
  log(`validated ${loaded.length} local lenses`);
  const transport =
    options.transport ??
    (await BrowserBridge.bind(options.port ?? DEFAULT_PORT_START, "127.0.0.1", log));
  return new LensClient(store, transport, log);
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("broker port must be an integer between 1 and 65535");
  }
}

export { BrowserBridge, LensStore };
export type { LensLogger, LensTransport, LensTransportResult };
