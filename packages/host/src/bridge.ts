import { WebSocketServer, WebSocket } from "ws";
import type { LensResult, LensSpec } from "@actors/lens";

/**
 * The bridge between the lens-host process and the browser extension.
 * The extension's service worker dials out to ws://127.0.0.1:<port>;
 * the host pushes lens calls in and gets results (or LLM-tier sampling
 * requests, which it forwards to the connected MCP client) back.
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

interface LlmRequestMessage {
  type: "llm";
  id: string;
  callId: string;
  prompt: string;
}

type ExtMessage = ResultMessage | LlmRequestMessage | { type: "hello"; ua?: string };

export type Sampler = (prompt: string) => Promise<string>;

export class Bridge {
  private wss: WebSocketServer;
  private ext: WebSocket | null = null;
  private extInfo = "";
  private pending = new Map<
    string,
    { resolve: (r: LensResult) => void; sampler: Sampler; timer: NodeJS.Timeout }
  >();
  private seq = 0;

  constructor(port: number, host = "127.0.0.1") {
    this.wss = new WebSocketServer({ port, host });
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

  get connected(): boolean {
    return this.ext !== null && this.ext.readyState === WebSocket.OPEN;
  }

  get info(): string {
    return this.connected ? `connected${this.extInfo ? ` (${this.extInfo})` : ""}` : "not connected";
  }

  /** Execute a lens in the browser. `sampler` serves the LLM tier for this call. */
  call(
    spec: LensSpec,
    target: string,
    args: Record<string, unknown>,
    sampler: Sampler,
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
      this.pending.set(id, { resolve, sampler, timer });
      this.ext!.send(JSON.stringify(msg));
    });
  }

  private async onMessage(ws: WebSocket, raw: string) {
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
      return;
    }
    if (msg.type === "llm") {
      const p = this.pending.get(msg.callId);
      let reply: { type: "llm_result"; id: string; ok: boolean; text?: string; error?: string };
      if (!p) {
        reply = { type: "llm_result", id: msg.id, ok: false, error: "no pending call for sampling" };
      } else {
        try {
          const text = await p.sampler(msg.prompt);
          reply = { type: "llm_result", id: msg.id, ok: true, text };
        } catch (err) {
          reply = {
            type: "llm_result",
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    }
  }

  close() {
    this.wss.close();
  }
}
