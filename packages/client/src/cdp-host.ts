/**
 * CDP browser backend: owns Chrome connection and page mechanics only.
 * Lens orchestration, caching, retries, and result policy live in the broker.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { defaultChromeUserDataDir } from "./chrome-paths.js";
import {
  createCaptureBuffer,
  pageDomExtract,
  pagePerformClick,
  pagePerformCount,
  pagePerformFill,
  pagePerformPress,
  pagePerformSubmit,
  pageSnapshot,
  pushCapture,
  readCaptures,
  resetCaptureBuffer,
  sameGatePlace,
  sameTarget,
  urlOrigin,
  wakeCaptureWaiters,
  type AuthGate,
  type CaptureBuffer,
  type PerformResult,
  type PerformStep,
  type PerformWait,
} from "@djgrant/lenses-core";
import type {
  BackendHttpRequest,
  BindRequest,
  BrowserBackend,
  BrowserSession,
  FinishDisposition,
  InterceptDelta,
  SnapshotOptions,
  BackendInfo,
} from "./browser-backend.js";

const MAX_BODY_BYTES = 512 * 1024;
const LOAD_GRACE_MS = 500;
const PERFORM_POLL_MS = 150;
const PERFORM_WAIT_DEFAULT_MS = 10_000;
const CONNECT_WINDOW_MS = 45_000;
const CONNECT_RETRY_MS = 2_000;
const CONNECT_ATTEMPT_MS = 10_000;
const ENDPOINT_POLL_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const STALE_ENDPOINT_MESSAGE =
  "Chrome remote debugging is not responding. Open chrome://inspect/#remote-debugging in Chrome, " +
  "re-enable Remote Debugging, then retry.";

export type CdpLease = "held" | "released" | "disconnected";

/**
 * How a CDP-backed backend reaches Chrome. Direct remote debugging and the
 * Playwright Extension relay both produce a Puppeteer `Browser`; page
 * sessions, intercepts, and auth-gate bookkeeping stay here.
 */
export interface CdpTransport {
  readonly name: string;
  /** Poll DevToolsActivePort (or equivalent) and auto-connect. Off for the extension relay. */
  readonly pollForConnection: boolean;
  readonly retryConnect: boolean;
  readonly connectAttemptMs?: number;
  connect(
    progress: (message: string) => void,
    requestLeaseRelease: () => void
  ): Promise<Browser>;
  looksReady(): boolean;
  probeLive(): Promise<boolean>;
  connectHint(): string;
  staleHint(): string;
  /** Transport-specific status such as relay protocol and profile metadata. */
  info?(): Partial<BackendInfo>;
  /** Actionable status after an unexpected live connection loss. */
  disconnectHint?(): string;
  /** Transport cleanup before the browser lease is disconnected. */
  prepareLeaseRelease?(browser: Browser): Promise<void>;
  /** Transport cleanup before a session or temporary page is released. */
  preparePageRelease?(
    browser: Browser,
    page: Page,
    disposition: FinishDisposition,
    releasePage: boolean
  ): Promise<void>;
  dispose?(): void;
}

export interface CdpBackend extends BrowserBackend {
  lease(): CdpLease;
  /**
   * Whether a browser is actually reachable. Chrome leaves DevToolsActivePort
   * behind when it quits, so file presence is stale-positive; this probes the
   * endpoint.
   */
  browserLive(): Promise<boolean>;
  release(): Promise<void>;
  /** The transport's broker-owned anchor was explicitly closed by the user. */
  onLeaseReleaseRequest(listener: () => void): () => void;
  acquire(progress?: (message: string) => void): Promise<void>;
  start(): void;
  stop(): void;
}

interface CdpSession extends BrowserSession {
  page: Page;
  target: string;
  captures: CaptureBuffer;
  closed: boolean;
  stopRecordingState: () => void;
}

export function createCdpBackend(
  log: (message: string) => void = () => {},
  transport: CdpTransport = createDirectCdpTransport()
): CdpBackend {
  let browser: Browser | undefined;
  let browserVersion = "";
  let connecting: Promise<Browser> | undefined;
  let endpointPresent = false;
  let endpointPoll: ReturnType<typeof setInterval> | undefined;
  let released = false;
  let reconnectDelayMs = CONNECT_RETRY_MS;
  let nextReconnectAt = 0;
  let reconnectAttempts = 0;
  let lastConnectionError: string | undefined;
  let sessionSequence = 0;
  const captureBuffers = new WeakMap<Page, CaptureBuffer>();
  const statusListeners = new Set<() => void>();
  const leaseReleaseListeners = new Set<() => void>();
  /**
   * Pages kept by a needs_* outcome, and where they were kept. The map dies
   * with the process: neither CDP transport has durable tab leases.
   */
  const keptGates = new Map<Page, { target: string; keptUrl: string }>();

  const endpointAvailable = () => transport.looksReady();
  const endpointLive = () => transport.probeLive();
  const available = () => browser?.connected === true;
  const notifyStatusChange = () => {
    for (const listener of statusListeners) listener();
  };

  function captures(page: Page): CaptureBuffer {
    let state = captureBuffers.get(page);
    if (state) return state;
    state = createCaptureBuffer();
    captureBuffers.set(page, state);
    const owned = state;
    page.on("response", (response) => {
      void (async () => {
        const contentType = response.headers()["content-type"] ?? "";
        if (!/json|text|^$/.test(contentType)) return;
        try {
          const body = await response.text();
          const trimmed = body.trimStart();
          const looksJson =
            contentType.includes("json") ||
            trimmed.startsWith("{") ||
            trimmed.startsWith("[");
          if (!looksJson || body.length > MAX_BODY_BYTES) return;
          pushCapture(owned, {
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
            body,
            timestamp: Date.now(),
          });
        } catch {
          // Chrome may evict a response body during navigation.
        }
      })();
    });
    return state;
  }

  function resetCaptures(page: Page): CaptureBuffer {
    const state = captures(page);
    resetCaptureBuffer(state);
    return state;
  }

  async function ensureBrowser(progress: (message: string) => void): Promise<Browser> {
    released = false;
    if (browser?.connected) return browser;
    if (connecting) return connecting;
    if (!endpointAvailable()) {
      throw new Error(transport.connectHint());
    }
    connecting = connectBrowser(progress);
    try {
      return await connecting;
    } catch (error) {
      lastConnectionError = error instanceof Error ? error.message : String(error);
      notifyStatusChange();
      throw error;
    } finally {
      connecting = undefined;
    }
  }

  async function connectBrowser(
    progress: (message: string) => void
  ): Promise<Browser> {
    if (!(await endpointLive())) throw new Error(transport.staleHint());
    progress(transport.connectHint());
    const deadline = Date.now() + CONNECT_WINDOW_MS;
    let connected: Browser | undefined;
    for (;;) {
      try {
        connected = await attemptWithTimeout(
          transport.connect(progress, () => {
            for (const listener of leaseReleaseListeners) listener();
          }),
          transport.connectAttemptMs ?? CONNECT_ATTEMPT_MS
        );
        break;
      } catch (error) {
        reconnectAttempts += 1;
        lastConnectionError = error instanceof Error ? error.message : String(error);
        notifyStatusChange();
        if (!(await endpointLive())) throw new Error(transport.staleHint());
        if (transport.retryConnect === false || Date.now() >= deadline) {
          const reason =
            error instanceof Error ? error.message : String(error);
          throw new Error(`${transport.connectHint()} (${reason})`);
        }
        await delay(CONNECT_RETRY_MS);
      }
    }
    browser = connected;
    browserVersion = await connected.version();
    reconnectDelayMs = CONNECT_RETRY_MS;
    nextReconnectAt = 0;
    connected.on("disconnected", () => {
      if (browser !== connected) return;
      browser = undefined;
      browserVersion = "";
      endpointPresent = false;
      if (!released) {
        lastConnectionError =
          transport.disconnectHint?.() ??
          `${transport.name} disconnected; reconnect the browser and retry`;
      }
      transport.dispose?.();
      notifyStatusChange();
    });
    log(`${transport.name} connected: ${browserVersion}`);
    notifyStatusChange();
    return connected;
  }

  function pollEndpoint(): void {
    const present = endpointAvailable();
    if (!present) {
      endpointPresent = false;
      reconnectDelayMs = CONNECT_RETRY_MS;
      return;
    }
    const fresh = !endpointPresent;
    endpointPresent = true;
    if (released || available() || connecting) return;
    if (!fresh && Date.now() < nextReconnectAt) return;
    nextReconnectAt = Date.now() + reconnectDelayMs;
    reconnectDelayMs = Math.min(
      reconnectDelayMs * 2,
      RECONNECT_BACKOFF_MAX_MS
    );
    void ensureBrowser(() => {}).catch((error) => {
      log(
        `cdp connection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  async function reloadPage(page: Page, loadTimeoutMs: number): Promise<void> {
    resetCaptures(page);
    await settle(page.reload({ waitUntil: "load", timeout: loadTimeoutMs }));
  }

  /**
   * Serve a `navigate: "fresh"` step: reload when the tab is still on the
   * lens's origin, otherwise go back to the lens URL (an earlier step may
   * have taken the tab elsewhere).
   */
  async function navigateFresh(
    page: Page,
    target: string,
    loadTimeoutMs: number
  ): Promise<void> {
    if (urlOrigin(page.url()) === urlOrigin(target)) {
      await reloadPage(page, loadTimeoutMs);
      return;
    }
    resetCaptures(page);
    await settle(page.goto(target, { waitUntil: "load", timeout: loadTimeoutMs }));
  }

  function makeSession(
    page: Page,
    created: boolean,
    navigated: boolean,
    target: string,
    loadTimeoutMs: number
  ): CdpSession {
    let documentRevision = 0;
    let loading = false;
    const navigationStarted = (request: { isNavigationRequest(): boolean; frame(): unknown }) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      documentRevision += 1;
      loading = true;
    };
    const loaded = () => {
      loading = false;
    };
    page.on("request", navigationStarted);
    page.on("load", loaded);
    const session: CdpSession = {
      id: `cdp_${++sessionSequence}`,
      created,
      navigated,
      page,
      target,
      captures: captures(page),
      closed: false,
      stopRecordingState: () => {
        page.off?.("request", navigationStarted);
        page.off?.("load", loaded);
      },
      async reload(loadTimeoutMs) {
        assertOpen(session);
        await reloadPage(page, loadTimeoutMs);
      },
      async readIntercepts(cursor, deadline) {
        assertOpen(session);
        return readCaptures(session.captures, cursor, deadline);
      },
      async domExtract(resolver) {
        assertOpen(session);
        return page.evaluate(pageDomExtract, {
          item: resolver.item,
          fields: resolver.fields,
        });
      },
      async perform(steps) {
        assertOpen(session);
        return performSteps(page, steps, () =>
          navigateFresh(page, target, loadTimeoutMs)
        );
      },
      async snapshot(options) {
        assertOpen(session);
        return page.evaluate(pageSnapshot, options);
      },
      async recordingState() {
        assertOpen(session);
        return {
          url: page.url(),
          title: await page.title(),
          documentRevision,
          loading,
        };
      },
      async recordingScreenshot() {
        assertOpen(session);
        const png = await page.screenshot({
          type: "png",
          encoding: "base64",
          fullPage: true,
        });
        return typeof png === "string" ? png : Buffer.from(png).toString("base64");
      },
    };
    return session;
  }

  return {
    name: transport.name,
    available,
    info: () => ({
      name: transport.name,
      detail: browserVersion || undefined,
      capabilities: [
        "browser-session",
        "credentialed-http",
        "credentialed-http-body",
        "same-origin-page-http",
      ],
      diagnostic: lastConnectionError,
      reconnectAttempts,
      sameOriginPageRequests: true,
      ...transport.info?.(),
    }),
    supports: (capability) =>
      [
        "browser-session",
        "credentialed-http",
        "credentialed-http-body",
        "same-origin-page-http",
      ].includes(capability),
    lease: () =>
      available() ? "held" : released ? "released" : "disconnected",
    async browserLive() {
      return available() || endpointLive();
    },
    async release() {
      released = true;
      if (connecting) await connecting.catch(() => {});
      const current = browser;
      if (!current) {
        notifyStatusChange();
        return;
      }
      try {
        await transport.prepareLeaseRelease?.(current);
      } catch {
        // Release must continue even if the anchor was already closed.
      }
      try {
        await current.disconnect();
      } catch {
        // The disconnected listener handles an already-closed socket.
      }
      transport.dispose?.();
      log(`${transport.name} lease released`);
    },
    onLeaseReleaseRequest(listener) {
      leaseReleaseListeners.add(listener);
      return () => leaseReleaseListeners.delete(listener);
    },
    async acquire(progress = () => {}) {
      await ensureBrowser(progress);
    },
    start() {
      if (!transport.pollForConnection) return;
      if (endpointPoll) return;
      pollEndpoint();
      endpointPoll = setInterval(pollEndpoint, ENDPOINT_POLL_MS);
    },
    stop() {
      clearInterval(endpointPoll);
      endpointPoll = undefined;
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async findAuthGate(origin: string): Promise<AuthGate | undefined> {
      if (!browser?.connected) return undefined;
      for (const [page, kept] of keptGates) {
        if (page.isClosed()) {
          keptGates.delete(page);
          continue;
        }
        if (urlOrigin(kept.target) !== origin) continue;
        if (sameGatePlace(page.url(), kept.keptUrl)) {
          return { url: page.url(), target: kept.target };
        }
      }
      return undefined;
    },
    /**
     * Cookie fetch in a same-origin document. If no controlled page matches,
     * use a temporary page and close it in all outcomes. This method never
     * acquires Chrome: cache hits and credential-free host fetches do not call
     * it, and an unavailable browser remains a cheap miss.
     */
    async httpFetch(request: BackendHttpRequest) {
      if (!browser?.connected) return undefined;
      const origin = urlOrigin(request.url);
      const pages = await browser.pages();
      let page = pages.find(
        (candidate) => !candidate.isClosed() && urlOrigin(candidate.url()) === origin
      );
      let created = false;
      if (!page) {
        try {
          page = await browser.newPage({ background: true });
          created = true;
          await settle(
            page.goto(`${origin}/`, { waitUntil: "load", timeout: 15_000 })
          );
        } catch {
          if (created && page) {
            try {
              await transport.preparePageRelease?.(
                browser,
                page,
                "close-if-created",
                true
              );
              await page.close();
            } catch {
              // The tab may already be gone.
            }
          }
          return undefined;
        }
      }
      try {
        const result = await page.evaluate(
          async (req: BackendHttpRequest & { maxBodyChars: number }) => {
            const headers = { ...req.headers };
            let body: BodyInit | undefined;
            if (req.body?.kind === "json" || req.body?.kind === "text") {
              body = req.body.value;
              const hasContentType = Object.keys(headers).some(
                (name) => name.toLowerCase() === "content-type"
              );
              if (!hasContentType) {
                headers["content-type"] = req.body.kind === "json"
                  ? "application/json"
                  : "text/plain;charset=UTF-8";
              }
            } else if (req.body?.kind === "search") {
              body = new URLSearchParams(req.body.entries);
            } else if (req.body?.kind === "form") {
              const form = new FormData();
              for (const [name, value] of req.body.entries) form.append(name, value);
              body = form;
            }
            const res = await fetch(req.url, {
              method: req.method,
              headers,
              body,
              credentials: "include",
              redirect: "follow",
            });
            const text = await res.text();
            return { url: res.url, status: res.status, body: text.slice(0, req.maxBodyChars) };
          },
          { ...request, maxBodyChars: MAX_BODY_BYTES }
        );
        return {
          url: result.url || request.url,
          method: request.method,
          status: result.status,
          body: result.body,
          timestamp: Date.now(),
        };
      } finally {
        if (created) {
          try {
            await transport.preparePageRelease?.(
              browser,
              page,
              "close-if-created",
              true
            );
            await page.close();
          } catch {
            // The user may close the temporary tab.
          }
        }
      }
    },
    async bind(request: BindRequest) {
      const current = await ensureBrowser(() => {});
      const existing = await findPage(current, request.target);
      if (existing) {
        const state =
          request.navigation === "fresh"
            ? (await reloadPage(existing, request.loadTimeoutMs),
              captures(existing))
            : captures(existing);
        const session = makeSession(
          existing,
          false,
          request.navigation === "fresh",
          request.target,
          request.loadTimeoutMs
        );
        session.captures = state;
        return session;
      }
      const page = await current.newPage({ background: true });
      resetCaptures(page);
      await settle(
        page.goto(request.target, {
          waitUntil: "load",
          timeout: request.loadTimeoutMs,
        })
      );
      return makeSession(page, true, true, request.target, request.loadTimeoutMs);
    },
    async finish(
      session: BrowserSession,
      disposition: FinishDisposition
    ): Promise<void> {
      const cdpSession = session as CdpSession;
      cdpSession.closed = true;
      cdpSession.stopRecordingState();
      wakeCaptureWaiters(cdpSession.captures);
      if (browser?.connected) {
        try {
          await transport.preparePageRelease?.(
            browser,
            cdpSession.page,
            disposition,
            cdpSession.created && disposition !== "keep"
          );
        } catch {
          // Cleanup must not replace the lens result.
        }
      }
      if (disposition === "keep" && !cdpSession.page.isClosed()) {
        keptGates.set(cdpSession.page, {
          target: cdpSession.target,
          keptUrl: cdpSession.page.url(),
        });
        try {
          // The page was opened in the background, so without this the
          // sign-in page sits unseen behind whatever the user is doing.
          await cdpSession.page.bringToFront();
        } catch {
          // The user may close the page while its call is still running.
        }
      }
      if (!cdpSession.created || disposition === "keep") return;
      try {
        await cdpSession.page.close();
      } catch {
        // The user may close the page while its call is still running.
      }
    },
  };
}

function assertOpen(session: CdpSession): void {
  if (session.closed) throw new Error(`browser session ${session.id} is closed`);
}

/**
 * Run perform steps in order, stopping at the first failure. The in-page
 * primitives are the same page functions the extension injects, so both
 * backends act identically. A throw inside a step (e.g. a click that
 * navigates the page away mid-evaluation) fails that step, not the session.
 */
async function performSteps(
  page: Page,
  steps: PerformStep[],
  navigateFresh: () => Promise<void>
): Promise<PerformResult> {
  for (const [index, step] of steps.entries()) {
    let failure: string | undefined;
    try {
      failure = await performStep(page, step, navigateFresh);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      return { failedStep: index, message: failure, ...(await pagePlace(page)) };
    }
  }
  return pagePlace(page);
}

/** One step; a string is the failure message, undefined is success. */
async function performStep(
  page: Page,
  step: PerformStep,
  navigateFresh: () => Promise<void>
): Promise<string | undefined> {
  if ("fill" in step) {
    const outcome = await page.evaluate(pagePerformFill, {
      selector: step.fill,
      value: step.value,
    });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("click" in step) {
    const outcome = await page.evaluate(pagePerformClick, { selector: step.click });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("submit" in step) {
    const outcome = await page.evaluate(pagePerformSubmit, {
      selector: step.submit,
      form: step.form,
    });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("press" in step) {
    const outcome = await page.evaluate(pagePerformPress, { key: step.press });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("wait" in step) {
    return performWait(step.wait, (selector) =>
      page.evaluate(pagePerformCount, { selector })
    );
  }
  await navigateFresh();
  return undefined;
}

/**
 * Host-side wait polling over the shared pagePerformCount probe: `appears` is
 * count ≥ 1, `gone` is count = 0, `increases` is count > the baseline sampled
 * once at step entry. A probe that throws mid-navigation counts as "not yet",
 * not as a failure — the condition gets the full timeout to come true.
 */
async function performWait(
  wait: PerformWait,
  count: (selector: string) => Promise<number>,
  pollMs = PERFORM_POLL_MS
): Promise<string | undefined> {
  const form = wait.appears !== undefined ? "appears" : wait.gone !== undefined ? "gone" : "increases";
  const selector = wait.appears ?? wait.gone ?? wait.increases;
  if (selector === undefined) return "wait step names no selector";
  const timeoutMs = wait.timeoutMs ?? PERFORM_WAIT_DEFAULT_MS;
  const deadline = Date.now() + timeoutMs;
  const probe = async (): Promise<number | undefined> => {
    try {
      return await count(selector);
    } catch {
      return undefined;
    }
  };
  let baseline = 0;
  if (form === "increases") {
    const sampled = await probe();
    if (sampled === undefined) return `wait increases "${selector}" could not sample its baseline`;
    baseline = sampled;
  }
  for (;;) {
    const matches = await probe();
    if (matches !== undefined) {
      if (form === "appears" && matches >= 1) return undefined;
      if (form === "gone" && matches === 0) return undefined;
      if (form === "increases" && matches > baseline) return undefined;
    }
    if (Date.now() >= deadline) {
      return `wait ${form} "${selector}" timed out after ${timeoutMs}ms`;
    }
    await delay(pollMs);
  }
}

async function pagePlace(page: Page): Promise<{ url: string; title: string }> {
  try {
    return { url: page.url(), title: await page.title() };
  } catch {
    return { url: page.url(), title: "" };
  }
}

async function settle(action: Promise<unknown>): Promise<void> {
  await action;
  await delay(LOAD_GRACE_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptWithTimeout(
  connect: Promise<Browser>,
  timeoutMs: number
): Promise<Browser> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`connect attempt timed out after ${timeoutMs}ms`));
      connect.then((late) => void late.disconnect()).catch(() => {});
    }, timeoutMs);
    connect.then(
      (connected) => {
        clearTimeout(timer);
        resolve(connected);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function findPage(
  browser: Browser,
  target: string
): Promise<Page | undefined> {
  const pages = await browser.pages();
  return pages.find((page) => sameTarget(page.url(), target));
}

export function createDirectCdpTransport(
  probeEndpoint?: () => Promise<boolean>
): CdpTransport {
  const endpointPath = join(defaultChromeUserDataDir(), "DevToolsActivePort");
  const looksReady = () => existsSync(endpointPath);
  const probeLive =
    probeEndpoint ??
    (async (): Promise<boolean> => {
      let endpointPort: number;
      try {
        const [first] = readFileSync(endpointPath, "utf8").split("\n");
        endpointPort = Number(first);
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(endpointPort) || endpointPort < 1) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${endpointPort}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    });
  return {
    name: "cdp",
    pollForConnection: true,
    retryConnect: true,
    looksReady,
    probeLive,
    connectHint: () =>
      "connecting to Chrome (a permission dialog may appear — click Allow)",
    staleHint: () => STALE_ENDPOINT_MESSAGE,
    async connect() {
      return puppeteer.connect({ channel: "chrome", defaultViewport: null });
    },
  };
}
