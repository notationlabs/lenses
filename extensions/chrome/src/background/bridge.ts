import type { LensBridgeServerMessage, LensResult } from "@djgrant/lens";
import { callLens, observePage } from "./operations.js";
import { formatError } from "../errors.js";

const PORT_RANGE_START = 4319;
const PORT_RANGE_END = 4329;
const KNOWN_PORTS_KEY = "knownPorts";
const DISCOVER_COOLDOWN_MS = 10_000;

const sockets = new Map<number, WebSocket>();
let lastDiscover = 0;
let portUpdate = Promise.resolve();

export function startBridgeConnections(): void {
  chrome.alarms.create("lens-bridge-reconnect", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "lens-bridge-reconnect") discover(true);
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" && tab.url?.startsWith("http")) discover();
  });

  void reconnectKnown();
  setTimeout(() => discover(true), 1500);
}

async function loadKnownPorts(): Promise<number[]> {
  const stored = await chrome.storage.session.get(KNOWN_PORTS_KEY);
  const ports = stored[KNOWN_PORTS_KEY];
  return Array.isArray(ports) ? (ports as number[]) : [];
}

async function rememberPort(port: number): Promise<void> {
  const update = portUpdate.then(async () => {
    const ports = new Set(await loadKnownPorts());
    ports.add(port);
    await chrome.storage.session.set({ [KNOWN_PORTS_KEY]: [...ports] });
  });
  portUpdate = update;
  await update;
}

// Discovery probes once. A port that has connected before keeps retrying so
// short-lived CLI clients do not wait for the next 30-second discovery alarm.
function connectPort(port: number, persistent = false): void {
  const existing = sockets.get(port);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) return;

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  let connected = false;
  sockets.set(port, socket);
  socket.onopen = () => {
    connected = true;
    void rememberPort(port);
    socket.send(JSON.stringify({ type: "hello", ua: navigator.userAgent }));
  };
  socket.onmessage = (event) => void onBridgeMessage(socket, String(event.data));
  socket.onclose = () => {
    if (sockets.get(port) === socket) sockets.delete(port);
    if (connected || persistent) setTimeout(() => connectPort(port, true), 1000);
  };
  socket.onerror = () => socket.close();
}

function discover(force = false): void {
  const now = Date.now();
  if (!force && now - lastDiscover < DISCOVER_COOLDOWN_MS) return;
  lastDiscover = now;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) connectPort(port);
}

async function reconnectKnown(): Promise<void> {
  for (const port of await loadKnownPorts()) connectPort(port, true);
}

async function onBridgeMessage(socket: WebSocket, raw: string): Promise<void> {
  const message = JSON.parse(raw) as LensBridgeServerMessage;
  if (message.type === "ping") {
    socket.send(JSON.stringify({ type: "pong" }));
    return;
  }
  let result: LensResult | Awaited<ReturnType<typeof observePage>>;
  const progress = (text: string) => {
    socket.send(JSON.stringify({ type: "progress", id: message.id, message: text }));
  };

  try {
    if (message.type === "observe") {
      result = await observePage(message.target, message.waitMs, message.html, progress);
    } else {
      result = await callLens(message.spec, message.params, progress);
    }
  } catch (error) {
    result = { kind: "error", message: formatError(error) };
  }

  socket.send(JSON.stringify({ type: "result", id: message.id, result }));
}
