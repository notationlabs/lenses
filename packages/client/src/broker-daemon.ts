#!/usr/bin/env node
import { WebSocket, WebSocketServer } from "ws";
import type {
  LensBridgeExtensionMessage,
  LensBridgeRequest,
  LensBridgeServerMessage,
} from "@djgrant/lens";

const KEEPALIVE_MS = 20_000;
const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("broker requires a port between 1 and 65535");
}

const server = new WebSocketServer({ port, host: "127.0.0.1" });
const clients = new Set<WebSocket>();
const routes = new Map<
  string,
  { client: WebSocket; clientId: string; cacheKey?: string; cacheTtlMs: number }
>();
const cache = new Map<string, { result: unknown; expiresAt: number }>();
let extension: WebSocket | undefined;
let extensionInfo = "";
let sequence = 0;

server.on("connection", (socket) => {
  socket.once("message", (data) => identify(socket, data.toString()));
});

function identify(socket: WebSocket, raw: string): void {
  const message = parse(raw);
  if (message?.type === "client") {
    clients.add(socket);
    sendStatus(socket);
    socket.on("message", (data) => onClientMessage(socket, data.toString()));
    socket.on("close", () => {
      clients.delete(socket);
      for (const [id, route] of routes) if (route.client === socket) routes.delete(id);
    });
    return;
  }
  if (message?.type === "hello") {
    setExtension(socket, message.ua);
  }
}

function setExtension(socket: WebSocket, ua?: string): void {
  extension?.close();
  extension = socket;
  extensionInfo = ua ?? "";
  broadcastStatus();
  socket.on("message", (data) => onExtensionMessage(socket, data.toString()));
  socket.on("close", () => {
    if (extension !== socket) return;
    extension = undefined;
    extensionInfo = "";
    for (const [id, route] of routes) {
      send(route.client, {
        type: "result",
        id: route.clientId,
        result: { kind: "error", message: "browser extension disconnected" },
      });
      routes.delete(id);
    }
    broadcastStatus();
  });
}

function onClientMessage(client: WebSocket, raw: string): void {
  const message = parse(raw) as LensBridgeRequest | undefined;
  if (!message || (message.type !== "call" && message.type !== "observe")) return;
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
  if (!extension || extension.readyState !== WebSocket.OPEN) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: "browser extension is not connected" },
    });
    return;
  }
  const brokerId = `broker_${++sequence}`;
  routes.set(brokerId, { client, clientId: message.id, cacheKey, cacheTtlMs });
  send(extension, { ...message, id: brokerId });
}

function onExtensionMessage(socket: WebSocket, raw: string): void {
  const message = parse(raw) as LensBridgeExtensionMessage | undefined;
  if (!message) return;
  if (message.type === "pong") return;
  if (message.type === "hello") {
    extensionInfo = message.ua ?? "";
    broadcastStatus();
    return;
  }
  const route = routes.get(message.id);
  if (!route) return;
  if (
    message.type === "result" &&
    message.result.kind === "value" &&
    !message.result.partial &&
    route.cacheKey &&
    route.cacheTtlMs > 0
  ) {
    cache.set(route.cacheKey, {
      result: message.result,
      expiresAt: Date.now() + route.cacheTtlMs,
    });
  }
  send(route.client, { ...message, id: route.clientId });
  if (message.type === "result") routes.delete(message.id);
}

const keepalive = setInterval(() => {
  if (extension?.readyState === WebSocket.OPEN) {
    send(extension, { type: "ping" } satisfies LensBridgeServerMessage);
  }
}, KEEPALIVE_MS);

server.on("close", () => clearInterval(keepalive));

function sendStatus(socket: WebSocket): void {
  send(socket, {
    type: "status",
    connected: extension?.readyState === WebSocket.OPEN,
    ua: extensionInfo || undefined,
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
