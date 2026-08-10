import {
  EXTENSION_CAPABILITIES,
  EXTENSION_PROTOCOL_MAJOR,
  decodeBrokerExtensionMessage,
  decodeExtensionRpcRequest,
  type ExtensionRpcErrorCode,
  type ExtensionRpcResponse,
} from "@djgrant/lenses-core";
import { formatError } from "../errors.js";
import {
  createExtensionSessionBackend,
  reapAbandonedTabLeases,
} from "./session-backend.js";

const PORT_RANGE_START = 4319;
const PORT_RANGE_END = 4329;
const KNOWN_PORTS_KEY = "knownPorts";
const RECONNECT_ALARM = "lens-bridge-reconnect";
const DISCOVER_COOLDOWN_MS = 10_000;
const epoch = crypto.randomUUID();

const sockets = new Map<number, WebSocket>();
let lastDiscover = 0;
let portUpdate = Promise.resolve();

export function startBridgeConnections(): void {
  // Re-creating the alarm on every worker start would push its next firing out
  // by another period, so a worker that keeps waking never gets its reconnect.
  void chrome.alarms.get(RECONNECT_ALARM).then((existing) => {
    if (!existing) {
      chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) discover(true);
  });
  // A dormant worker only revives on a registered event; browser start and
  // install are the two that follow a broker outage.
  chrome.runtime.onStartup.addListener(() => discover(true));
  chrome.runtime.onInstalled.addListener(() => discover(true));
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" && tab.url?.startsWith("http")) {
      discover();
    }
  });

  void reapAbandonedTabLeases().then(async () => {
    await reconnectKnown();
    setTimeout(() => discover(true), 1500);
  });
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
    await chrome.storage.session.set({
      [KNOWN_PORTS_KEY]: [...ports],
    });
  });
  portUpdate = update;
  await update;
}

function connectPort(port: number, persistent = false): void {
  const existing = sockets.get(port);
  if (
    existing &&
    (existing.readyState === WebSocket.OPEN ||
      existing.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const backend = createExtensionSessionBackend();
  let connected = false;
  let rejected = false;
  let handshakeAccepted = false;
  sockets.set(port, socket);
  socket.onopen = () => {
    connected = true;
    socket.send(
      JSON.stringify({
        type: "extension-hello",
        protocolMajor: EXTENSION_PROTOCOL_MAJOR,
        extensionVersion: chrome.runtime.getManifest().version,
        capabilities: [...EXTENSION_CAPABILITIES],
        epoch,
        // Baked in at build time, so it names the bundle Chrome actually
        // loaded rather than whatever is on disk now.
        pageStamp: PAGE_FUNCTIONS_STAMP,
        ua: navigator.userAgent,
      })
    );
  };
  socket.onmessage = (event) => {
    void onBridgeMessage(socket, backend, String(event.data)).then(
      (accepted) => {
        if (accepted && !handshakeAccepted) {
          handshakeAccepted = true;
          void rememberPort(port);
        } else if (!accepted) {
          rejected = true;
          socket.close();
        }
      }
    );
  };
  socket.onclose = () => {
    void backend.close();
    if (sockets.get(port) === socket) sockets.delete(port);
    if (!rejected && (connected || persistent)) {
      setTimeout(() => connectPort(port, true), 1000);
    }
  };
  socket.onerror = () => socket.close();
}

function discover(force = false): void {
  const now = Date.now();
  if (!force && now - lastDiscover < DISCOVER_COOLDOWN_MS) return;
  lastDiscover = now;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    connectPort(port);
  }
}

async function reconnectKnown(): Promise<void> {
  for (const port of await loadKnownPorts()) {
    connectPort(port, true);
  }
}

async function onBridgeMessage(
  socket: WebSocket,
  backend: ReturnType<typeof createExtensionSessionBackend>,
  raw: string
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }

  let message;
  try {
    message = decodeBrokerExtensionMessage(value);
  } catch {
    const candidate = value as {
      type?: unknown;
      requestId?: unknown;
    };
    if (
      candidate.type === "extension-rpc" &&
      typeof candidate.requestId === "string"
    ) {
      sendError(
        socket,
        candidate.requestId,
        "invalid-request",
        "invalid extension RPC request"
      );
      return true;
    }
    return false;
  }
  if (message.type === "extension-hello-result") {
    return (
      message.accepted &&
      message.protocolMajor === EXTENSION_PROTOCOL_MAJOR &&
      message.epoch === epoch
    );
  }
  if (message.type === "extension-ping") {
    socket.send(
      JSON.stringify({
        type: "extension-pong",
        nonce: message.nonce,
        epoch,
      })
    );
    return true;
  }

  let request;
  try {
    request = decodeExtensionRpcRequest(message, epoch);
  } catch (error) {
    const candidate = value as {
      requestId?: unknown;
    };
    if (typeof candidate.requestId !== "string") return false;
    sendError(
      socket,
      candidate.requestId,
      errorCode(error),
      formatError(error)
    );
    return true;
  }

  try {
    const result = await backend.handle(request);
    socket.send(
      JSON.stringify({
        type: "extension-rpc-result",
        requestId: request.requestId,
        epoch,
        ok: true,
        result,
      })
    );
  } catch (error) {
    sendError(
      socket,
      request.requestId,
      errorCode(error),
      formatError(error)
    );
  }
  return true;
}

function sendError(
  socket: WebSocket,
  requestId: string,
  code: ExtensionRpcErrorCode,
  message: string
): void {
  const response: ExtensionRpcResponse = {
    type: "extension-rpc-result",
    requestId,
    epoch,
    ok: false,
    error: { code, message },
  };
  socket.send(JSON.stringify(response));
}

function errorCode(error: unknown): ExtensionRpcErrorCode {
  const message = formatError(error);
  if (message.startsWith("stale extension epoch")) return "stale-epoch";
  if (message.includes("deadline exceeded")) return "deadline-exceeded";
  if (message.startsWith("unknown browser session")) {
    return "unknown-session";
  }
  return "backend-error";
}
