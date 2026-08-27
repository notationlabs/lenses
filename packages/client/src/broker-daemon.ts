#!/usr/bin/env node
/**
 * Persistent local broker: serialises lens calls from CLI/MCP/library clients.
 * One CDP-backed browser implementation, two transports: Playwright Extension
 * relay first, direct Chrome remote debugging as fallback.
 */
import { WebSocket, WebSocketServer } from "ws";
import type { LensBridgeRequest } from "@djgrant/lenses-core";
import { createBrokerOrchestrator, specNeedsBrowser } from "./broker-orchestrator.js";
import { createCdpBackend } from "./cdp-host.js";
import { createPlaywrightExtensionBackend } from "./playwright-extension-backend.js";
import { playwrightExtensionInstalled } from "./chrome-paths.js";
import {
  autoLaunchEnabled,
  browserRunning,
  launchBrowser,
} from "./launch-browser.js";
import { browserProfile } from "./user-config.js";
import { createIdleExitTimer, createShutdownSequence } from "./broker-lifecycle.js";
import { brokerBuildStamp } from "./broker-stamp.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import {
  authProof,
  brokerOriginAllowed,
  loadBrokerAuth,
  proofMatches,
} from "./broker-auth.js";
import { randomBytes } from "node:crypto";
import { PLAYWRIGHT_EXTENSION_INSTALL_URL } from "./playwright-relay/protocol.js";

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("broker requires a port between 1 and 65535");
}

process.on("uncaughtException", (error) => console.error("broker uncaught:", error));
process.on("unhandledRejection", (error) => console.error("broker unhandled:", error));

const auth = loadBrokerAuth();
const server = new WebSocketServer({
  port,
  host: "127.0.0.1",
  maxPayload: 2 * 1024 * 1024,
  verifyClient: ({ origin }, done) => {
    const allowed = brokerOriginAllowed(origin);
    done(allowed, allowed ? 101 : 403, allowed ? undefined : "forbidden origin");
  },
});
const clients = new Set<WebSocket>();
type Unauthenticated =
  | { kind: "new" }
  | { kind: "challenge"; token: string; clientNonce: string; serverNonce: string }
  | { kind: "identified" };
const unauthenticated = new Map<WebSocket, Unauthenticated>();
const authTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
const cdp = createCdpBackend();
const extension = createPlaywrightExtensionBackend((message) =>
  console.error(message)
);
let extensionExpected = false;
void playwrightExtensionInstalled(undefined, browserProfile()).then((installed) => {
  extensionExpected = installed;
});
const extensionGraceMs =
  Number(process.env.LENS_BROKER_EXTENSION_GRACE_MS ?? "") || 2_000;
const orchestrator = createBrokerOrchestrator([extension, cdp], {
  preferredWaitMs: () => (extensionExpected ? extensionGraceMs : 0),
  prepareFallback: () => cdp.acquire(),
});
let ensureBrowserInFlight: Promise<void> | undefined;
let browserPresent: boolean | undefined;
const requestQueue = new SerialTaskQueue();
const buildStamp = brokerBuildStamp();
const DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_EXIT_MS = 15 * 60_000;
const DEFAULT_NO_BROWSER_EXIT_MS = 10_000;
let shuttingDown = false;

const idleReleaseMs = Number(process.env.LENS_BROKER_IDLE_RELEASE_MS ?? 0) || 0;
const idleExitMs = Number(process.env.LENS_BROKER_IDLE_EXIT_MS ?? DEFAULT_IDLE_EXIT_MS) || 0;
const noBrowserExitMs =
  Number(process.env.LENS_BROKER_NO_BROWSER_EXIT_MS ?? DEFAULT_NO_BROWSER_EXIT_MS) || 0;
let inFlight = 0;
let activeCall: { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;
let lastBackendError: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const idleExit = createIdleExitTimer({
  idleMs: idleExitMs,
  noBrowserMs: noBrowserExitMs,
  isIdle: () => clients.size === 0 && inFlight === 0,
  browserLive: async () =>
    extension.available() ||
    extensionExpected ||
    (await cdp.browserLive()),
  onExit: (reason) => shutdown(reason),
});

function ensureBrowser(): Promise<void> {
  ensureBrowserInFlight ??= checkAndConnect().finally(() => {
    ensureBrowserInFlight = undefined;
  });
  return ensureBrowserInFlight;
}

async function checkAndConnect(): Promise<void> {
  browserPresent = await browserRunning();
  if (!browserPresent) {
    const profile = browserProfile();
    if (!autoLaunchEnabled() || !(await launchBrowser(profile))) {
      concedeToCdp("no browser could be started");
      return;
    }
    browserPresent = true;
    console.error(`started Chrome with profile "${profile}"`);
  }
  extensionExpected = await playwrightExtensionInstalled(undefined, browserProfile());
  if (!extensionExpected) {
    concedeToCdp("Playwright Extension is not installed in this Chrome profile");
    return;
  }
  if (extension.available()) return;
  try {
    await extension.acquire((message) => console.error(message));
  } catch (error) {
    concedeToCdp(error instanceof Error ? error.message : String(error));
  }
}

function concedeToCdp(reason: string): void {
  if (!extension.available()) {
    console.error(`falling back to CDP: ${reason}`);
    cdp.start();
  }
  broadcastStatus();
}

function beginWork(): void {
  inFlight += 1;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  idleExit.reset();
}

function endWork(): void {
  inFlight -= 1;
  broadcastStatus();
  idleExit.reset();
  if (idleReleaseMs <= 0 || inFlight > 0) return;
  idleTimer = setTimeout(() => {
    if (inFlight === 0) {
      void extension.release();
      void cdp.release();
    }
  }, idleReleaseMs);
}

cdp.onStatusChange(() => {
  rememberBackendError(cdp);
  broadcastStatus();
});
extension.onStatusChange(() => {
  rememberBackendError(extension);
  broadcastStatus();
  idleExit.reset();
  if (extension.available()) {
    cdp.stop();
    void cdp.release();
  }
});
const fallbackStart = setTimeout(() => {
  if (!extension.available()) cdp.start();
}, extensionGraceMs);

idleExit.reset();

server.on("error", (error) => {
  console.error("broker server error:", error);
  process.exit(1);
});
server.on("connection", (socket) => {
  unauthenticated.set(socket, { kind: "new" });
  armAuthTimeout(socket, 5_000);
  socket.on("message", (data) => routeSocketMessage(socket, data.toString()));
  socket.on("close", () => clearSocketAuth(socket));
});
server.on("close", () => {
  clearTimeout(fallbackStart);
  extension.stop();
  cdp.stop();
});

function routeSocketMessage(socket: WebSocket, raw: string): void {
  const state = unauthenticated.get(socket);
  if (!state || state.kind === "identified") {
    onClientMessage(socket, raw);
    return;
  }
  const message = parse(raw);
  if (!message) return socket.close(1008, "invalid authentication frame");

  if (state.kind === "new" && message.type === "client-auth") {
    if (typeof message.nonce !== "string" || message.nonce.length < 16 || message.nonce.length > 256) {
      return socket.close(1008, "invalid authentication nonce");
    }
    const serverNonce = randomBytes(24).toString("base64url");
    unauthenticated.set(socket, {
      kind: "challenge",
      token: auth.brokerToken,
      clientNonce: message.nonce,
      serverNonce,
    });
    send(socket, {
      type: "auth-challenge",
      nonce: serverNonce,
      proof: authProof(auth.brokerToken, "broker", message.nonce, serverNonce),
    });
    return;
  }

  if (state.kind === "challenge" && message.type === "auth-response") {
    if (!proofMatches(message.proof, authProof(state.token, "client", state.clientNonce, state.serverNonce))) {
      return socket.close(1008, "authentication failed");
    }
    identifyClient(socket);
    return;
  }
  socket.close(1008, "unexpected authentication frame");
}

function identifyClient(socket: WebSocket): void {
  clearAuthTimer(socket);
  unauthenticated.set(socket, { kind: "identified" });
  clients.add(socket);
  idleExit.reset();
  sendStatus(socket);
  socket.on("close", () => {
    clients.delete(socket);
    idleExit.reset();
  });
}

function armAuthTimeout(socket: WebSocket, milliseconds: number): void {
  clearAuthTimer(socket);
  authTimers.set(socket, setTimeout(() => socket.close(1008, "authentication timed out"), milliseconds));
}

function clearAuthTimer(socket: WebSocket): void {
  const timer = authTimers.get(socket);
  if (timer) clearTimeout(timer);
  authTimers.delete(socket);
}

function clearSocketAuth(socket: WebSocket): void {
  clearAuthTimer(socket);
  unauthenticated.delete(socket);
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
  const needsBrowser = message.type === "observe" || specNeedsBrowser(message.spec);
  if (shuttingDown) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: "lens broker is shutting down; reconnect to respawn it" },
    });
    return;
  }
  beginWork();
  const queuedAhead = inFlight - (activeCall ? 1 : 0) - 1;
  if (activeCall || queuedAhead > 0) {
    send(client, {
      type: "progress",
      id: message.id,
      message: `queued by serial broker concurrency policy (${queuedAhead + 1} ahead)`,
    });
  }
  broadcastStatus();
  void requestQueue
    .run(async () => {
      if (message.deadline !== undefined && message.deadline <= Date.now()) {
        send(client, {
          type: "result",
          id: message.id,
          result: {
            kind: "error",
            message: `call ${message.id} expired while queued; no browser work began`,
            ...(message.type === "call" &&
            (message.spec.perform?.length ?? 0) > 0 &&
            message.spec.effects.idempotent !== true
              ? {
                  mutation: {
                    performStarted: false,
                    submissionMayHaveHappened: false,
                    performed: "no" as const,
                  },
                }
              : {}),
          },
        });
        return;
      }
      activeCall = {
        id: message.id,
        type: message.type,
        ...(message.type === "call" ? { lens: message.spec.name } : {}),
        startedAt: Date.now(),
      };
      broadcastStatus();
      try {
        if (needsBrowser) await ensureBrowser();
        await handleClientMessage(client, message);
      } finally {
        activeCall = undefined;
        broadcastStatus();
      }
    })
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
    if (message.action === "release") {
      await extension.release();
      await cdp.release();
    }
    if (message.action === "acquire") {
      await ensureBrowser();
      const target = extension.available() ? extension : cdp;
      await target.acquire((text) => send(client, { type: "progress", id: message.id, message: text }));
    }
  } catch (error) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  const selected = extension.available() ? extension : cdp;
  send(client, {
    type: "result",
    id: message.id,
    result: {
      kind: "value",
      value: { connected: selected.available(), lease: cdp.lease() },
    },
  });
}

async function handleClientMessage(client: WebSocket, message: LensBridgeRequest): Promise<void> {
  if (client.readyState !== WebSocket.OPEN) return;
  if (message.type !== "call" && message.type !== "observe") return;
  await orchestrator.handle(message, (frame) => send(client, frame));
}

function shutdown(reason: string): Promise<void> {
  shuttingDown = true;
  return runShutdown(reason);
}

const runShutdown = createShutdownSequence({
  inFlight: () => inFlight,
  drainTimeoutMs: DRAIN_TIMEOUT_MS,
  release: async () => {
    await extension.release();
    await cdp.release();
  },
  log: (message) => console.error(message),
  stopListening: () => server.close(),
  closeSockets() {
    for (const socket of unauthenticated.keys()) socket.close();
  },
  stop() {
    idleExit.stop();
    extension.stop();
    cdp.stop();
    clearTimeout(fallbackStart);
  },
  exit: () => process.exit(0),
});

function sendStatus(socket: WebSocket): void {
  const preferred = extension.available() ? extension : cdp;
  const reportedActiveCall = activeCall ?? orchestrator.busy();
  const backends = [extension, cdp].map((backend) => ({
    ...backend.info(),
    available: backend.available(),
  }));
  const selected = preferred.available() ? preferred.info() : undefined;
  send(socket, {
    type: "status",
    stamp: buildStamp,
    connected: preferred.available(),
    lease: cdp.lease(),
    backend: selected?.name,
    ua: selected?.detail,
    capabilities: selected?.capabilities ?? [],
    backends,
    diagnostics: {
      concurrency: "serial_queue",
      activeCall: reportedActiveCall,
      queuedCalls: Math.max(0, inFlight - (activeCall ? 1 : 0)),
      lastBackendError:
        lastBackendError ?? backends.find((backend) => backend.diagnostic)?.diagnostic,
      reconnectAttempts: cdp.info().reconnectAttempts ?? 0,
      reachability: {
        chrome: cdp.available() ? true : browserPresent,
        extension: extension.available(),
      },
    },
    advice: describeGap(),
  });
}

function describeGap(): string | undefined {
  if (extension.available() || cdp.available()) return undefined;
  if (!extensionExpected) {
    return (
      `Playwright Extension is not installed; install it from ${PLAYWRIGHT_EXTENSION_INSTALL_URL} ` +
      "or enable chrome://inspect/#remote-debugging for the CDP fallback (Chrome will ask you to click Allow)"
    );
  }
  if (browserPresent === false) {
    return "Chrome is not running; start it, then approve the Playwright Extension connect page";
  }
  return (
    "waiting for the Playwright Extension: select tabs for the Lenses group on the connect page. " +
    "Chrome shows a debugger infobar on attached tabs. Set PLAYWRIGHT_MCP_EXTENSION_TOKEN to skip repeated approval. " +
    "Direct CDP remains available at chrome://inspect/#remote-debugging"
  );
}

function rememberBackendError(backend: { info(): { name: string; diagnostic?: string } }): void {
  const diagnostic = backend.info().diagnostic;
  if (diagnostic) lastBackendError = `${backend.info().name}: ${diagnostic}`;
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
