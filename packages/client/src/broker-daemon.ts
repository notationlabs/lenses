#!/usr/bin/env node
/**
 * Persistent local broker: serialises lens calls from CLI/MCP/library clients
 * onto one long-lived CDP connection to the user's running Chrome, so consent
 * (the chrome://inspect/#remote-debugging Allow dialog) is granted once per
 * broker lifetime rather than once per client process.
 */
import { WebSocket, WebSocketServer } from "ws";
import type { LensBridgeRequest } from "@djgrant/lens";
import { createCdpHost } from "./cdp-host.js";
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
const cache = new Map<string, { result: unknown; expiresAt: number }>();
const cdp = createCdpHost();
const requestQueue = new SerialTaskQueue();

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
cdp.start();

server.on("connection", (socket) => {
  socket.once("message", (data) => identify(socket, data.toString()));
});
server.on("close", () => cdp.stop());

function identify(socket: WebSocket, raw: string): void {
  const message = parse(raw);
  if (message?.type !== "client") return;
  clients.add(socket);
  sendStatus(socket);
  socket.on("message", (data) => onClientMessage(socket, data.toString()));
  socket.on("close", () => clients.delete(socket));
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
  const cacheTtlMs = message.type === "call" ? (message.spec.effects.cache ?? 0) * 1000 : 0;
  const cacheKey =
    message.type === "call"
      ? `${JSON.stringify(message.spec)}|${JSON.stringify(message.params)}`
      : undefined;
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    send(client, {
      type: "result",
      id: message.id,
      result: { ...(cached.result as object), cached: true },
    });
    return;
  }
  if (cached && cached.expiresAt <= Date.now()) cache.delete(cacheKey!);
  await cdp.handle(message, (frame) => {
    if (
      frame.type === "result" &&
      frame.result.kind === "value" &&
      !frame.result.partial &&
      cacheKey &&
      cacheTtlMs > 0
    ) {
      cache.set(cacheKey, { result: frame.result, expiresAt: Date.now() + cacheTtlMs });
    }
    send(client, frame);
  });
}

function sendStatus(socket: WebSocket): void {
  send(socket, {
    type: "status",
    connected: cdp.available(),
    lease: cdp.lease(),
    ua: cdp.available() ? cdp.info() : undefined,
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
