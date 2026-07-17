import type { LensResult, LensSpec } from "@djgrant/lens";
import { callLens, observePage } from "./operations.js";

const PORT_RANGE_START = 4319;
const PORT_RANGE_END = 4329;
const KNOWN_PORTS_KEY = "livePorts";
const DISCOVER_COOLDOWN_MS = 10_000;

const sockets = new Map<number, WebSocket>();
let lastDiscover = 0;
let portUpdate = Promise.resolve();

export function startBridgeConnections(): void {
  chrome.alarms.create("lens-keepalive", { periodInMinutes: 0.4 });
  chrome.alarms.onAlarm.addListener(() => void reconnectKnown());
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

async function rememberPort(port: number, live: boolean): Promise<void> {
  const update = portUpdate.then(async () => {
    const ports = new Set(await loadKnownPorts());
    if (live) ports.add(port);
    else ports.delete(port);
    await chrome.storage.session.set({ [KNOWN_PORTS_KEY]: [...ports] });
  });
  portUpdate = update;
  await update;
}

// Chrome reports refused WebSocket probes even when onerror is handled. Probe
// only around likely host activity, then reconnect ports known to be live.
function connectPort(port: number): void {
  const existing = sockets.get(port);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
  ) return;

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.set(port, socket);
  socket.onopen = () => {
    void rememberPort(port, true);
    socket.send(JSON.stringify({ type: "hello", ua: navigator.userAgent }));
  };
  socket.onmessage = (event) => void onBridgeMessage(socket, String(event.data));
  socket.onclose = () => {
    if (sockets.get(port) === socket) sockets.delete(port);
    void rememberPort(port, false);
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
  for (const port of await loadKnownPorts()) connectPort(port);
}

async function onBridgeMessage(socket: WebSocket, raw: string): Promise<void> {
  const message = JSON.parse(raw) as { type: string; id: string; [key: string]: unknown };
  let result: LensResult | Awaited<ReturnType<typeof observePage>>;

  try {
    if (message.type === "observe") {
      result = await observePage(message.target as string, (message.waitMs as number) ?? 4000);
    } else if (message.type === "call") {
      result = await callLens(
        message.spec as LensSpec,
        message.target as string,
        message.args as Record<string, unknown>
      );
    } else {
      throw new Error(`unknown bridge message type: ${message.type}`);
    }
  } catch (error) {
    result = { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  socket.send(JSON.stringify({ type: "result", id: message.id, result }));
}
