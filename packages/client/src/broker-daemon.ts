#!/usr/bin/env node
import { WebSocket, WebSocketServer } from "ws";
import { expandUrl, urlOrigin, type LensBridgeRequest } from "@notation/lenses-core";
import { createBrokerAuthLeases } from "./auth-leases.js";
import {
  createBrokerOrchestrator,
  type AuthRetryState,
  type BrokerFrame,
  type BrokerOrchestrator,
} from "./broker-orchestrator.js";
import { createCdpBackend, type CdpBackend } from "./cdp-host.js";
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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { browserAdvice } from "./broker-advice.js";
import { PLAYWRIGHT_EXTENSION_INSTALL_URL } from "./playwright-relay/protocol.js";
import { createElectronTransport, type ElectronHost } from "./electron-host.js";
import { parsePort } from "./port.js";

export interface BrokerOptions {
  /** Port to listen on, on 127.0.0.1. 0 picks a free port. */
  port: number;
  /** Set when the Lenses app runs this broker in its main process. */
  host?: ElectronHost;
  /** Replaces the browser backend; for tests. */
  backend?: CdpBackend;
  /** Replaces the call orchestrator; for tests. */
  orchestrator?: BrokerOrchestrator;
  /** Replaces the per-user broker credential; for tests. */
  auth?: { brokerToken: string };
  /** Called when an idle or requested shutdown completes. Defaults to process.exit. */
  exit?: (code: number) => void;
}

export interface Broker {
  /** The port the broker listens on. */
  port: number;
  status(): unknown;
  /** Stop listening and close every connection, without calling exit. */
  close(): Promise<void>;
}

/**
 * Start a broker on 127.0.0.1. Resolves once the server listens; rejects
 * when it cannot listen, e.g. because the port is taken.
 */
export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const { port, host } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  installProcessLogging();
  console.error(`broker ${process.pid} starting on port ${port}`);

  const auth = options.auth ?? loadBrokerAuth();
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
  const backend: CdpBackend = options.backend ?? (host
    ? createCdpBackend(undefined, createElectronTransport(host))
    : createPlaywrightExtensionBackend(
        (message) => console.error(message),
        { profile, token: extensionToken }
      ));
  let extensionInstalled: boolean | undefined;
  /** The last attempt to attach Playwright Extension failed; reported as advice. */
  let extensionAttemptFailed = false;
  if (!host && !options.backend) {
    void playwrightExtensionInstalled(undefined, profile).then((installed) => {
      extensionInstalled = installed;
    });
  }
  const orchestrator = options.orchestrator ?? createBrokerOrchestrator([backend], {
    prepareBackends: ensureBrowser,
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
  // The app owns its broker's lifetime.
  const idleExitMs = host
    ? 0
    : Number(process.env.LENS_BROKER_IDLE_EXIT_MS ?? DEFAULT_IDLE_EXIT_MS) || 0;
  const noBrowserExitMs =
    Number(process.env.LENS_BROKER_NO_BROWSER_EXIT_MS ?? DEFAULT_NO_BROWSER_EXIT_MS) || 0;
  let inFlight = 0;
  let queuedCalls = 0;
  let activeCall: { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;
  let lastBackendError: string | undefined;
  let lastBackendErrorSource: string | undefined;
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
    isIdle: () => clients.size === 0 && !backend.available() && inFlight === 0,
    browserLive: async () => backend.available() || (await browserRunning()),
    onExit: (reason) => shutdown(reason),
  });

  // Every call waiting on one shared acquisition receives its progress, so a
  // call that times out names the step it was waiting on.
  const acquireListeners = new Set<(message: string) => void>();

  function ensureBrowser(progress?: (message: string) => void): Promise<void> {
    if (progress) acquireListeners.add(progress);
    ensureBrowserInFlight ??= checkAndConnect().finally(() => {
      ensureBrowserInFlight = undefined;
    });
    return ensureBrowserInFlight.finally(() => {
      if (progress) acquireListeners.delete(progress);
    });
  }

  async function checkAndConnect(): Promise<void> {
    if (host) {
      backend.start();
      return;
    }
    browserPresent = await browserRunning();
    if (!browserPresent) {
      if (!autoLaunchEnabled() || !(await launchBrowser(profile))) {
        broadcastStatus();
        throw new Error("Chrome is not running and could not be started");
      }
      browserPresent = true;
      console.error(`started Chrome with profile "${profile}"`);
    }
    extensionInstalled = await playwrightExtensionInstalled(undefined, profile);
    if (extensionInstalled === false) {
      broadcastStatus();
      throw new Error(
        `Playwright Extension is not installed in Chrome profile "${profile}"; ` +
          `install it from ${PLAYWRIGHT_EXTENSION_INSTALL_URL}`
      );
    }
    if (backend.available()) {
      extensionAttemptFailed = false;
      return;
    }
    try {
      await backend.acquire((message) => {
        console.error(message);
        for (const listener of acquireListeners) listener(message);
      });
      extensionAttemptFailed = false;
    } catch (error) {
      extensionAttemptFailed = true;
      broadcastStatus();
      throw error;
    }
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
          await backend.release();
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

  backend.onLeaseReleaseRequest(() => {
    void requestLeaseRelease();
  });
  backend.onStatusChange(() => {
    rememberBackendError(backend);
    broadcastStatus();
    idleExit.reset();
    if (backend.available()) extensionAttemptFailed = false;
  });
  if (host) backend.start();

  idleExit.reset();

  server.on("connection", (socket) => {
    unauthenticated.set(socket, { kind: "new" });
    armAuthTimeout(socket, 5_000);
    socket.on("message", (data) => routeSocketMessage(socket, data.toString()));
    socket.on("close", () => clearSocketAuth(socket));
  });
  server.on("close", () => {
    backend.stop();
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
    let answered = false;
    const reply = (frame: BrokerFrame) => {
      if (frame.type === "result") answered = true;
      send(client, frame);
    };
    void (async () => {
      // The execution deadline covers the first attempt; the sign-in lease
      // begins only when that attempt actually returns needs_auth.
      let authExpiresAt = 0;
      const authLeaseMs = message.type === "call" ? message.authLeaseMs ?? 0 : 0;
      let attempt = 0;
      let resumeGate = false;
      // Where the sign-in tab was when a retry last did browser work.
      const retryState: AuthRetryState = {};
      let authOutcome: Extract<BrokerFrame, { type: "result" }> | undefined;
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
          if (client.readyState === WebSocket.OPEN) reply(authOutcome!);
        }, Math.max(0, authExpiresAt - Date.now())) : undefined;
        const result = await requestQueue.run(async () => {
          queuedCalls--;
          started = true;
          if (expiredWhileQueued) return;
          // The client disconnected while the call waited. Starting it now
          // would perform the steps of a write call the user interrupted.
          if (cancelled.signal.aborted) return;
          const deadline = attempt === 0 ? message.deadline : message.type === "call"
            ? Math.min(authExpiresAt, Date.now() + message.timeoutMs)
            : message.deadline;
          if (deadline !== undefined && deadline <= Date.now()) {
            if (attempt > 0 && authOutcome) {
              reply(authOutcome);
              return;
            }
            reply({
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
            let intercepted: Extract<BrokerFrame, { type: "result" }> | undefined;
            // The orchestrator waits the full waitMs of an observe. A wait past
            // the client's deadline would hold the queue after it gave up.
            const work: typeof message = message.type === "observe"
              ? deadline === undefined
                ? message
                : { ...message, waitMs: Math.min(message.waitMs, Math.max(0, deadline - Date.now())) }
              : attempt > 0 ? { ...message, deadline } : message;
            await orchestrator.handle(
              work,
              (frame) => {
                if (frame.type === "result" && message.type === "call" && authLeaseMs > 0 &&
                    (authExpiresAt === 0 || authExpiresAt > Date.now()) &&
                    frame.result.kind === "outcome" && frame.result.name === "needs_auth" && frame.authReplaySafe) {
                  authExpiresAt ||= Date.now() + authLeaseMs;
                  intercepted = frame;
                } else reply(frame);
              },
              { authRetry: attempt > 0, retry: retryState }
            );
            return intercepted;
          } finally {
            activeCall = undefined;
            // The orchestrator has already sent the authoritative result and
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
        catch { reply(result); return; }
        const origin = urlOrigin(target);
        if (!authOrigin) {
          authOrigin = origin;
          authLeases.retain(origin);
        }
        if (attempt === 0) reply({ type: "progress", id: message.id, message: `waiting for sign-in at ${origin}` });
        const reason = await authLeases.wait(origin, target, authExpiresAt, cancelled.signal, resumeGate);
        if (reason !== "unavailable") resumeGate = true;
        if (client.readyState === WebSocket.OPEN && reason === "expired") {
          reply({ type: "progress", id: message.id, message: "sign-in wait expired" });
        }
        if (reason === "cancelled" || reason === "expired" ||
            client.readyState !== WebSocket.OPEN || Date.now() >= authExpiresAt) {
          if (client.readyState === WebSocket.OPEN) reply(authOutcome);
          return;
        }
        // A detached or replaced browser page is not a cancelled sign-in. Wait
        // outside the serial queue, then check the site again using the browser's
        // cookies. A missing tab must not cause an immediate retry loop.
        if (reason === "closed" || reason === "unavailable") {
          await sleep(Math.min(1_000, Math.max(0, authExpiresAt - Date.now())), undefined,
            { signal: cancelled.signal }).catch(() => {});
          if (cancelled.signal.aborted || Date.now() >= authExpiresAt) {
            if (client.readyState === WebSocket.OPEN) reply(authOutcome);
            return;
          }
        }
        attempt++;
      }
    })().catch((error) => {
      console.error("broker request failed:", error);
      if (answered) return;
      send(client, {
        type: "result",
        id: message.id,
        result: {
          kind: "error",
          message: `broker failed while running ${message.id}: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }).finally(() => {
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
      // A call counts from arrival to result, through any sign-in wait. The
      // app's broker declines: clients then use it as it is.
      if (host || (message.ifIdle && inFlight > 0)) {
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
        await ensureBrowser();
        await backend.acquire((text) => send(client, { type: "progress", id: message.id, message: text }));
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
        value: { connected: backend.available(), lease: backend.lease() },
      },
    });
  }

  function shutdown(reason: string): Promise<void> {
    shuttingDown = true;
    return runShutdown(reason);
  }

  const runShutdown = createShutdownSequence({
    inFlight: () => inFlight,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    release: async () => {
      await backend.release({ handOver: handOverTabs });
    },
    log: (message) => console.error(message),
    stopListening: () => server.close(),
    closeSockets() {
      for (const socket of unauthenticated.keys()) socket.close();
    },
    stop() {
      idleExit.stop();
      backend.stop();
    },
    exit: () => exit(0),
  });

  function sendStatus(socket: WebSocket): void {
    send(socket, currentStatus());
  }

  function currentStatus() {
    const connected = backend.available();
    const reportedActiveCall = activeCall ?? orchestrator.busy();
    const backendInfo = [{
      ...backend.info(),
      available: connected,
      ...(connected ? { diagnostic: undefined } : {}),
    }];
    const selected = connected ? backend.info() : undefined;
    return {
      type: "status",
      stamp: buildStamp,
      builtAt: build.builtAt,
      protocol: BROKER_PROTOCOL,
      connected,
      lease: backend.lease(),
      backend: selected?.name,
      ua: selected?.detail,
      capabilities: selected?.capabilities ?? [],
      backends: backendInfo,
      diagnostics: {
        concurrency: "serial_queue",
        activeCall: reportedActiveCall,
        queuedCalls,
        lastBackendError: connected
          ? undefined
          : lastBackendError ?? backendInfo[0].diagnostic,
        reconnectAttempts: backend.info().reconnectAttempts ?? 0,
      },
      advice: host ? undefined : describeGap(),
    };
  }

  function describeGap(): string | undefined {
    return browserAdvice({
      extensionAvailable: backend.available(),
      extensionInstalled,
      extensionAttemptFailed,
      browserPresent,
      acquiring: !!ensureBrowserInFlight,
      extensionToken: !!extensionToken,
    });
  }

  function rememberBackendError(backend: { info(): { name: string; diagnostic?: string } }): void {
    const info = backend.info();
    if (info.diagnostic) {
      lastBackendError = `${info.name}: ${info.diagnostic}`;
      lastBackendErrorSource = info.name;
    } else if (lastBackendErrorSource === info.name) {
      // The backend that reported the remembered error has recovered; the
      // problem no longer exists, so stop sending it to clients.
      lastBackendError = undefined;
      lastBackendErrorSource = undefined;
    }
  }

  function broadcastStatus(): void {
    for (const client of clients) sendStatus(client);
    host?.status?.(currentStatus());
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

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  }).catch((error) => {
    idleExit.stop();
    backend.stop();
    throw error;
  });
  server.on("error", (error) => console.error("broker server error:", error));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  host?.started?.({ status: currentStatus });

  return {
    port: boundPort,
    status: currentStatus,
    async close() {
      shuttingDown = true;
      idleExit.stop();
      if (idleTimer) clearTimeout(idleTimer);
      for (const timer of authTimers.values()) clearTimeout(timer);
      for (const socket of unauthenticated.keys()) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      backend.stop();
    },
  };
}

// stderr is the broker log file (see startBroker in bridge.ts); timestamp
// every line so a lost connection or restart can be lined up against the
// calls around it.
const TIMESTAMPED = Symbol.for("lenses.broker.timestamped");

function installProcessLogging(): void {
  if ((console.error as { [TIMESTAMPED]?: true })[TIMESTAMPED]) return;
  const writeLog = console.error.bind(console);
  console.error = Object.assign(
    (...args: unknown[]) => writeLog(new Date().toISOString(), ...args),
    { [TIMESTAMPED]: true as const }
  );
  process.on("exit", (code) => console.error(`broker ${process.pid} exiting (code ${code})`));
  process.on("uncaughtException", (error) => console.error("broker uncaught:", error));
  process.on("unhandledRejection", (error) => console.error("broker unhandled:", error));
}

function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  const port = parsePort(process.argv[2] ?? "", "broker port");
  startBroker({ port }).catch((error) => {
    console.error("broker server error:", error);
    process.exit(1);
  });
}
