/**
 * CDP browser backend: owns Chrome connection and page mechanics only.
 * Lens orchestration, caching, retries, and result policy live in the broker.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { defaultChromeUserDataDir } from "./chrome-paths.js";
import { showAuthBanner } from "./auth-banner.js";
import { raiseChrome } from "./launch-browser.js";
import {
  createCaptureBuffer,
  pageDomExtract,
  pagePerformClick,
  pagePerformCount,
  pagePerformDrop,
  pagePerformDropChunk,
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
  TabChoice,
} from "./browser-backend.js";
import { AuthPageUnavailable, TabClosed, TabDisconnected } from "./browser-backend.js";
import type { TabLink } from "./playwright-relay/browser-model.js";

/** A lens `ready` selector, plus the call's needs-the-user test that also ends the wait. */
interface ReadyCheck {
  selector: string;
  needsUser?: BindRequest["holdAt"];
}

function readyCheck(request: BindRequest): ReadyCheck | undefined {
  return request.ready ? { selector: request.ready, needsUser: request.holdAt } : undefined;
}

const MAX_BODY_BYTES = 512 * 1024;
const LOAD_GRACE_MS = 500;
/** Upper bound on waiting for an in-page app to settle after a load or route. */
const IN_PAGE_SETTLE_MS = 10_000;
const URL_POLL_MS = 250;
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
  /** Poll DevToolsActivePort (or equivalent) and auto-connect. Off for the Playwright Extension relay. */
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
  /** Add a short entry to a transport-owned status page, when present. */
  recordEvent?(message: string): void;
  /** Actionable status after an unexpected live connection loss. */
  disconnectHint?(): string;
  /** Transport cleanup before the browser lease is disconnected. */
  prepareLeaseRelease?(browser: Browser): Promise<void>;
  /**
   * A tab identity that lasts as long as the tab (a Chrome tab id, or a CDP
   * target id), when the transport can name one.
   */
  tabKey?(page: Page): string | undefined;
  /**
   * Where a keyed tab stands: attached, detached but still in the
   * transport's group, out of the group, or closed. Undefined when unknown.
   */
  tabLink?(key: string): TabLink | undefined;
  /** One attempt to re-attach a detached tab still in the group; never one outside it. */
  reattach?(key: string): Promise<TabLink | undefined>;
  onTabLinkChange?(listener: (key: string, link: TabLink) => void): () => void;
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

interface KeptGate {
  /** The tab's latest page object, replaced when the debugger re-attaches the tab. */
  page?: Page;
  target: string;
  keptUrl: string;
  lastMoveUrl?: string;
  /**
   * Recorded because a call found the tab detached, not because a lens
   * reported needs_*: it blocks the site only while a call waits on it.
   */
  detached?: boolean;
}

interface CdpSession extends BrowserSession {
  page: Page;
  target: string;
  captures: CaptureBuffer;
  closed: boolean;
  /** Bound by tab id or `tab: "reuse"`: the tab outlives the call, whoever created it. */
  pinned: boolean;
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
   * Tabs kept by a needs_* outcome, and where they were kept, by tab key
   * (gateKeyOf): a tab's page object is replaced when the debugger
   * re-attaches it. The map dies with the process: neither CDP transport has
   * durable tab leases.
   */
  const keptGates = new Map<string, KeptGate>();
  const pageGateKeys = new WeakMap<Page, string>();
  let pageGateSequence = 0;
  const watchedGateOrigins = new Set<string>();
  /** Broker tab ids: issued on first bind, valid while the page stays open. */
  const tabIds = new WeakMap<Page, string>();
  const tabsById = new Map<string, Page>();
  /** `tab: "reuse"`: the tab each origin used last, and its durable key. */
  const reuseTabs = new Map<string, Page>();
  const reuseKeys = new Map<string, string>();

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
      log(`${transport.name} disconnected${released ? " (lease released)" : ""}`);
      browser = undefined;
      browserVersion = "";
      endpointPresent = false;
      // Pages from a lost connection are never usable again; durable ids are
      // re-found by key on the next connection.
      tabsById.clear();
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
   * Broker tab ids: `t` + the transport's tab key, so an id names the same tab
   * for the tab's life. A tab without a key gets no id: a made-up one could
   * collide with a real tab's.
   */
  function tabIdFor(page: Page): string | undefined {
    let id = tabIds.get(page);
    if (!id) {
      const key = transport.tabKey?.(page);
      if (key === undefined) return undefined;
      id = `t${key}`;
      registerTab(page, id);
    }
    return id;
  }

  /** Index a tab by id until it closes, so a long-lived broker holds no closed pages. */
  function registerTab(page: Page, id: string): void {
    tabIds.set(page, id);
    tabsById.set(id, page);
    page.on("close", () => {
      if (tabsById.get(id) === page) tabsById.delete(id);
    });
  }

  /** Open, and reached through the connection this backend holds now. */
  function usable(page: Page | undefined, current: Browser): page is Page {
    return !!page && !page.isClosed() && page.browser() === current;
  }

  /** A keptGates key: the transport's tab key, or a per-page stand-in when it has none. */
  function gateKeyOf(page: Page): string {
    const key = transport.tabKey?.(page);
    if (key !== undefined) return key;
    let local = pageGateKeys.get(page);
    if (!local) {
      local = `page-${++pageGateSequence}`;
      pageGateKeys.set(page, local);
    }
    return local;
  }

  /** The sign-in gate a needs_* outcome kept on this page's tab. */
  function keptGate(page: Page): KeptGate | undefined {
    const kept = keptGates.get(gateKeyOf(page));
    return kept && !kept.detached ? kept : undefined;
  }

  /** A kept gate's tab: its live page, "detached" while the group still holds it, or undefined once gone. */
  async function gatePage(current: Browser, key: string, kept: KeptGate): Promise<Page | "detached" | undefined> {
    if (kept.page && !kept.page.isClosed()) return kept.page;
    const found = await pageForKey(current, key);
    if (found) {
      kept.page = found;
      return found;
    }
    return transport.tabLink?.(key)?.state === "disconnected" ? "detached" : undefined;
  }

  /**
   * The live page for a keyed tab. A tab the debugger lost while it stays in
   * the group (see TabDisconnected) is never forgotten: it gets one re-attach
   * attempt, and if that fails it throws TabDisconnected and is recorded as a
   * sign-in gate, so the auth wait watches it instead of opening another tab.
   * Undefined means the tab is closed or out of the group.
   */
  async function recoverTab(
    current: Browser,
    key: string,
    target: string | undefined,
    lastPage?: Page
  ): Promise<Page | undefined> {
    const live = await pageForKey(current, key);
    if (live) return live;
    const link = transport.tabLink?.(key);
    if (link?.state !== "disconnected") return undefined;
    const after = (await transport.reattach?.(key)) ?? link;
    if (after.state === "connected") {
      const page = await awaitPageForKey(current, key);
      if (page) return page;
    } else if (after.state !== "disconnected") {
      return undefined;
    }
    const id = `t${key}`;
    const kept = keptGates.get(key);
    const url = kept?.page?.url() ?? lastPage?.url() ?? target ?? "about:blank";
    if (!kept) keptGates.set(key, { page: lastPage, target: target ?? url, keptUrl: url, detached: true });
    log(`tab ${id} is detached from the debugger: ${after.lastError ?? "waiting for it to re-attach"}`);
    throw new TabDisconnected(id, url, after.lastError);
  }

  /** Puppeteer hears of a re-attached tab over the relay socket, a moment after the relay attaches it. */
  async function awaitPageForKey(current: Browser, key: string, timeoutMs = 5_000): Promise<Page | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const page = await pageForKey(current, key);
      if (page || Date.now() >= deadline) return page;
      await delay(50);
    }
  }

  function closedMessage(id: string, key: string | undefined): string {
    if (!transport.tabLink) return `tab ${id} is closed`;
    const state = key === undefined ? undefined : transport.tabLink(key)?.state;
    if (state === "closed") return `tab ${id} was closed`;
    if (state === "removed") return `tab ${id} is no longer in the Lenses tab group`;
    return `tab ${id} is closed or no longer in the Lenses tab group`;
  }

  function rememberReuse(origin: string, page: Page): void {
    reuseTabs.set(origin, page);
    const key = transport.tabKey?.(page);
    if (key !== undefined) reuseKeys.set(origin, key);
  }

  /**
   * The live page for a tab key, among the tabs this connection sees (with
   * the extension, the tabs in its group). A tab's page object does not
   * outlive a document swap the debugger re-attaches across (a forced full
   * navigation after sign-in), so the tab is looked up by key, not by object.
   * A tab outside the group is never pulled back in.
   */
  async function pageForKey(current: Browser, key: string): Promise<Page | undefined> {
    if (!transport.tabKey) return undefined;
    for (const page of await current.pages()) {
      if (usable(page, current) && transport.tabKey(page) === key) return page;
    }
    return undefined;
  }

  /**
   * The tab a call names (explicit id) or reuses (`tab: "reuse"`). Undefined
   * means the ordinary exact-URL-or-new-tab binding applies.
   */
  async function chooseTab(current: Browser, request: TabChoice & { target?: string }): Promise<Page | undefined> {
    if (request.tab !== undefined) {
      const known = tabsById.get(request.tab);
      if (usable(known, current)) return known;
      tabsById.delete(request.tab);
      const key = request.tab.startsWith("t") ? request.tab.slice(1) : undefined;
      const found = key !== undefined ? await recoverTab(current, key, request.target, known) : undefined;
      if (found) {
        registerTab(found, request.tab);
        return found;
      }
      throw new TabClosed(closedMessage(request.tab, key));
    }
    if (!request.reuse || request.target === undefined) return undefined;
    const origin = urlOrigin(request.target);
    const last = reuseTabs.get(origin);
    if (usable(last, current) && sameSite(last.url(), origin)) return last;
    const recorded = reuseKeys.get(origin);
    if (recorded !== undefined) {
      const found = await recoverTab(current, recorded, request.target, last);
      // A sign-out moves the tab to the site's own logout page on a sibling
      // host; that is still this site's tab, and loading the lens URL in it
      // beats leaving it behind and opening another.
      if (found && sameSite(found.url(), origin)) {
        log(`reuse ${origin}: tab ${recorded} ${found === last ? "" : "re-found "}at ${found.url()}`);
        rememberReuse(origin, found);
        return found;
      }
      log(`reuse ${origin}: tab ${recorded} ${found ? `left the site (${found.url()})` : "is gone"}; forgetting it`);
      // The tab is closed, out of the group, or the user took it elsewhere:
      // forget it rather than hijack it.
      reuseKeys.delete(origin);
    }
    // Adopt an open tab on the origin, preferring the user's sign-in tab.
    const candidates = (await current.pages()).filter(
      (page) => !page.isClosed() && urlOrigin(page.url()) === origin
    );
    const found =
      candidates.find((page) => keptGate(page) !== undefined) ??
      candidates.find((page) => sameTarget(page.url(), request.target!)) ??
      candidates[0];
    if (found) {
      log(`reuse ${origin}: adopting open tab at ${found.url()}`);
      rememberReuse(origin, found);
    } else {
      log(`reuse ${origin}: no open tab; a new one will be opened`);
    }
    return found;
  }

  /**
   * `navigate: "in-page"`: change the route the way the app's own links do,
   * so in-memory session state survives. Cross-origin targets cannot be
   * reached in-page and load normally.
   */
  async function routeInPage(
    page: Page,
    target: string,
    loadTimeoutMs: number,
    ready?: ReadyCheck
  ): Promise<void> {
    if (urlOrigin(page.url()) !== urlOrigin(target)) {
      resetCaptures(page);
      await settle(page.goto(target, { waitUntil: "load", timeout: loadTimeoutMs }));
      await settleApp(page, loadTimeoutMs, ready);
      return;
    }
    resetCaptures(page);
    const url = new URL(target);
    await page.evaluate((path: string) => {
      history.pushState(history.state, "", path);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, url.pathname + url.search + url.hash);
    await settleApp(page, loadTimeoutMs, ready);
  }

  /**
   * An app that routes in-page also boots in-page: after `load` it may still
   * be fetching, or show a transient screen and redirect. With a lens `ready`
   * selector, wait for it (or for a page that needs the user); otherwise wait
   * for the app's requests to go quiet.
   */
  async function settleApp(page: Page, loadTimeoutMs: number, ready?: ReadyCheck): Promise<void> {
    const deadline = Date.now() + Math.min(loadTimeoutMs, IN_PAGE_SETTLE_MS);
    if (ready) {
      await awaitReady(page, ready, deadline);
      return;
    }
    await page
      .waitForNetworkIdle({ idleTime: LOAD_GRACE_MS, timeout: Math.max(0, deadline - Date.now()) })
      .catch(() => {});
  }

  async function settleReady(page: Page, request: BindRequest): Promise<void> {
    const ready = readyCheck(request);
    if (ready) await settleApp(page, request.loadTimeoutMs, ready);
  }

  async function awaitReady(page: Page, ready: ReadyCheck, deadline: number): Promise<void> {
    while (!page.isClosed()) {
      const matched = await page
        .evaluate((selector: string) => document.querySelector(selector) !== null, ready.selector)
        .catch(() => false);
      if (matched) return;
      const title = await page.title().catch(() => "");
      if (await ready.needsUser?.({ url: page.url(), title }).catch(() => false)) {
        log(`ready: ${page.url()} needs the user`);
        return;
      }
      if (Date.now() >= deadline) {
        log(`ready: ${ready.selector} did not appear at ${page.url()}`);
        return;
      }
      await delay(URL_POLL_MS);
    }
  }

  /**
   * Serve a `navigate: "fresh"` step: reload when the tab is still on the
   * lens's origin, otherwise go back to the lens URL (an earlier step may
   * have taken the tab elsewhere).
   */
  async function navigateFresh(
    page: Page,
    target: string,
    loadTimeoutMs: number,
    inPage = false
  ): Promise<void> {
    if (inPage) {
      await routeInPage(page, target, loadTimeoutMs);
      return;
    }
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
    loadTimeoutMs: number,
    atAuthGate?: boolean,
    { pinned = false, inPage = false }: { pinned?: boolean; inPage?: boolean } = {}
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
      tab: tabIdFor(page),
      created,
      navigated,
      atAuthGate,
      page,
      target,
      captures: captures(page),
      closed: false,
      pinned,
      stopRecordingState: () => {
        page.off?.("request", navigationStarted);
        page.off?.("load", loaded);
      },
      async reload(loadTimeoutMs) {
        assertOpen(session);
        if (inPage) await routeInPage(page, target, loadTimeoutMs);
        else await reloadPage(page, loadTimeoutMs);
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
          navigateFresh(page, target, loadTimeoutMs, inPage)
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
    async openAuthGate(origin: string, target: string): Promise<boolean> {
      if (!browser?.connected || urlOrigin(target) !== origin) return false;
      const existing = await this.findAuthGate(origin);
      if (existing) return true;
      // A sign-in tab the debugger lost is still the user's sign-in tab.
      for (const [key, kept] of keptGates) {
        if (urlOrigin(kept.target) === origin && await gatePage(browser, key, kept) === "detached") return true;
      }
      // An origin with a reused tab signs in there: it is the tab later calls
      // will run in.
      const recorded = reuseKeys.get(origin);
      if (recorded !== undefined) {
        const reused = await pageForKey(browser, recorded);
        if (reused && sameSite(reused.url(), origin)) {
          keptGates.set(recorded, { page: reused, target, keptUrl: reused.url() });
          await reused.bringToFront().catch(() => {});
          await raiseChrome();
          return true;
        }
        if (!reused && transport.tabLink?.(recorded)?.state === "disconnected") {
          keptGates.set(recorded, { page: reuseTabs.get(origin), target, keptUrl: target, detached: true });
          return true;
        }
      }
      let page: Page | undefined;
      try {
        page = await browser.newPage({ background: true });
        await settle(page.goto(target, { waitUntil: "load", timeout: 15_000 }));
        keptGates.set(gateKeyOf(page), { page, target, keptUrl: page.url() });
        await page.bringToFront();
        await raiseChrome();
        return true;
      } catch {
        if (page) await page.close().catch(() => {});
        return false;
      }
    },
    async watchAuthGate(origin, onExit, resume = false) {
      const currentBrowser = browser;
      if (!currentBrowser?.connected) return undefined;
      let entry: { key: string; kept: KeptGate; page: Page | "detached" } | undefined;
      for (const [key, kept] of keptGates) {
        if (urlOrigin(kept.target) !== origin) continue;
        const page = await gatePage(currentBrowser, key, kept);
        if (page && (page === "detached" || resume || sameGatePlace(page.url(), kept.keptUrl))) {
          entry = { key, kept, page };
          break;
        }
      }
      if (!entry) return undefined;
      const { key, kept } = entry;
      watchedGateOrigins.add(origin);
      let disposed = false;
      let moveTimer: ReturnType<typeof setTimeout> | undefined;
      let mounted: { page: Page; prompt?: { update(expiresAt: number, count: number): void; dispose(): void }; unmount(): void } | undefined;
      const exit = (reason: "moved" | "closed") => { if (!disposed) onExit(reason); };
      // Chrome detaches the debugger from a tab while a password manager's
      // frame is in it (see TabDisconnected); the tab is still open in the
      // group, so the user is still signing in. Only a closed tab, or one
      // taken out of the group, ends the wait. A re-attached tab is retried
      // like any other move.
      const closed = () => {
        const state = transport.tabLink?.(key)?.state;
        mounted?.unmount();
        if (state === "disconnected") {
          log(`sign-in tab t${key} detached from the debugger; still waiting`);
          return;
        }
        exit(state === "connected" ? "moved" : "closed");
      };
      const unlisten = transport.onTabLinkChange?.((changed, link) => {
        if (changed !== key) return;
        if (link.state === "removed" || link.state === "closed") exit("closed");
        else if (link.state === "connected" && (!mounted || mounted.page.isClosed())) exit("moved");
      });
      const browserGone = () => exit("closed");
      currentBrowser.on("disconnected", browserGone);
      if (entry.page !== "detached") {
        const page = entry.page;
        // Track movement from this watch's starting page, not the original gate.
        // The latter must remain fixed so a completed login stops matching.
        const watchUrl = page.url();
        // A move only asks for another lens attempt; an intermediate sign-in
        // step may still return needs_auth and must keep using this same tab.
        const moved = (frame: { url(): string }) => {
          if (frame !== page.mainFrame() || disposed) return;
          clearTimeout(moveTimer);
          if (urlOrigin(page.url()) !== origin || sameGatePlace(page.url(), watchUrl)) return;
          moveTimer = setTimeout(() => {
            if (disposed || urlOrigin(page.url()) !== origin ||
                sameGatePlace(page.url(), watchUrl)) return;
            kept.lastMoveUrl = page.url();
            onExit("moved");
          }, 750);
        };
        page.on("framenavigated", moved);
        page.on("close", closed);
        const current: NonNullable<typeof mounted> = {
          page,
          unmount() {
            clearTimeout(moveTimer);
            page.off("framenavigated", moved);
            page.off("close", closed);
            current.prompt?.dispose();
            if (mounted === current) mounted = undefined;
          },
        };
        mounted = current;
        const prompt = await showAuthBanner(page, new URL(origin).hostname);
        if (mounted === current) current.prompt = prompt;
        else prompt.dispose();
        // Navigation may have continued while a previous attempt was running.
        // Retry that new location rather than waiting for a second navigation.
        const movedWhileRetrying = urlOrigin(page.url()) === origin && (
          !sameGatePlace(page.url(), watchUrl) ||
          (kept.lastMoveUrl !== undefined && !sameGatePlace(page.url(), kept.lastMoveUrl))
        );
        if (movedWhileRetrying) queueMicrotask(() => {
          if (!disposed) { kept.lastMoveUrl = page.url(); onExit("moved"); }
        });
      } else {
        // The link may have changed while this watch was being set up.
        const state = transport.tabLink?.(key)?.state;
        if (state !== "disconnected") queueMicrotask(() => exit(state === "connected" ? "moved" : "closed"));
      }
      return {
        update(expiresAt, count) {
          mounted?.prompt?.update(expiresAt, count);
        },
        dispose() {
          disposed = true;
          clearTimeout(moveTimer);
          watchedGateOrigins.delete(origin);
          mounted?.unmount();
          unlisten?.();
          currentBrowser.off("disconnected", browserGone);
        },
      };
    },
    async hasOpenTarget(target: string, choice: TabChoice = {}): Promise<boolean> {
      if (!browser?.connected) return false;
      try {
        if (await chooseTab(browser, { ...choice, target })) return true;
      } catch (error) {
        if (error instanceof TabClosed) return false;
        throw error;
      }
      if (await findPage(browser, target)) return true;
      // A kept sign-in tab the debugger lost gets its one re-attach attempt
      // per check too; TabDisconnected reports it still detached.
      for (const [key, kept] of keptGates) {
        if (urlOrigin(kept.target) !== urlOrigin(target)) continue;
        if (await gatePage(browser, key, kept) !== "detached") continue;
        await recoverTab(browser, key, kept.target, kept.page);
        return !!await findPage(browser, target);
      }
      return false;
    },
    async findAuthGate(origin: string): Promise<AuthGate | undefined> {
      if (!browser?.connected) return undefined;
      const watched = watchedGateOrigins.has(origin);
      for (const [key, kept] of keptGates) {
        const page = await gatePage(browser, key, kept);
        if (!page) {
          keptGates.delete(key);
          continue;
        }
        if (urlOrigin(kept.target) !== origin) continue;
        // A detached tab blocks the site only while a call waits on it; a
        // fresh call should instead try to re-attach it.
        if (page === "detached" || kept.detached) {
          if (watched) return { url: page === "detached" ? kept.page?.url() ?? kept.keptUrl : page.url(), target: kept.target };
          continue;
        }
        if (sameGatePlace(page.url(), kept.keptUrl) || watched) {
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
        if (request.existingOnly) return undefined;
        try {
          page = await browser.newPage({ background: true });
          created = true;
          transport.recordEvent?.("HTTP tab opened");
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
              transport.recordEvent?.("HTTP tab closed");
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
            transport.recordEvent?.("HTTP tab closed");
          } catch {
            // The user may close the temporary tab.
          }
        }
      }
    },
    async bind(request: BindRequest) {
      const current = await ensureBrowser(() => {});
      const chosen = await chooseTab(current, request);
      if (chosen) {
        const kept = keptGate(chosen);
        const atAuthGate = request.existingOnly
          ? !kept || sameGatePlace(chosen.url(), kept.keptUrl)
          : undefined;
        if (atAuthGate === false) resetCaptures(chosen);
        const target = request.target ?? chosen.url();
        let navigated = false;
        // A tab part-way through signing in stays put; so does an auth retry,
        // which reads the tab wherever sign-in has taken it.
        const held = request.target !== undefined && !request.existingOnly && request.holdAt
          ? await request.holdAt({ url: chosen.url(), title: await chosen.title().catch(() => "") })
              .catch(() => false)
          : false;
        if (held) log(`holding tab at ${chosen.url()}: it is part-way through sign-in`);
        if (request.target !== undefined && !request.existingOnly && !held) {
          const ready = readyCheck(request);
          if (!sameTarget(chosen.url(), target)) {
            if (request.inPage) await routeInPage(chosen, target, request.loadTimeoutMs, ready);
            else {
              resetCaptures(chosen);
              await settle(chosen.goto(target, { waitUntil: "load", timeout: request.loadTimeoutMs }));
              if (ready) await settleApp(chosen, request.loadTimeoutMs, ready);
            }
            navigated = true;
          } else if (request.navigation === "fresh" && !request.inPage) {
            await reloadPage(chosen, request.loadTimeoutMs);
            if (ready) await settleApp(chosen, request.loadTimeoutMs, ready);
            navigated = true;
          }
        }
        return makeSession(chosen, false, navigated, target, request.loadTimeoutMs, atAuthGate, {
          pinned: true,
          inPage: request.inPage,
        });
      }
      if (request.target === undefined) throw new Error("bind needs a target or a tab");
      const existing = await findPage(current, request.target);
      if (existing) {
        const kept = keptGate(existing);
        // A retry that has left the original sign-in place must not resolve
        // against responses captured before login (even if they match first).
        const atAuthGate = request.existingOnly
          ? !kept || sameGatePlace(existing.url(), kept.keptUrl)
          : undefined;
        if (atAuthGate === false) resetCaptures(existing);
        const state =
          request.navigation === "fresh"
            ? (await reloadPage(existing, request.loadTimeoutMs),
              await settleReady(existing, request),
              captures(existing))
            : captures(existing);
        const session = makeSession(
          existing,
          false,
          request.navigation === "fresh",
          request.target,
          request.loadTimeoutMs,
          atAuthGate
        );
        session.captures = state;
        return session;
      }
      if (request.existingOnly) throw new AuthPageUnavailable("auth retry has no open target tab");
      const page = await current.newPage({ background: true });
      transport.recordEvent?.("Call tab opened");
      resetCaptures(page);
      // Register before loading: a slow sign-in redirect must not orphan the tab.
      if (request.reuse) rememberReuse(urlOrigin(request.target), page);
      await settle(
        page.goto(request.target, {
          waitUntil: "load",
          timeout: request.loadTimeoutMs,
        })
      );
      const ready = readyCheck(request);
      if (request.inPage || ready) await settleApp(page, request.loadTimeoutMs, ready);
      return makeSession(page, true, true, request.target, request.loadTimeoutMs, undefined, {
        pinned: request.reuse === true,
        inPage: request.inPage,
      });
    },
    async finish(
      session: BrowserSession,
      disposition: FinishDisposition
    ): Promise<void> {
      const cdpSession = session as CdpSession;
      cdpSession.closed = true;
      cdpSession.stopRecordingState();
      wakeCaptureWaiters(cdpSession.captures);
      // A retry can still land on another login step. Keep the user's original
      // sign-in tab, not an extra tab created just to check authentication.
      if (disposition === "keep" && cdpSession.created && !cdpSession.pinned && [...keptGates].some(
        ([key, kept]) => key !== gateKeyOf(cdpSession.page) && !!kept.page && !kept.page.isClosed() &&
          urlOrigin(kept.target) === urlOrigin(cdpSession.target)
      )) disposition = "close-if-created";
      // A pinned tab (named by id, or an origin's reused tab) outlives every call.
      const closes = cdpSession.created && !cdpSession.pinned && disposition !== "keep";
      if (browser?.connected) {
        try {
          await transport.preparePageRelease?.(
            browser,
            cdpSession.page,
            disposition,
            closes
          );
        } catch {
          // Cleanup must not replace the lens result.
        }
      }
      if (disposition === "keep" && !cdpSession.page.isClosed()) {
        transport.recordEvent?.("Tab kept");
        keptGates.set(gateKeyOf(cdpSession.page), {
          page: cdpSession.page,
          target: cdpSession.target,
          keptUrl: cdpSession.page.url(),
        });
        try {
          // The page was opened in the background, so without this the
          // sign-in page sits unseen behind whatever the user is doing.
          await cdpSession.page.bringToFront();
          await raiseChrome();
        } catch {
          // The user may close the page while its call is still running.
        }
      }
      if (!closes) return;
      try {
        await cdpSession.page.close();
        transport.recordEvent?.("Call tab closed");
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
 * Run perform steps in order, stopping at the first failure. Both CDP
 * transports evaluate the same in-page primitives. A throw inside a step
 * (e.g. a click that navigates the page away mid-evaluation) fails that
 * step, not the session.
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
  if ("drop" in step) {
    return performDrop(page, step);
  }
  if ("wait" in step) {
    return performWait(step.wait, (selector) =>
      page.evaluate(pagePerformCount, { selector })
    );
  }
  await navigateFresh();
  return undefined;
}

/** Raw bytes per staged chunk: a multiple of 3, so each chunk is whole base64 quads. */
const DROP_CHUNK_BYTES = 3 * 256 * 1024;

const DROP_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

/**
 * Read the caller's file and drop it onto the page. The bytes cross in
 * chunks so no single CDP message carries the whole file.
 */
async function performDrop(
  page: Page,
  step: { drop: string; file: string }
): Promise<string | undefined> {
  if (!isAbsolute(step.file)) return `drop file "${step.file}" must be an absolute path`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(step.file);
  } catch (error) {
    return `drop file "${step.file}" could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (let offset = 0; offset === 0 || offset < bytes.length; offset += DROP_CHUNK_BYTES) {
    await page.evaluate(pagePerformDropChunk, {
      chunk: bytes.subarray(offset, offset + DROP_CHUNK_BYTES).toString("base64"),
      first: offset === 0,
    });
  }
  const outcome = await page.evaluate(pagePerformDrop, {
    selector: step.drop,
    name: basename(step.file),
    type: DROP_TYPES[extname(step.file).toLowerCase()] ?? "application/octet-stream",
  });
  return outcome.ok ? undefined : outcome.message;
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

/**
 * Whether a URL is on the same site as an origin: the same registrable
 * domain, approximated without a public-suffix list as the last two labels,
 * or three under a two-letter country code with a generic second level
 * (co.uk, com.au). Enough to keep a bank's logout page (www.rbs.co.uk) with
 * its app (www.digitalbanking.rbs.co.uk) and tell both apart from elsewhere.
 */
export function sameSite(url: string, origin: string): boolean {
  const site = (value: string): string | undefined => {
    try {
      const { protocol, hostname } = new URL(value);
      if (protocol !== "https:" && protocol !== "http:") return undefined;
      const labels = hostname.split(".");
      const generic = /^(co|com|org|net|gov|ac|edu)$/;
      const keep = labels.length >= 3 && labels.at(-1)!.length === 2 && generic.test(labels.at(-2)!) ? 3 : 2;
      return labels.slice(-keep).join(".");
    } catch {
      return undefined;
    }
  };
  const a = site(url);
  return a !== undefined && a === site(origin);
}

/** Puppeteer keeps a target's CDP id internal; it is stable for the tab's life. */
export function pageTargetId(page: Page): string | undefined {
  try {
    const id = (page.target() as unknown as { _targetId?: unknown })._targetId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
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
    // Remote debugging sees every tab, and a target id lasts as long as its tab.
    tabKey: pageTargetId,
  };
}
