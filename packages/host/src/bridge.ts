import { WebSocketServer, WebSocket } from "ws";
import type { LensResult, LensSpec } from "@djgrant/lens";

/**
 * The bridge between the lens-host process and the browser extension.
 * The extension's service worker dials out to ws://127.0.0.1:<port>;
 * the host pushes lens calls in and gets results back.
 */

interface CallMessage {
  type: "call";
  id: string;
  spec: LensSpec;
  target: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

interface ResultMessage {
  type: "result";
  id: string;
  result: LensResult;
}

interface ObserveMessage {
  type: "observe";
  id: string;
  target: string;
  waitMs: number;
}

type ExtMessage = ResultMessage | { type: "hello"; ua?: string };

export class Bridge {
  private wss: WebSocketServer;
  private ext: WebSocket | null = null;
  private extInfo = "";
  private pending = new Map<string, { resolve: (r: LensResult) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  readonly port: number;

  private constructor(wss: WebSocketServer, port: number) {
    this.wss = wss;
    this.port = port;
    this.wss.on("connection", (ws) => {
      // Latest extension connection wins; an old SW instance may linger briefly.
      this.ext?.close();
      this.ext = ws;
      ws.on("message", (data) => this.onMessage(ws, data.toString()));
      ws.on("close", () => {
        if (this.ext === ws) this.ext = null;
      });
    });
  }

  /** Bind a single explicit port, rejecting on failure (e.g. EADDRINUSE). */
  static bind(port: number, host = "127.0.0.1"): Promise<Bridge> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });
      const onError = (err: Error) => reject(err);
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        resolve(new Bridge(wss, port));
      });
    });
  }

  /** Bind the first free port in [start, end]; reject if all are taken. */
  static async bindRange(start: number, end: number, host = "127.0.0.1"): Promise<Bridge> {
    for (let port = start; port <= end; port++) {
      try {
        return await Bridge.bind(port, host);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
        throw err;
      }
    }
    throw new Error(`no free port in range ${start}-${end} for the extension bridge`);
  }

  get connected(): boolean {
    return this.ext !== null && this.ext.readyState === WebSocket.OPEN;
  }

  get info(): string {
    return this.connected ? `connected${this.extInfo ? ` (${this.extInfo})` : ""}` : "not connected";
  }

  /** Execute a lens in the browser. */
  call(
    spec: LensSpec,
    target: string,
    args: Record<string, unknown>,
    timeoutMs = 90_000
  ): Promise<LensResult> {
    if (!this.connected) {
      return Promise.resolve({
        kind: "error",
        message:
          "browser extension is not connected — is Chrome running with the Lens Host extension installed?",
      });
    }
    const id = `call_${++this.seq}`;
    const msg: CallMessage = { type: "call", id, spec, target, args, timeoutMs };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "error", message: `lens call timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.ext!.send(JSON.stringify(msg));
    });
  }

  /** Observe a page: load it and report the JSON requests it makes plus a snapshot. */
  observe(target: string, waitMs = 4000, timeoutMs = 60_000): Promise<LensResult> {
    if (!this.connected) {
      return Promise.resolve({
        kind: "error",
        message:
          "browser extension is not connected — is Chrome running with the Lens Host extension installed?",
      });
    }
    const id = `call_${++this.seq}`;
    const msg: ObserveMessage = { type: "observe", id, target, waitMs };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "error", message: `observe timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.ext!.send(JSON.stringify(msg));
    });
  }

  private onMessage(_ws: WebSocket, raw: string) {
    let msg: ExtMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.extInfo = msg.ua ?? "";
      return;
    }
    if (msg.type === "result") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg.result);
      }
    }
  }

  close() {
    this.wss.close();
  }
}
