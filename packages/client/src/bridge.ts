import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { LensBridgeRequest, LensResult, LensSpec } from "@djgrant/lenses-core";
import { coordinateRespawn } from "./broker-respawn.js";
import { brokerBuildStamp } from "./broker-stamp.js";
import { authProof, loadBrokerAuth, proofMatches } from "./broker-auth.js";
import { randomBytes } from "node:crypto";
import type { RecordingTarget } from "./recording.js";

const BROKER_START_WAIT_MS = 3_000;
const BROKER_SHUTDOWN_WAIT_MS = 12_000;
/** Bounded so a stamp that never converges reports an error instead of looping. */
const BROKER_BIND_ATTEMPTS = 3;

export type LensLogger = (message: string) => void;
export type LensTransportResult = LensResult & {
  cached?: boolean;
  /** Broker request identity, attached to errors for correlation with diagnostics. */
  callId?: string;
  /** Canonical lens name, attached to call errors. */
  lens?: string;
};
export type BrokerLease = "held" | "released" | "disconnected";
export type BrokerControlAction = "release" | "acquire" | "status" | "shutdown";

export interface BrokerStartupOptions {
  browserProfile?: string;
  playwrightExtensionToken?: string;
}

export interface BrokerBackendStatus {
  name: string;
  available: boolean;
  detail?: string;
  version?: string;
  protocolMajor?: number;
  capabilities?: string[];
  diagnostic?: string;
  reconnectAttempts?: number;
  sameOriginPageRequests?: boolean;
}

export interface BrokerDiagnostics {
  concurrency: "serial_queue";
  activeCall?: { id: string; type: "call" | "observe"; lens?: string; startedAt: number };
  queuedCalls: number;
  lastBackendError?: string;
  reconnectAttempts: number;
  reachability: { chrome?: boolean; extension: boolean };
}

export interface LensTransport {
  readonly connected: boolean;
  readonly info: string;
  readonly port: number;
  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs?: number,
    /** consent for a spec with `perform` steps; the broker denies without it */
    allowWrites?: boolean,
    recording?: RecordingTarget
  ): Promise<LensTransportResult>;
  observe(
    target: string,
    waitMs?: number,
    timeoutMs?: number,
    html?: boolean
  ): Promise<LensTransportResult>;
  waitForConnection(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
  /** Notifies when the transport's socket goes away, so callers can rebind. */
  onClose?(listener: () => void): void;
  /** CDP lease state, when the transport reports it (the broker does). */
  readonly lease?: BrokerLease;
  readonly backend?: string;
  readonly capabilities?: readonly string[];
  readonly backends?: readonly BrokerBackendStatus[];
  readonly advice?: string;
  readonly diagnostics?: BrokerDiagnostics;
  /** Release/acquire the broker's CDP lease; optional for custom transports. */
  control?(action: BrokerControlAction, timeoutMs?: number): Promise<LensTransportResult>;
}

type BrokerMessage =
  | {
      type: "status";
      connected: boolean;
      lease?: BrokerLease;
      backend?: string;
      ua?: string;
      capabilities?: string[];
      backends?: BrokerBackendStatus[];
      advice?: string;
      diagnostics?: BrokerDiagnostics;
      /** Build stamp of the daemon's code; absent on brokers older than this. */
      stamp?: string;
    }
  | { type: "result"; id: string; result: LensTransportResult }
  | { type: "progress"; id: string; message: string };

export class BrowserBridge implements LensTransport {
  private browserConnected = false;
  private browserInfo = "";
  private browserLease: BrokerLease = "disconnected";
  private selectedBackend?: string;
  private negotiatedCapabilities: string[] = [];
  private backendStatuses: BrokerBackendStatus[] = [];
  private statusAdvice?: string;
  private brokerDiagnostics?: BrokerDiagnostics;
  private readonly pending = new Map<
    string,
    {
      resolve: (result: LensTransportResult) => void;
      timer: NodeJS.Timeout;
      control?: boolean;
      description: string;
      lastProgress?: string;
    }
  >();
  private readonly connectionWaiters = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly port: number,
    private readonly log: LensLogger,
    status: Extract<BrokerMessage, { type: "status" }>
  ) {
    this.browserConnected = status.connected;
    this.browserInfo = status.ua ?? "";
    this.browserLease = status.lease ?? (status.connected ? "held" : "disconnected");
    this.updateBackendStatus(status);
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => {
      this.browserConnected = false;
      this.resolvePending({ kind: "error", message: "lens broker disconnected" });
      for (const listener of this.closeListeners) listener();
      this.closeListeners.clear();
    });
  }

  static async bind(
    port: number,
    host = "127.0.0.1",
    log: LensLogger = () => {},
    startup: BrokerStartupOptions = {}
  ): Promise<BrowserBridge> {
    if (host !== "127.0.0.1") throw new Error("the lens broker only listens on 127.0.0.1");
    const expected = brokerBuildStamp();
    for (let attempt = 1; attempt <= BROKER_BIND_ATTEMPTS; attempt += 1) {
      const connection =
        (await connectBroker(port, 150)) ?? (await startBroker(port, log, startup));
      const stamp = connection.status.stamp;
      if (stamp !== undefined && stamp !== expected) {
        log(`lens broker on port ${port} runs build ${stamp}, expected ${expected}`);
        await retireStaleBroker(connection, port, log);
        continue;
      }
      log(`connected to lens broker on ws://${host}:${port}`);
      if (connection.status.connected) {
        log(`browser connected through broker port ${port}`);
      }
      return new BrowserBridge(connection.socket, port, log, connection.status);
    }
    throw new Error(
      `lens broker on port ${port} still reports a stale build after ${BROKER_BIND_ATTEMPTS} restart attempts`
    );
  }

  get connected(): boolean {
    return this.browserConnected;
  }

  get lease(): BrokerLease {
    return this.browserLease;
  }

  get info(): string {
    return this.connected
      ? `connected${this.browserInfo ? ` (${this.browserInfo})` : ""}`
      : "not connected";
  }

  get backend(): string | undefined {
    return this.selectedBackend;
  }

  get capabilities(): readonly string[] {
    return this.negotiatedCapabilities;
  }

  get backends(): readonly BrokerBackendStatus[] {
    return this.backendStatuses;
  }

  get advice(): string | undefined {
    return this.statusAdvice;
  }

  get diagnostics(): BrokerDiagnostics | undefined {
    return this.brokerDiagnostics;
  }

  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs = 90_000,
    allowWrites?: boolean,
    recording?: RecordingTarget
  ): Promise<LensTransportResult> {
    return this.request(
      (id) => ({
        type: "call",
        id,
        spec,
        params,
        timeoutMs,
        deadline: Date.now() + timeoutMs,
        ...(allowWrites !== undefined ? { allowWrites } : {}),
        ...(recording ? { recording } : {}),
      }),
      timeoutMs
    );
  }

  observe(
    target: string,
    waitMs = 4_000,
    timeoutMs = 60_000,
    html = false
  ): Promise<LensTransportResult> {
    return this.request(
      (id) => ({
        type: "observe",
        id,
        target,
        waitMs,
        html,
        deadline: Date.now() + timeoutMs,
      }),
      timeoutMs
    );
  }

  /**
   * release: broker drops its CDP connection so other tools can use Chrome's
   * single consented debugging slot. acquire: broker reconnects — Chrome shows
   * a fresh Allow dialog, so allow up to a minute. status: report only.
   */
  control(action: BrokerControlAction, timeoutMs = 60_000): Promise<LensTransportResult> {
    return this.request((id) => ({ type: "control", id, action }), timeoutMs);
  }

  async waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.connected) return true;
    return new Promise((resolve) => {
      let settled = false;
      const connected = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.connectionWaiters.delete(connected);
        resolve(false);
      }, timeoutMs);
      this.connectionWaiters.add(connected);
    });
  }

  onClose(listener: () => void): void {
    if (this.socket.readyState === WebSocket.CLOSED) {
      listener();
      return;
    }
    this.closeListeners.add(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resolvePending({ kind: "error", message: "lens client closed" });
    this.socket.close();
  }

  private async request(
    make: (id: string) => LensBridgeRequest,
    timeoutMs: number
  ): Promise<LensTransportResult> {
    const id = `call_${++this.sequence}`;
    const message = make(id);
    const startedAt = Date.now();
    const description = requestDescription(message, id);
    this.log(`sending ${description} through the lens broker`);
    return new Promise<LensTransportResult>((resolve) => {
      const timer = setTimeout(() => {
        const active = this.pending.get(id);
        this.pending.delete(id);
        const progress = active?.lastProgress
          ? `; last progress: ${active.lastProgress}`
          : "; no progress received from broker";
        resolve({
          kind: "error",
          message: `${description} timed out after ${timeoutMs}ms${progress}`,
          callId: id,
          ...(message.type === "call" ? { lens: message.spec.name } : {}),
        });
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        timer,
        control: message.type === "control",
        description,
      });
      this.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ kind: "error", message: `sending ${message.type}: ${error.message}` });
      });
    }).then((result) => {
      const contextual =
        result.kind === "error"
          ? {
              ...result,
              callId: result.callId ?? id,
              ...(message.type === "call" ? { lens: result.lens ?? message.spec.name } : {}),
            }
          : result;
      this.log(`${description} completed in ${Date.now() - startedAt}ms (${result.kind})`);
      return contextual;
    });
  }

  private onMessage(raw: string): void {
    let message: BrokerMessage;
    try {
      message = JSON.parse(raw) as BrokerMessage;
    } catch {
      return;
    }
    if (message.type === "status") {
      const wasConnected = this.browserConnected;
      this.browserConnected = message.connected;
      this.browserInfo = message.ua ?? "";
      this.browserLease = message.lease ?? (message.connected ? "held" : "disconnected");
      this.updateBackendStatus(message);
      if (message.connected && !wasConnected) {
        this.log(`browser connected through broker port ${this.port}`);
        for (const resolve of this.connectionWaiters) resolve();
        this.connectionWaiters.clear();
      } else if (!message.connected && wasConnected) {
        this.log("browser disconnected from lens broker");
        // Control requests survive: a "release" causes this very transition.
        this.resolvePending({ kind: "error", message: "browser disconnected" }, true);
      }
      return;
    }
    if (message.type === "progress") {
      const pending = this.pending.get(message.id);
      if (pending) pending.lastProgress = message.message;
      this.log(`browser ${message.id}: ${message.message}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message.result);
  }

  private updateBackendStatus(
    status: Extract<BrokerMessage, { type: "status" }>
  ): void {
    this.selectedBackend = status.backend;
    this.negotiatedCapabilities = [...(status.capabilities ?? [])];
    this.backendStatuses = [...(status.backends ?? [])];
    this.statusAdvice = status.advice;
    this.brokerDiagnostics = status.diagnostics;
  }

  private resolvePending(result: LensResult, keepControl = false): void {
    for (const [id, pending] of this.pending) {
      if (keepControl && pending.control) continue;
      clearTimeout(pending.timer);
      pending.resolve(result);
      this.pending.delete(id);
    }
  }
}

function requestDescription(message: LensBridgeRequest, id: string): string {
  if (message.type !== "call") return `${message.type} ${id}`;
  const recording = message.recording ? `, recording ${message.recording.callId}` : "";
  return `call ${id} for ${message.spec.name}${recording}`;
}

interface BrokerConnection {
  socket: WebSocket;
  status: Extract<BrokerMessage, { type: "status" }>;
}

/**
 * Ask a stale broker to retire. Only one client does the asking — the others
 * wait on the same lock and then simply reconnect to whatever is listening.
 */
async function retireStaleBroker(
  connection: BrokerConnection,
  port: number,
  log: LensLogger
): Promise<void> {
  const outcome = await coordinateRespawn(port, {
    respawn: () => requestShutdown(connection, log),
    waitMs: BROKER_SHUTDOWN_WAIT_MS,
  });
  connection.socket.close();
  if (outcome === "waited") log(`another client is restarting the lens broker on port ${port}`);
}

function requestShutdown(connection: BrokerConnection, log: LensLogger): Promise<void> {
  log("asking the stale lens broker to shut down");
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // The daemon drains in-flight work before exiting, so the close event — not
    // the ack — is the signal that the port is free for a fresh spawn.
    const timer = setTimeout(finish, BROKER_SHUTDOWN_WAIT_MS);
    connection.socket.once("close", finish);
    connection.socket.send(
      JSON.stringify({ type: "control", id: "shutdown", action: "shutdown" }),
      (error) => {
        if (error) finish();
      }
    );
  });
}

async function startBroker(
  port: number,
  log: LensLogger,
  startup: BrokerStartupOptions
): Promise<BrokerConnection> {
  const source = import.meta.url.endsWith(".ts") ? "broker-daemon.ts" : "broker-daemon.js";
  const entry = fileURLToPath(new URL(source, import.meta.url));
  const child = spawn(process.execPath, [entry, String(port)], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(startup.browserProfile
        ? { LENS_BROWSER_PROFILE: startup.browserProfile }
        : {}),
      ...(startup.playwrightExtensionToken
        ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: startup.playwrightExtensionToken }
        : {}),
    },
  });
  child.unref();
  log(`started persistent lens broker on port ${port}`);

  const deadline = Date.now() + BROKER_START_WAIT_MS;
  while (Date.now() < deadline) {
    const socket = await connectBroker(port, 150);
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lens broker did not start on port ${port}`);
}

function connectBroker(port: number, timeoutMs: number): Promise<BrokerConnection | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const token = loadBrokerAuth().brokerToken;
    const clientNonce = randomBytes(24).toString("base64url");
    let authenticated = false;
    let settled = false;
    const onError = () => finish(null);
    const onOpen = () => {
      socket.send(JSON.stringify({ type: "client-auth", nonce: clientNonce }));
    };
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "auth-challenge") {
          const serverNonce = message.nonce;
          if (
            typeof serverNonce !== "string" ||
            !proofMatches(message.proof, authProof(token, "broker", clientNonce, serverNonce))
          ) {
            finish(null);
            return;
          }
          authenticated = true;
          socket.send(JSON.stringify({
            type: "auth-response",
            proof: authProof(token, "client", clientNonce, serverNonce),
          }));
          return;
        }
        const status = message as unknown as BrokerMessage;
        if (authenticated && status.type === "status") finish({ socket, status });
      } catch {
        // A service on this port is not an authenticated lens broker.
      }
    };
    const finish = (value: BrokerConnection | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("message", onMessage);
      if (!value) {
        socket.on("error", () => {});
        socket.close();
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.on("message", onMessage);
  });
}
