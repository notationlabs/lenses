import { WebSocket, WebSocketServer } from "ws";
import type {
  LensBridgeExtensionMessage,
  LensBridgeRequest,
  LensResult,
  LensSpec,
} from "@djgrant/lens";

const INITIAL_CONNECT_WAIT_MS = 35_000;
const RECONNECT_WAIT_MS = 35_000;
const KEEPALIVE_MS = 20_000;

export type LensLogger = (message: string) => void;

export interface LensTransport {
  readonly connected: boolean;
  readonly info: string;
  readonly port: number;
  call(
    spec: LensSpec,
    target: string,
    args: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<LensResult>;
  observe(target: string, waitMs?: number, timeoutMs?: number): Promise<LensResult>;
  waitForConnection(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export class BrowserBridge implements LensTransport {
  private extension: WebSocket | null = null;
  private extensionInfo = "";
  private readonly pending = new Map<
    string,
    { resolve: (result: LensResult) => void; timer: NodeJS.Timeout }
  >();
  private readonly connectionWaiters = new Set<() => void>();
  private hasConnected = false;
  private sequence = 0;
  private readonly keepalive: NodeJS.Timeout;
  private closed = false;

  private constructor(
    private readonly server: WebSocketServer,
    readonly port: number,
    private readonly log: LensLogger
  ) {
    server.on("connection", (socket) => {
      if (this.extension) {
        this.resolvePending({ kind: "error", message: "browser extension connection replaced" });
      }
      this.extension?.close();
      this.extension = socket;
      this.extensionInfo = "";
      this.hasConnected = true;
      this.log(`browser extension connected on port ${this.port}`);
      for (const resolve of this.connectionWaiters) resolve();
      this.connectionWaiters.clear();
      socket.on("message", (data) => this.onMessage(socket, data.toString()));
      socket.on("close", () => {
        if (this.extension === socket) {
          this.extension = null;
          this.log("browser extension disconnected");
          this.resolvePending({ kind: "error", message: "browser extension disconnected" });
        }
      });
    });
    this.keepalive = setInterval(() => {
      if (!this.connected) return;
      try {
        this.extension!.send(JSON.stringify({ type: "ping" }));
      } catch {
        // The close event resolves pending calls.
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  static bind(
    port: number,
    host = "127.0.0.1",
    log: LensLogger = () => {}
  ): Promise<BrowserBridge> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port, host });
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        log(`extension bridge listening on ws://${host}:${boundPort}`);
        resolve(new BrowserBridge(server, boundPort, log));
      });
    });
  }

  static async bindRange(
    start: number,
    end: number,
    host = "127.0.0.1",
    log: LensLogger = () => {}
  ): Promise<BrowserBridge> {
    for (let port = start; port <= end; port++) {
      try {
        return await BrowserBridge.bind(port, host, log);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          log(`extension bridge port ${port} is already in use`);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`no free port in range ${start}-${end} for the extension bridge`);
  }

  get connected(): boolean {
    return this.extension !== null && this.extension.readyState === WebSocket.OPEN;
  }

  get info(): string {
    return this.connected
      ? `connected${this.extensionInfo ? ` (${this.extensionInfo})` : ""}`
      : "not connected";
  }

  call(
    spec: LensSpec,
    target: string,
    args: Record<string, unknown>,
    timeoutMs = 90_000
  ): Promise<LensResult> {
    return this.request(
      (id) => ({ type: "call", id, spec, target, args, timeoutMs }),
      timeoutMs
    );
  }

  observe(target: string, waitMs = 4_000, timeoutMs = 60_000): Promise<LensResult> {
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
    clearInterval(this.keepalive);
    this.resolvePending({ kind: "error", message: "extension bridge closed" });
    this.extension?.terminate();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async request(
    make: (id: string) => LensBridgeRequest,
    timeoutMs: number
  ): Promise<LensResult> {
    const connectionWaitMs = this.hasConnected ? RECONNECT_WAIT_MS : INITIAL_CONNECT_WAIT_MS;
    if (!this.connected) {
      this.log(`waiting up to ${connectionWaitMs}ms for the browser extension`);
    }
    if (!this.connected && !(await this.waitForConnection(connectionWaitMs))) {
      this.log(`browser extension connection timed out after ${connectionWaitMs}ms`);
      return {
        kind: "error",
        message: `browser extension did not connect within ${connectionWaitMs}ms`,
      };
    }
    const id = `call_${++this.sequence}`;
    const message = make(id);
    const startedAt = Date.now();
    this.log(`sending ${message.type} ${id} to the browser extension`);
    return new Promise<LensResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "error", message: `${message.type} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.extension!.send(JSON.stringify(message), (error) => {
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

  private onMessage(_socket: WebSocket, raw: string): void {
    let message: LensBridgeExtensionMessage;
    try {
      message = JSON.parse(raw) as LensBridgeExtensionMessage;
    } catch {
      return;
    }
    if (message.type === "hello") {
      this.extensionInfo = message.ua ?? "";
      return;
    }
    if (message.type === "pong") return;
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
