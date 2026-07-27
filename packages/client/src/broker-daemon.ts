#!/usr/bin/env node
/**
 * Persistent local broker: serialises lens calls from CLI/MCP/library clients,
 * preferring the Chrome extension and retaining CDP as the fallback backend.
 */
import { WebSocket, WebSocketServer } from "ws";
import type { LensBridgeRequest } from "@djgrant/lens";
import { createBrokerOrchestrator } from "./broker-orchestrator.js";
import { createCdpBackend } from "./cdp-host.js";
import { createExtensionBackend } from "./extension-backend.js";
import { brokerBuildStamp } from "./broker-stamp.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("broker requires a port between 1 and 65535");
}

// puppeteer's failed connection sockets can emit errors after their promise
// settles; a long-lived daemon must not die to those.
process.on("uncaughtException", (error) => console.error("broker uncaught:", error));
process.on("unhandledRejection", (error) => console.error("broker unhandled:", error));

const server = new WebSocketServer({ port, host: "127.0.0.1" });
const clients = new Set<WebSocket>();
const cdp = createCdpBackend();
const extension = createExtensionBackend();
const orchestrator = createBrokerOrchestrator([extension, cdp], {
  preferredWaitMs: 2_000,
});
const requestQueue = new SerialTaskQueue();
// Stamped once at startup: this daemon reports the code it is actually running,
// even after a rebuild replaces the files on disk.
const buildStamp = brokerBuildStamp();
const DRAIN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

// Idle auto-release is opt-in (0 = hold the lease forever): releasing frees
// Chrome's single debugging slot for other CDP tools, at the cost of a
// reconnect (no re-consent — Chrome scopes the Allow dialog to the session).
const idleReleaseMs = Number(process.env.LENS_BROKER_IDLE_RELEASE_MS ?? 0) || 0;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function beginWork(): void {
  inFlight += 1;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

function endWork(): void {
  inFlight -= 1;
  if (idleReleaseMs <= 0 || inFlight > 0) return;
  idleTimer = setTimeout(() => {
    if (inFlight === 0) void cdp.release();
  }, idleReleaseMs);
}

cdp.onStatusChange(broadcastStatus);
extension.onStatusChange(() => {
  broadcastStatus();
  if (extension.available()) {
    cdp.stop();
    void cdp.release();
  } else {
    cdp.start();
  }
});
const fallbackStart = setTimeout(() => {
  if (!extension.available()) cdp.start();
}, 2_000);

// A losing spawn race (another daemon already owns the port) must exit rather
// than linger as a server-less process kept alive by the handlers above.
server.on("error", (error) => {
  console.error("broker server error:", error);
  process.exit(1);
});
server.on("connection", (socket) => {
  socket.once("message", (data) => identify(socket, data.toString()));
});
server.on("close", () => {
  clearTimeout(fallbackStart);
  extension.stop();
  cdp.stop();
});

function identify(socket: WebSocket, raw: string): void {
  const message = parse(raw);
  if (message?.type === "client") {
    clients.add(socket);
    sendStatus(socket);
    socket.on("message", (data) => onClientMessage(socket, data.toString()));
    socket.on("close", () => clients.delete(socket));
    return;
  }
  if (message?.type === "extension-hello") {
    extension.attach(socket, message);
    return;
  }
  socket.close();
}

function onClientMessage(client: WebSocket, raw: string): void {
  const message = parse(raw) as LensBridgeRequest | undefined;
  if (!message) return;
  if (message.type === "control") {
    void handleControl(client, message).catch((error) =>
      console.error("broker control failed:", error)
    );
    return;
  }
  if (message.type !== "call" && message.type !== "observe") return;
  if (shuttingDown) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: "lens broker is shutting down; reconnect to respawn it" },
    });
    return;
  }
  beginWork();
  void requestQueue
    .run(() => handleClientMessage(client, message))
    .catch((error) => console.error("broker request failed:", error))
    .finally(endWork);
}

async function handleControl(
  client: WebSocket,
  message: Extract<LensBridgeRequest, { type: "control" }>
): Promise<void> {
  if (message.action === "shutdown") {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "value", value: { shuttingDown: true, stamp: buildStamp } },
    });
    void shutdown("client requested a restart");
    return;
  }
  try {
    if (message.action === "release") await cdp.release();
    if (message.action === "acquire") {
      await cdp.acquire((text) => send(client, { type: "progress", id: message.id, message: text }));
    }
  } catch (error) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  send(client, {
    type: "result",
    id: message.id,
    result: {
      kind: "value",
      value: { connected: cdp.available(), lease: cdp.lease() },
    },
  });
}

async function handleClientMessage(client: WebSocket, message: LensBridgeRequest): Promise<void> {
  if (client.readyState !== WebSocket.OPEN) return;
  if (message.type !== "call" && message.type !== "observe") return;
  await orchestrator.handle(message, (frame) => send(client, frame));
}

/**
 * Retire this daemon: refuse new work, let in-flight calls finish (bounded, so a
 * wedged call cannot pin a stale broker forever), release the CDP lease, then
 * exit. Clients see the socket close and fail their pending calls cleanly.
 */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`broker shutting down: ${reason}`);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  extension.stop();
  await cdp.release().catch(() => {});
  cdp.stop();
  clearTimeout(fallbackStart);
  for (const client of clients) client.close();
  server.close();
  process.exit(0);
}

function sendStatus(socket: WebSocket): void {
  const preferred = extension.available() ? extension : cdp;
  send(socket, {
    type: "status",
    stamp: buildStamp,
    connected: preferred.available(),
    lease: cdp.lease(),
    ua: preferred.available() ? preferred.info().detail : undefined,
  });
}

function broadcastStatus(): void {
  for (const client of clients) sendStatus(client);
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function parse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
