#!/usr/bin/env node
/**
 * Persistent local broker: serialises lens calls from CLI/MCP/library clients.
 * One CDP-backed browser implementation, two transports: Playwright Extension
 * relay first, direct Chrome remote debugging as fallback.
 */
import { WebSocket, WebSocketServer } from "ws";
import { expandUrl, urlOrigin, type LensBridgeRequest } from "@djgrant/lenses-core";
import { createBrokerAuthLeases } from "./auth-leases.js";
import { createBrokerOrchestrator } from "./broker-orchestrator.js";
import { createCdpBackend } from "./cdp-host.js";
import { createPlaywrightExtensionBackend } from "./playwright-extension-backend.js";
import { playwrightExtensionInstalled } from "./chrome-paths.js";
import {
  autoLaunchEnabled,
  browserRunning,
  launchBrowser,
} from "./launch-browser.js";
import { browserProfile, playwrightExtensionToken } from "./user-config.js";
import { createIdleExitTimer, createShutdownSequence } from "./broker-lifecycle.js";
import { BROKER_PROTOCOL, brokerBuild } from "./broker-stamp.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import {
  authProof,
  brokerOriginAllowed,
  loadBrokerAuth,
  proofMatches,
} from "./broker-auth.js";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { browserAdvice } from "./broker-advice.js";

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("broker requires a port between 1 and 65535");
}

// stderr is the broker log file (see startBroker); timestamp every line so a
// lost connection or restart can be lined up against the calls around it.
const TIMESTAMPED = Symbol.for("lenses.broker.timestamped");
if (!(console.error as { [TIMESTAMPED]?: true })[TIMESTAMPED]) {
  const writeLog = console.error.bind(console);
  console.error = Object.assign(
    (...args: unknown[]) => writeLog(new Date().toISOString(), ...args),
    { [TIMESTAMPED]: true as const }
  );
}
console.error(`broker ${process.pid} starting on port ${port}`);
process.on("exit", (code) => console.error(`broker ${process.pid} exiting (code ${code})`));

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
const profile = browserProfile();
const extensionToken = playwrightExtensionToken();
const cdp = createCdpBackend();
const extension = createPlaywrightExtensionBackend(
  (message) => console.error(message),
  { profile, token: extensionToken }
);
let extensionInstalled: boolean | undefined;
/** This process already failed to attach; do not wait 45s on every later call. */
let extensionAttemptFailed = false;
void playwrightExtensionInstalled(undefined, profile).then((installed) => {
  extensionInstalled = installed;
});
const extensionGraceMs =
  Number(process.env.LENS_BROKER_EXTENSION_GRACE_MS ?? "") || 2_000;
const orchestrator = createBrokerOrchestrator([extension, cdp], {
  prepareBackends: ensureBrowser,
  preferredWaitMs: () =>
    extensionInstalled === true && !extensionAttemptFailed ? extensionGraceMs : 0,
  prepareFallback: () => cdp.acquire(),
});
let ensureBrowserInFlight: Promise<void> | undefined;
let browserPresent: boolean | undefined;
const requestQueue = new SerialTaskQueue();
const authLeases = createBrokerAuthLeases(orchestrator);
const build = brokerBuild();
const buildStamp = build.stamp;
const DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_EXIT_MS = 15 * 60_000;
const DEFAULT_NO_BROWSER_EXIT_MS = 10_000;
let shuttingDown = false;
/** A client asked for the restart: leave the group's tabs for the next broker. */
let handOverTabs = false;

const idleReleaseMs = Number(process.env.LENS_BROKER_IDLE_RELEASE_MS ?? 0) || 0;
const idleExitMs = Number(process.env.LENS_BROKER_IDLE_EXIT_MS ?? DEFAULT_IDLE_EXIT_MS) || 0;
const noBrowserExitMs =
  Number(process.env.LENS_BROKER_NO_BROWSER_EXIT_MS ?? DEFAULT_NO_BROWSER_EXIT_MS) || 0;
let inFlight = 0;
let queuedCalls = 0;
let activeCall: { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;
let lastBackendError: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let leaseReleaseRequested = false;
let leaseReleaseInFlight: Promise<void> | undefined;
let leaseReleaseWaiters: Array<{
  resolve: () => void;
  reject: (error: unknown) => void;
}> = [];

const idleExit = createIdleExitTimer({
  idleMs: idleExitMs,
  noBrowserMs: noBrowserExitMs,
  isIdle: () => clients.size === 0 && !extension.available() && inFlight === 0,
  browserLive: async () => extension.available() || (await cdp.browserLive()),
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
    if (!autoLaunchEnabled() || !(await launchBrowser(profile))) {
      startCdpFallback("no browser could be started");
      return;
    }
    browserPresent = true;
    // A failure from the previous Chrome process does not apply to this new
    // session; let Playwright Extension be preferred again.
    extensionAttemptFailed = false;
    console.error(`started Chrome with profile "${profile}"`);
  }
  extensionInstalled = await playwrightExtensionInstalled(undefined, profile);
  if (extensionInstalled === false) {
    startCdpFallback("Playwright Extension is not installed in this Chrome profile");
    return;
  }
  if (extension.available()) {
    extensionAttemptFailed = false;
    return;
  }
  if (extensionAttemptFailed) {
    cdp.start();
    return;
  }
  try {
    await extension.acquire((message) => console.error(message));
    extensionAttemptFailed = false;
  } catch (error) {
    extensionAttemptFailed = true;
    startCdpFallback(error instanceof Error ? error.message : String(error));
  }
}

function startCdpFallback(reason: string): void {
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
    if (inFlight === 0) void requestLeaseRelease();
  }, idleReleaseMs);
}

/**
 * Queue a lease release behind the authoritative result of the active call.
 * This is also used when the user closes the broker-owned anchor: queued calls
 * will observe a released lease and may acquire a fresh anchor in turn.
 */
function requestLeaseRelease(): Promise<void> {
  leaseReleaseRequested = true;
  const completion = new Promise<void>((resolve, reject) => {
    leaseReleaseWaiters.push({ resolve, reject });
  });
  if (activeCall || leaseReleaseInFlight) return completion;
  leaseReleaseInFlight = (async () => {
    try {
      while (leaseReleaseRequested && !activeCall) {
        leaseReleaseRequested = false;
        await extension.release();
        await cdp.release();
      }
      const waiters = leaseReleaseWaiters;
      leaseReleaseWaiters = [];
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      const waiters = leaseReleaseWaiters;
      leaseReleaseWaiters = [];
      for (const waiter of waiters) waiter.reject(error);
      throw error;
    } finally {
      leaseReleaseInFlight = undefined;
    }
  })();
  // The completion carries the same error without leaving the internal worker
  // as an unhandled rejected promise.
  void leaseReleaseInFlight.catch(() => {});
  return completion;
}

cdp.onStatusChange(() => {
  rememberBackendError(cdp);
  broadcastStatus();
});
extension.onLeaseReleaseRequest(() => {
  void requestLeaseRelease();
});
extension.onStatusChange(() => {
  rememberBackendError(extension);
  broadcastStatus();
  idleExit.reset();
  if (extension.available()) {
    extensionAttemptFailed = false;
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
  if (shuttingDown) {
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "error", message: "lens broker is shutting down; reconnect to respawn it" },
    });
    return;
  }
  beginWork();
  const queuedAhead = queuedCalls;
  if (activeCall || queuedAhead > 0) {
    send(client, {
      type: "progress",
      id: message.id,
      message: `queued by serial broker concurrency policy (${queuedAhead + 1} ahead)`,
    });
  }
  broadcastStatus();
  const cancelled = new AbortController();
  let authOrigin: string | undefined;
  const onClose = () => cancelled.abort();
  client.on("close", onClose);
  void (async () => {
    // The execution deadline covers the first attempt; the sign-in lease
    // begins only when that attempt actually returns needs_auth.
    let authExpiresAt = 0;
    const authLeaseMs = message.type === "call" ? message.authLeaseMs ?? 0 : 0;
    let attempt = 0;
    let resumeGate = false;
    let authOutcome: Extract<import("./broker-orchestrator.js").BrokerFrame, { type: "result" }> | undefined;
    for (;;) {
      queuedCalls++;
      broadcastStatus();
      let started = false;
      let expiredWhileQueued = false;
      // The queue may be busy at lease expiry. Deliver the original outcome
      // on time without waiting for another call's browser work to complete.
      const expiryTimer = attempt > 0 && authOutcome ? setTimeout(() => {
        if (started || expiredWhileQueued) return;
        expiredWhileQueued = true;
        if (client.readyState === WebSocket.OPEN) send(client, authOutcome);
      }, Math.max(0, authExpiresAt - Date.now())) : undefined;
      const result = await requestQueue.run(async () => {
        queuedCalls--;
        started = true;
        if (expiredWhileQueued) return;
        const deadline = attempt === 0 ? message.deadline : message.type === "call"
          ? Math.min(authExpiresAt, Date.now() + message.timeoutMs)
          : message.deadline;
        if (deadline !== undefined && deadline <= Date.now()) {
          if (attempt > 0 && authOutcome) {
            send(client, authOutcome);
            return;
          }
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
          let intercepted: Extract<import("./broker-orchestrator.js").BrokerFrame, { type: "result" }> | undefined;
          await orchestrator.handle(
            message.type === "call" && attempt > 0 ? { ...message, deadline } : message,
            (frame) => {
              if (frame.type === "result" && message.type === "call" && authLeaseMs > 0 &&
                  (authExpiresAt === 0 || authExpiresAt > Date.now()) &&
                  frame.result.kind === "outcome" && frame.result.name === "needs_auth" && frame.authReplaySafe) {
                authExpiresAt ||= Date.now() + authLeaseMs;
                intercepted = frame;
              } else send(client, frame);
            },
            { authRetry: attempt > 0 }
          );
          return intercepted;
        } finally {
          activeCall = undefined;
          // handleClientMessage has already sent the authoritative result and
          // backend finish has completed all transient-tab cleanup.
          if (leaseReleaseRequested) await requestLeaseRelease();
          broadcastStatus();
        }
      });
      if (expiryTimer) clearTimeout(expiryTimer);
      if (!result || message.type !== "call") return;
      // Keep the lens's own outcome, unless the latest word is about a tab
      // the debugger lost (or has just re-gained): it names the tab and the
      // browser's last reason, which is what expiry must report.
      if (!authOutcome || result.tabDisconnected || authOutcome.tabDisconnected) authOutcome = result;
      let target: string;
      try { target = expandUrl(message.spec.url, message.params); }
      catch { send(client, result); return; }
      const origin = urlOrigin(target);
      if (!authOrigin) {
        authOrigin = origin;
        authLeases.retain(origin);
      }
      if (attempt === 0) send(client, { type: "progress", id: message.id, message: `waiting for sign-in at ${origin}` });
      const reason = await authLeases.wait(origin, target, authExpiresAt, cancelled.signal, resumeGate);
      if (reason !== "unavailable") resumeGate = true;
      if (client.readyState === WebSocket.OPEN && reason === "expired") {
        send(client, { type: "progress", id: message.id, message: "sign-in wait expired" });
      }
      if (reason === "cancelled" || reason === "expired" ||
          client.readyState !== WebSocket.OPEN || Date.now() >= authExpiresAt) {
        if (client.readyState === WebSocket.OPEN) send(client, authOutcome);
        return;
      }
      // A detached or replaced browser page is not a cancelled sign-in. Wait
      // outside the serial queue, then check the site again using the browser's
      // cookies. A missing tab must not cause an immediate retry loop.
      if (reason === "closed" || reason === "unavailable") {
        await sleep(Math.min(1_000, Math.max(0, authExpiresAt - Date.now())), undefined,
          { signal: cancelled.signal }).catch(() => {});
        if (cancelled.signal.aborted || Date.now() >= authExpiresAt) {
          if (client.readyState === WebSocket.OPEN) send(client, authOutcome);
          return;
        }
      }
      attempt++;
    }
  })().catch((error) => console.error("broker request failed:", error)).finally(() => {
    if (authOrigin) authLeases.close(authOrigin);
    client.off("close", onClose);
    endWork();
  });
}

async function handleControl(
  client: WebSocket,
  message: Extract<LensBridgeRequest, { type: "control" }>
): Promise<void> {
  if (message.action === "shutdown") {
    // A call counts from arrival to result, through any sign-in wait.
    if (message.ifIdle && inFlight > 0) {
      send(client, {
        type: "result",
        id: message.id,
        result: { kind: "value", value: { shuttingDown: false, stamp: buildStamp } },
      });
      return;
    }
    send(client, {
      type: "result",
      id: message.id,
      result: { kind: "value", value: { shuttingDown: true, stamp: buildStamp } },
    });
    handOverTabs = true;
    void shutdown("client requested a restart");
    return;
  }
  try {
    if (message.action === "release") await requestLeaseRelease();
    if (message.action === "acquire") {
      extensionAttemptFailed = false;
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
    await extension.release({ handOver: handOverTabs });
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
    builtAt: build.builtAt,
    protocol: BROKER_PROTOCOL,
    connected: preferred.available(),
    lease: cdp.lease(),
    backend: selected?.name,
    ua: selected?.detail,
    capabilities: selected?.capabilities ?? [],
    backends,
    diagnostics: {
      concurrency: "serial_queue",
      activeCall: reportedActiveCall,
      queuedCalls,
      lastBackendError:
        lastBackendError ?? backends.find((backend) => backend.diagnostic)?.diagnostic,
      reconnectAttempts: cdp.info().reconnectAttempts ?? 0,
    },
    advice: describeGap(),
  });
}

function describeGap(): string | undefined {
  return browserAdvice({
    extensionAvailable: extension.available(),
    cdpAvailable: cdp.available(),
    extensionInstalled,
    extensionAttemptFailed,
    browserPresent,
    acquiring: !!ensureBrowserInFlight,
    extensionToken: !!extensionToken,
  });
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
