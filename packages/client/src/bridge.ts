import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { LensBridgeRequest, LensResult, LensSpec } from "@djgrant/lenses-core";
import { coordinateRespawn } from "./broker-respawn.js";
import { brokerBuildStamp } from "./broker-stamp.js";

const BROKER_START_WAIT_MS = 3_000;
const BROKER_SHUTDOWN_WAIT_MS = 12_000;
/** Bounded so a stamp that never converges reports an error instead of looping. */
const BROKER_BIND_ATTEMPTS = 3;

export type LensLogger = (message: string) => void;
export type LensTransportResult = LensResult & { cached?: boolean };
export type BrokerLease = "held" | "released" | "disconnected";
export type BrokerControlAction = "release" | "acquire" | "status" | "shutdown";

export interface LensTransport {
  readonly connected: boolean;
  readonly info: string;
  readonly port: number;
  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs?: number,
    /** consent for a spec with `perform` steps; the broker denies without it */
    allowWrites?: boolean
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
  /** Release/acquire the broker's CDP lease; optional for custom transports. */
  control?(action: BrokerControlAction, timeoutMs?: number): Promise<LensTransportResult>;
}

type BrokerMessage =
  | {
      type: "status";
      connected: boolean;
      lease?: BrokerLease;
      ua?: string;
      /** Build stamp of the daemon's code; absent on brokers older than this. */
      stamp?: string;
    }
  | { type: "result"; id: string; result: LensTransportResult }
  | { type: "progress"; id: string; message: string };

export class BrowserBridge implements LensTransport {
  private browserConnected = false;
  private browserInfo = "";
  private browserLease: BrokerLease = "disconnected";
  private readonly pending = new Map<
    string,
    { resolve: (result: LensResult) => void; timer: NodeJS.Timeout; control?: boolean }
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
    log: LensLogger = () => {}
  ): Promise<BrowserBridge> {
    if (host !== "127.0.0.1") throw new Error("the lens broker only listens on 127.0.0.1");
    const expected = brokerBuildStamp();
    for (let attempt = 1; attempt <= BROKER_BIND_ATTEMPTS; attempt += 1) {
      const connection = (await connectBroker(port, 150)) ?? (await startBroker(port, log));
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

  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs = 90_000,
    allowWrites?: boolean
  ): Promise<LensTransportResult> {
    return this.request(
      (id) => ({
        type: "call",
        id,
        spec,
        params,
        timeoutMs,
        ...(allowWrites !== undefined ? { allowWrites } : {}),
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
    return this.request((id) => ({ type: "observe", id, target, waitMs, html }), timeoutMs);
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
    this.log(`sending ${message.type} ${id} through the lens broker`);
    return new Promise<LensTransportResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "error", message: `${message.type} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, control: message.type === "control" });
      this.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ kind: "error", message: `sending ${message.type}: ${error.message}` });
      });
    }).then((result) => {
      this.log(`${message.type} ${id} completed in ${Date.now() - startedAt}ms (${result.kind})`);
      return result;
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
      this.log(`browser ${message.id}: ${message.message}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(message.result);
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

async function startBroker(port: number, log: LensLogger): Promise<BrokerConnection> {
  const source = import.meta.url.endsWith(".ts") ? "broker-daemon.ts" : "broker-daemon.js";
  const entry = fileURLToPath(new URL(source, import.meta.url));
  const child = spawn(process.execPath, [entry, String(port)], {
    detached: true,
    stdio: "ignore",
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
    let settled = false;
    const onError = () => finish(null);
    const onOpen = () => {
      socket.send(JSON.stringify({ type: "client" }));
    };
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const status = JSON.parse(data.toString()) as BrokerMessage;
        if (status.type === "status") finish({ socket, status });
      } catch {
        // A service on this port is not a lens broker.
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
