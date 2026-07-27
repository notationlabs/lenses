import { WebSocket } from "ws";
import {
  EXTENSION_PROTOCOL_MAJOR,
  decodeExtensionBrokerMessage,
  decodeExtensionRpcResponse,
  negotiateExtensionHello,
  type ExtensionHello,
  type ExtensionRpcOperation,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
  type ExtensionRpcResult,
} from "@djgrant/lens";
import { pageFunctionsStamp } from "@djgrant/lens/page-stamp";
import type {
  BindRequest,
  BrowserBackend,
  BrowserSession,
  FinishDisposition,
  SnapshotOptions,
} from "./browser-backend.js";

const RPC_GRACE_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const KEEPALIVE_MS = 20_000;

export interface ExtensionBackend extends BrowserBackend {
  attach(socket: WebSocket, value: unknown): boolean;
  stop(): void;
}

interface PendingRpc {
  resolve(result: ExtensionRpcResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createExtensionBackend(
  log: (message: string) => void = () => {}
): ExtensionBackend {
  let socket: WebSocket | undefined;
  let hello: ExtensionHello | undefined;
  let requestSequence = 0;
  const pending = new Map<string, PendingRpc>();
  const statusListeners = new Set<() => void>();
  const keepalive = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "extension-ping",
        nonce: `ping_${Date.now()}`,
      })
    );
  }, KEEPALIVE_MS);

  const notifyStatusChange = () => {
    for (const listener of statusListeners) listener();
  };

  function rejectPending(reason: string): void {
    for (const [requestId, rpc] of pending) {
      clearTimeout(rpc.timer);
      rpc.reject(new Error(reason));
      pending.delete(requestId);
    }
  }

  function disconnect(current: WebSocket, reason: string): void {
    if (socket !== current) return;
    socket = undefined;
    hello = undefined;
    rejectPending(reason);
    notifyStatusChange();
  }

  async function rpc(
    operation: ExtensionRpcOperation,
    deadline = Date.now() + DEFAULT_RPC_TIMEOUT_MS
  ): Promise<ExtensionRpcResult> {
    const current = socket;
    const epoch = hello?.epoch;
    if (!current || current.readyState !== WebSocket.OPEN || !epoch) {
      throw new Error("browser extension is not connected");
    }
    const requestId = `extension_${++requestSequence}`;
    const request: ExtensionRpcRequest = {
      type: "extension-rpc",
      requestId,
      epoch,
      deadline,
      operation,
    };
    return new Promise<ExtensionRpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`extension RPC ${requestId} deadline exceeded`));
      }, Math.max(0, deadline - Date.now()));
      pending.set(requestId, { resolve, reject, timer });
      current.send(JSON.stringify(request), (error) => {
        if (!error) return;
        const active = pending.get(requestId);
        if (!active) return;
        clearTimeout(active.timer);
        pending.delete(requestId);
        active.reject(new Error(`sending extension RPC: ${error.message}`));
      });
    });
  }

  function onMessage(current: WebSocket, raw: string): void {
    let message;
    try {
      message = decodeExtensionBrokerMessage(JSON.parse(raw));
    } catch (error) {
      log(
        `invalid extension message: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      current.close();
      return;
    }
    if (message.type === "extension-pong") {
      if (message.epoch !== hello?.epoch) current.close();
      return;
    }
    if (message.type === "extension-hello") {
      current.close();
      return;
    }

    let response: ExtensionRpcResponse;
    try {
      response = decodeExtensionRpcResponse(message, hello?.epoch ?? "");
    } catch (error) {
      log(
        `invalid extension RPC response: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      current.close();
      return;
    }
    const active = pending.get(response.requestId);
    if (!active) return;
    clearTimeout(active.timer);
    pending.delete(response.requestId);
    if (response.ok) active.resolve(response.result);
    else active.reject(new Error(response.error.message));
  }

  const backend: ExtensionBackend = {
    name: "extension",
    available: () =>
      socket?.readyState === WebSocket.OPEN && hello !== undefined,
    info: () => ({
      name: "extension",
      detail: hello
        ? `${hello.extensionVersion}${hello.ua ? ` ${hello.ua}` : ""}${pageStampNote(hello)}`
        : undefined,
    }),
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    attach(current, value) {
      let accepted: ExtensionHello;
      try {
        accepted = negotiateExtensionHello(value);
      } catch (error) {
        current.send(
          JSON.stringify({
            type: "extension-hello-result",
            accepted: false,
            protocolMajor: EXTENSION_PROTOCOL_MAJOR,
            reason: error instanceof Error ? error.message : String(error),
          })
        );
        current.close();
        return false;
      }

      const previous = socket;
      if (previous) rejectPending("browser extension connection replaced");
      socket = current;
      hello = accepted;
      previous?.close();
      current.send(
        JSON.stringify({
          type: "extension-hello-result",
          accepted: true,
          protocolMajor: EXTENSION_PROTOCOL_MAJOR,
          epoch: accepted.epoch,
        })
      );
      current.on("message", (data) =>
        onMessage(current, data.toString())
      );
      current.on("close", () =>
        disconnect(current, "browser extension disconnected")
      );
      current.on("error", () =>
        disconnect(current, "browser extension disconnected")
      );
      log(`extension connected: ${backend.info().detail ?? "unknown"}`);
      notifyStatusChange();
      return true;
    },
    stop() {
      clearInterval(keepalive);
      const current = socket;
      if (!current) return;
      current.close();
      disconnect(current, "browser extension backend stopped");
    },
    async bind(request: BindRequest): Promise<BrowserSession> {
      const result = await rpc(
        { name: "bind", ...request },
        Date.now() + request.loadTimeoutMs + RPC_GRACE_MS
      );
      if (result.name !== "bind") {
        throw new Error(`extension returned ${result.name} for bind`);
      }
      return new ExtensionSession(result.session, rpc);
    },
    async finish(
      session: BrowserSession,
      disposition: FinishDisposition
    ): Promise<void> {
      const result = await rpc(
        { name: "finish", sessionId: session.id, disposition },
        Date.now() + RPC_GRACE_MS
      );
      if (result.name !== "finish") {
        throw new Error(`extension returned ${result.name} for finish`);
      }
    },
  };
  return backend;
}

class ExtensionSession implements BrowserSession {
  readonly id: string;
  readonly created: boolean;
  readonly navigated: boolean;

  constructor(
    session: { id: string; created: boolean; navigated: boolean },
    private readonly rpc: (
      operation: ExtensionRpcOperation,
      deadline?: number
    ) => Promise<ExtensionRpcResult>
  ) {
    this.id = session.id;
    this.created = session.created;
    this.navigated = session.navigated;
  }

  async reload(loadTimeoutMs: number): Promise<void> {
    const result = await this.rpc(
      { name: "reload", sessionId: this.id, loadTimeoutMs },
      Date.now() + loadTimeoutMs + RPC_GRACE_MS
    );
    assertResult(result, "reload");
  }

  async readIntercepts(cursor: number, pollDeadline: number) {
    const result = await this.rpc(
      {
        name: "read-intercepts",
        sessionId: this.id,
        cursor,
        pollDeadline,
      },
      Math.max(Date.now(), pollDeadline) + RPC_GRACE_MS
    );
    assertResult(result, "read-intercepts");
    return {
      captures: result.captures,
      nextCursor: result.nextCursor,
      truncated: result.truncated,
    };
  }

  async domExtract(resolver: Parameters<BrowserSession["domExtract"]>[0]) {
    const result = await this.rpc({
      name: "dom-extract",
      sessionId: this.id,
      resolver,
    });
    assertResult(result, "dom-extract");
    return result.extraction;
  }

  async snapshot(options: SnapshotOptions) {
    const result = await this.rpc({
      name: "snapshot",
      sessionId: this.id,
      ...options,
    });
    assertResult(result, "snapshot");
    return result.snapshot;
  }
}

function assertResult<Name extends ExtensionRpcResult["name"]>(
  result: ExtensionRpcResult,
  name: Name
): asserts result is Extract<ExtensionRpcResult, { name: Name }> {
  if (result.name !== name) {
    throw new Error(`extension returned ${result.name} for ${name}`);
  }
}

/**
 * Compare the page functions the extension bundled against the ones the broker
 * holds. A mismatch means Chrome is still running the copy it loaded — the
 * failure that had a shipped extraction fix verified as absent against correct
 * code, because from outside a stale extension and an unshipped fix look alike.
 */
export function pageStampNote(hello: ExtensionHello): string {
  const expected = pageFunctionsStamp();
  if (!hello.pageStamp) return " [page functions unknown: extension predates the stamp]";
  if (hello.pageStamp === expected) return ` [page functions ${expected}]`;
  return (
    ` [STALE page functions ${hello.pageStamp}, broker has ${expected}` +
    " — rebuild and reload the extension at chrome://extensions]"
  );
}
