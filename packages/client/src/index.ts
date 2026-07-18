import { resolve } from "node:path";
import { matchUrl, type LensResult, type LensSpec } from "@djgrant/lens";
import { BrowserBridge, type LensLogger, type LensTransport } from "./bridge.js";
import { LensStore } from "./lens-store.js";

const DEFAULT_PORT_START = 4319;
const DEFAULT_PORT_END = 4329;

export interface LensClientOptions {
  directory?: string;
  port?: number;
  portRange?: readonly [start: number, end: number];
  transport?: LensTransport;
  log?: LensLogger;
}

export interface LensCall {
  lens: string;
  target?: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface LensObservation {
  target: string;
  waitMs?: number;
  timeoutMs?: number;
}

export interface LensSummary {
  lens: string;
  description?: string;
  accepts: string[];
  defaultTarget?: string;
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
      lens: `${spec.lens}@v${spec.version}`,
      description: spec.description,
      accepts: spec.accepts,
      defaultTarget: spec.defaultTarget,
      effects: spec.effects,
      outcomes: spec.outcomes ? Object.keys(spec.outcomes) : [],
    }));
  }

  async call(input: LensCall): Promise<LensCallResult> {
    this.log(`resolving lens ${input.lens}`);
    const spec = await this.store.resolve(input.lens);
    const target = input.target ?? spec.defaultTarget;
    if (!target) {
      return {
        kind: "error",
        message: `${spec.lens}@v${spec.version} requires a target URL`,
      };
    }
    this.log(
      `resolved ${spec.lens}@v${spec.version} for ${target}${input.target ? "" : " (default target)"}`
    );
    if (!matchUrl(spec.accepts, target)) {
      return {
        kind: "error",
        message: `target ${target} does not match ${spec.lens}@v${spec.version} accepts patterns: ${spec.accepts.join(", ")}`,
      };
    }

    const args = input.args ?? {};
    const key = `${spec.lens}@v${spec.version}|${target}|${JSON.stringify(args)}`;
    const ttl = (spec.effects.cache ?? 0) * 1000;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt <= Date.now()) this.cache.delete(key);
    if (ttl > 0 && hit && hit.expiresAt > Date.now()) {
      this.log(`returning cached result for ${spec.lens}@v${spec.version}`);
      return { ...hit.result, cached: true };
    }

    this.log(`calling ${spec.lens}@v${spec.version}; args: ${Object.keys(args).join(", ") || "none"}`);
    const result = await this.transport.call(spec, target, args, input.timeoutMs);
    if (result.kind === "value" && !result.partial && ttl > 0) {
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
      bridge: this.transport.info,
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
  if (options.port !== undefined && options.portRange !== undefined) {
    throw new Error("choose either port or portRange, not both");
  }
  if (options.transport && (options.port !== undefined || options.portRange !== undefined)) {
    throw new Error("bridge port options cannot be combined with a custom transport");
  }
  if (options.port !== undefined) validatePort(options.port);
  if (options.portRange !== undefined) {
    validatePort(options.portRange[0]);
    validatePort(options.portRange[1]);
    if (options.portRange[0] > options.portRange[1]) {
      throw new Error("portRange start must not exceed its end");
    }
  }
  const directory = resolve(options.directory ?? "lenses");
  const log = options.log ?? (() => {});
  log(`using lens directory ${directory}`);
  const store = new LensStore(directory);
  const loaded = await store.loadLocal();
  log(`validated ${loaded.length} local lenses`);
  const range = options.portRange ?? [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const transport =
    options.transport ??
    (options.port !== undefined
      ? await BrowserBridge.bind(options.port, "127.0.0.1", log)
      : await BrowserBridge.bindRange(range[0], range[1], "127.0.0.1", log));
  return new LensClient(store, transport, log);
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("bridge ports must be integers between 1 and 65535");
  }
}

export { BrowserBridge, LensStore };
export type { LensLogger, LensTransport };
