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
const INSTALLATION_ID_KEY = "brokerInstallationId";
const PAIRING_TOKEN_KEY = "brokerPairingToken";
const PAIRING_NOTIFICATION_PREFIX = "lens-broker-pair:";

const sockets = new Map<number, WebSocket>();
const pairingSockets = new Map<string, WebSocket>();
const acceptedPorts = new Set<number>();
let bridgeEnabled = false;
let bridgeInitialized = false;
let lastDiscover = 0;
let portUpdate = Promise.resolve();

export function getBridgeStatus(): { connectedPorts: number[] } {
  return { connectedPorts: [...acceptedPorts].sort((a, b) => a - b) };
}

/** Consent is durable, but sockets are not: disabling closes every live bridge. */
export function setBridgeEnabled(enabled: boolean): void {
  bridgeEnabled = enabled;
  if (!enabled) {
    acceptedPorts.clear();
    for (const socket of new Set([...sockets.values(), ...pairingSockets.values()])) {
      socket.close();
    }
    sockets.clear();
    pairingSockets.clear();
    return;
  }
  if (bridgeInitialized) {
    discover(true);
    return;
  }
  bridgeInitialized = true;
  void reapAbandonedTabLeases().then(async () => {
    await reconnectKnown();
    setTimeout(() => discover(true), 1500);
  });
}

export function startBridgeConnections(): void {
  chrome.notifications.onClicked.addListener((notificationId) => {
    const socket = pairingSockets.get(notificationId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const code = notificationId.slice(notificationId.lastIndexOf(":") + 1);
    socket.send(JSON.stringify({ type: "extension-pair-approve", code }));
  });
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
  if (!bridgeEnabled) return;
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
  let clientNonce = "";
  let pairingToken: string | undefined;
  let pairingNotification: string | undefined;
  const sendHello = () => socket.send(JSON.stringify({
    type: "extension-hello",
    protocolMajor: EXTENSION_PROTOCOL_MAJOR,
    extensionVersion: chrome.runtime.getManifest().version,
    capabilities: [...EXTENSION_CAPABILITIES],
    epoch,
    pageStamp: PAGE_FUNCTIONS_STAMP,
    ua: navigator.userAgent,
  }));
  socket.onopen = () => {
    connected = true;
    void loadPairingIdentity().then((identity) => {
      clientNonce = crypto.randomUUID();
      pairingToken = identity.token;
      socket.send(JSON.stringify({
        type: "extension-auth",
        installationId: identity.installationId,
        nonce: clientNonce,
      }));
    }).catch(() => socket.close());
  };
  socket.onmessage = (event) => {
    void (async () => {
      const raw = String(event.data);
      let authMessage: Record<string, unknown>;
      try {
        authMessage = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        rejected = true;
        socket.close();
        return;
      }
      if (authMessage.type === "auth-challenge") {
        const serverNonce = authMessage.nonce;
        if (
          !pairingToken ||
          typeof serverNonce !== "string" ||
          authMessage.proof !== await browserProof(pairingToken, "broker", clientNonce, serverNonce)
        ) {
          rejected = true;
          socket.close();
          return;
        }
        socket.send(JSON.stringify({
          type: "auth-response",
          proof: await browserProof(pairingToken, "extension", clientNonce, serverNonce),
        }));
        return;
      }
      if (authMessage.type === "auth-ok") {
        sendHello();
        return;
      }
      if (authMessage.type === "extension-pairing-required" && typeof authMessage.code === "string") {
        pairingNotification = `${PAIRING_NOTIFICATION_PREFIX}${port}:${authMessage.code}`;
        pairingSockets.set(pairingNotification, socket);
        await chrome.notifications.create(pairingNotification, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Pair Lens with the local broker",
          message: `Verify pairing code ${authMessage.code} with “lens broker status”, then click this notification to approve.`,
        });
        return;
      }
      if (authMessage.type === "extension-pair-complete" && typeof authMessage.token === "string") {
        pairingToken = authMessage.token;
        await chrome.storage.local.set({ [PAIRING_TOKEN_KEY]: pairingToken });
        if (pairingNotification) {
          pairingSockets.delete(pairingNotification);
          void chrome.notifications.clear(pairingNotification);
          pairingNotification = undefined;
        }
        sendHello();
        return;
      }
      const accepted = await onBridgeMessage(socket, backend, raw);
      if (accepted && !handshakeAccepted) {
        handshakeAccepted = true;
        acceptedPorts.add(port);
        void rememberPort(port);
      } else if (!accepted) {
        rejected = true;
        socket.close();
      }
    })();
  };
  socket.onclose = () => {
    if (pairingNotification) {
      pairingSockets.delete(pairingNotification);
      void chrome.notifications.clear(pairingNotification);
    }
    void backend.close();
    acceptedPorts.delete(port);
    if (sockets.get(port) === socket) sockets.delete(port);
    if (bridgeEnabled && !rejected && (connected || persistent)) {
      setTimeout(() => connectPort(port, true), 1000);
    }
  };
  socket.onerror = () => socket.close();
}

function discover(force = false): void {
  if (!bridgeEnabled) return;
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
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "extension-rpc-result",
          requestId: request.requestId,
          epoch,
          ok: true,
          result,
        })
      );
    }
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
  if (socket.readyState !== WebSocket.OPEN) return;
  const response: ExtensionRpcResponse = {
    type: "extension-rpc-result",
    requestId,
    epoch,
    ok: false,
    error: { code, message },
  };
  socket.send(JSON.stringify(response));
}

async function loadPairingIdentity(): Promise<{
  installationId: string;
  token?: string;
}> {
  const stored = await chrome.storage.local.get([
    INSTALLATION_ID_KEY,
    PAIRING_TOKEN_KEY,
  ]);
  let installationId = stored[INSTALLATION_ID_KEY];
  if (typeof installationId !== "string") {
    installationId = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: installationId });
  }
  const token = stored[PAIRING_TOKEN_KEY];
  return {
    installationId,
    ...(typeof token === "string" ? { token } : {}),
  };
}

async function browserProof(
  token: string,
  peer: "broker" | "extension",
  clientNonce: string,
  serverNonce: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`lenses-v1:${peer}:${clientNonce}:${serverNonce}`)
  ));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
