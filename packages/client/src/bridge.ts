import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { LensBridgeRequest, LensResult, LensSpec } from "@djgrant/lens";

const BROKER_START_WAIT_MS = 3_000;

export type LensLogger = (message: string) => void;
export type LensTransportResult = LensResult & { cached?: boolean };

export interface LensTransport {
  readonly connected: boolean;
  readonly info: string;
  readonly port: number;
  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<LensTransportResult>;
  observe(target: string, waitMs?: number, timeoutMs?: number): Promise<LensTransportResult>;
  waitForConnection(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

type BrokerMessage =
  | { type: "status"; connected: boolean; ua?: string }
  | { type: "result"; id: string; result: LensTransportResult }
  | { type: "progress"; id: string; message: string };

export class BrowserBridge implements LensTransport {
  private extensionConnected = false;
  private extensionInfo = "";
  private readonly pending = new Map<
    string,
    { resolve: (result: LensResult) => void; timer: NodeJS.Timeout }
  >();
  private readonly connectionWaiters = new Set<() => void>();
  private sequence = 0;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    readonly port: number,
    private readonly log: LensLogger,
    status: Extract<BrokerMessage, { type: "status" }>
  ) {
    this.extensionConnected = status.connected;
    this.extensionInfo = status.ua ?? "";
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => {
      this.extensionConnected = false;
      this.resolvePending({ kind: "error", message: "lens broker disconnected" });
    });
  }

  static async bind(
    port: number,
    host = "127.0.0.1",
    log: LensLogger = () => {}
  ): Promise<BrowserBridge> {
    if (host !== "127.0.0.1") throw new Error("the lens broker only listens on 127.0.0.1");
    const connection = (await connectBroker(port, 150)) ?? (await startBroker(port, log));
    log(`connected to lens broker on ws://${host}:${port}`);
    if (connection.status.connected) {
      log(`browser extension connected through broker port ${port}`);
    }
    return new BrowserBridge(connection.socket, port, log, connection.status);
  }

  get connected(): boolean {
    return this.extensionConnected;
  }

  get info(): string {
    return this.connected
      ? `connected${this.extensionInfo ? ` (${this.extensionInfo})` : ""}`
      : "not connected";
  }

  call(
    spec: LensSpec,
    params: Record<string, unknown>,
    timeoutMs = 90_000
  ): Promise<LensTransportResult> {
    return this.request(
      (id) => ({ type: "call", id, spec, params, timeoutMs }),
      timeoutMs
    );
  }

  observe(target: string, waitMs = 4_000, timeoutMs = 60_000): Promise<LensTransportResult> {
    return this.request((id) => ({ type: "observe", id, target, waitMs }), timeoutMs);
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
    if (!this.connected) {
      this.log("browser extension is not connected");
      return { kind: "error", message: "browser extension is not connected" };
    }
    const id = `call_${++this.sequence}`;
    const message = make(id);
    const startedAt = Date.now();
    this.log(`sending ${message.type} ${id} through the lens broker`);
    return new Promise<LensTransportResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "error", message: `${message.type} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
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
      const wasConnected = this.extensionConnected;
      this.extensionConnected = message.connected;
      this.extensionInfo = message.ua ?? "";
      if (message.connected && !wasConnected) {
        this.log(`browser extension connected through broker port ${this.port}`);
        for (const resolve of this.connectionWaiters) resolve();
        this.connectionWaiters.clear();
      } else if (!message.connected && wasConnected) {
        this.log("browser extension disconnected from lens broker");
        this.resolvePending({ kind: "error", message: "browser extension disconnected" });
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

  private resolvePending(result: LensResult): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pending.clear();
  }
}

interface BrokerConnection {
  socket: WebSocket;
  status: Extract<BrokerMessage, { type: "status" }>;
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
