/**
 * CDP browser backend: owns Chrome connection and page mechanics only.
 * Lens orchestration, caching, retries, and result policy live in the broker.
 */
import type { Browser, Page } from "puppeteer-core";
import { clearAuthBanners, showAuthBanner } from "./auth-banner.js";
import { raiseChrome } from "./launch-browser.js";
import { createPageCaptures, MAX_BODY_BYTES } from "./page-captures.js";
import { createPageNavigation, delay, settle } from "./page-navigation.js";
import { performSteps } from "./perform-steps.js";
import {
  errorMessage,
  pageDomExtract,
  pageGuardDownloads,
  pageSnapshot,
  readCaptures,
  sameGatePlace,
  sameTarget,
  urlOrigin,
  wakeCaptureWaiters,
  type AuthGate,
  type CaptureBuffer,
} from "@notation/lenses-core";
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

/** How long a page stays stopped from saving files after a file lens call. */
const DOWNLOAD_GUARD_GRACE_MS = 5_000;
/** How often a sign-in wait tries to re-attach a tab a password manager's frame blocks. */
const SIGN_IN_RETRY_MS = 3_000;
/** How long a re-found tab gets to answer a trivial evaluate before it is attached afresh. */
const ANSWER_TIMEOUT_MS = 3_000;
const CONNECT_WINDOW_MS = 45_000;
const CONNECT_RETRY_MS = 2_000;
const CONNECT_ATTEMPT_MS = 10_000;
const ENDPOINT_POLL_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

export type CdpLease = "held" | "released" | "disconnected";

/**
 * How a CDP-backed backend reaches a browser. The Playwright Extension relay
 * and the Lenses app's relay both produce a Puppeteer `Browser`; page
 * sessions, intercepts, and auth-gate bookkeeping stay here.
 */
export interface CdpTransport {
  readonly name: string;
  /** Poll `looksReady` and auto-connect. Off for the Playwright Extension relay. */
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
  /**
   * Transport cleanup before the browser lease is disconnected. With
   * `handOver`, the broker is restarting: leave its tabs for the next one.
   */
  prepareLeaseRelease?(browser: Browser, options?: ReleaseOptions): Promise<void>;
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
  /** One attach attempt for a detached tab a sign-in wait is watching. */
  retryAttach?(key: string): Promise<TabLink | undefined>;
  /** Attach an attached tab afresh, when its debugger session stopped answering. */
  refreshAttach?(key: string): Promise<TabLink | undefined>;
  onTabLinkChange?(listener: (key: string, link: TabLink) => void): () => void;
  /**
   * Whether a sign-in wait paints the Lenses banner into the page. On unless
   * false: the Lenses app shows what the page needs in its own window.
   */
  readonly authBanner?: boolean;
  /** Open a background tab, for browsers whose CDP cannot create targets (Electron). */
  newPage?(browser: Browser): Promise<Page>;
  /**
   * The page needs the user (`need`: a needs_* outcome, e.g. needs_auth).
   * Defaults to bringing it to front in Chrome; the Lenses app puts it in
   * its inbox instead.
   */
  reveal?(page: Page, need: string): Promise<void>;
  /** A call on a page ended without needing the user: whatever it needed is done. */
  settled?(page: Page): void;
  /** Transport cleanup before a session or temporary page is released. */
  preparePageRelease?(
    browser: Browser,
    page: Page,
    disposition: FinishDisposition,
    releasePage: boolean
  ): Promise<void>;
  dispose?(): void;
}

export interface ReleaseOptions {
  /** The broker is restarting: leave its tabs for the next broker to adopt. */
  handOver?: boolean;
}

export interface CdpBackend extends BrowserBackend {
  lease(): CdpLease;
  /** Whether a browser is actually reachable: connected, or the transport's probe answers. */
  browserLive(): Promise<boolean>;
  release(options?: ReleaseOptions): Promise<void>;
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
  transport: CdpTransport
): CdpBackend {
  let browser: Browser | undefined;
  let browserVersion = "";
  let connecting: Promise<Browser> | undefined;
  let endpointPresent = false;
  let endpointProbing = false;
  let endpointPoll: ReturnType<typeof setInterval> | undefined;
  let released = false;
  let reconnectDelayMs = CONNECT_RETRY_MS;
  let nextReconnectAt = 0;
  let reconnectAttempts = 0;
  let lastConnectionError: string | undefined;
  let sessionSequence = 0;
  const statusListeners = new Set<() => void>();
  const leaseReleaseListeners = new Set<() => void>();
  /**
   * Tabs kept by a needs_* outcome, and where they were kept, by tab key
   * (gateKeyOf): a tab's page object is replaced when the debugger
   * re-attaches it. The map dies with the process: no CDP transport has
   * durable tab leases.
   */
  const keptGates = new Map<string, KeptGate>();
  const pageGateKeys = new WeakMap<Page, string>();
  /** When each detached sign-in tab last got a re-attach attempt. */
  const signInRetries = new Map<string, number>();
  let pageGateSequence = 0;
  const watchedGateOrigins = new Set<string>();
  /** Broker tab ids: issued on first bind, valid while the page stays open. */
  const tabIds = new WeakMap<Page, string>();
  const tabsById = new Map<string, Page>();
  /** `tab: "reuse"`: the tab each origin used last, and its durable key. */
  const reuseTabs = new Map<string, Page>();
  const reuseKeys = new Map<string, string>();

  const openPage = (current: Browser) =>
    transport.newPage ? transport.newPage(current) : current.newPage({ background: true });
  async function reveal(page: Page, need = "needs_auth"): Promise<void> {
    if (transport.reveal) return transport.reveal(page, need);
    await page.bringToFront();
    await raiseChrome();
  }

  const endpointAvailable = () => transport.looksReady();
  const endpointLive = () => transport.probeLive();
  const available = () => browser?.connected === true;
  const { limitCaptures, captures, resetCaptures } = createPageCaptures();
  const { reloadPage, routeInPage, settleReady, navigateFresh, navigateBound } =
    createPageNavigation(log, resetCaptures);
  const notifyStatusChange = () => {
    for (const listener of statusListeners) listener();
  };

  /**
   * Pages a file lens call has stopped from saving files, and a count of
   * guard changes so a late release cannot lift a newer call's guard.
   */
  const downloadGuards = new WeakMap<Page, number>();
  /** Pages bound by a file lens call, whose perform steps run guarded. */
  const guardWanted = new WeakSet<Page>();
  async function guardDownloads(page: Page, on: boolean): Promise<void> {
    downloadGuards.set(page, (downloadGuards.get(page) ?? 0) + 1);
    try {
      await page.evaluate(pageGuardDownloads, { on });
    } catch (error) {
      log(`could not ${on ? "stop" : "restore"} page downloads: ${errorMessage(error)}`);
    }
  }
  /**
   * A page saves after its request resolves, which is after the call has its
   * file, so the guard outlasts the call by DOWNLOAD_GUARD_GRACE_MS.
   */
  function releaseDownloadsLater(page: Page): void {
    const generation = downloadGuards.get(page);
    if (generation === undefined) return;
    setTimeout(() => {
      if (downloadGuards.get(page) !== generation || page.isClosed()) return;
      downloadGuards.delete(page);
      void page.evaluate(pageGuardDownloads, { on: false }).catch(() => {});
    }, DOWNLOAD_GUARD_GRACE_MS).unref?.();
  }
  async function prepareCall(page: Page, request: BindRequest): Promise<void> {
    limitCaptures(page, request);
    // Applied when the steps run: the page may still be about to load.
    if (request.blockDownloads) guardWanted.add(page);
    else guardWanted.delete(page);
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
    // A connection that works has no problem to report: drop any failure an
    // earlier attempt recorded, so clients stop seeing it in status.
    lastConnectionError = undefined;
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
    if (released || available() || connecting || endpointProbing) return;
    if (!fresh && Date.now() < nextReconnectAt) return;
    endpointProbing = true;
    void (async () => {
      try {
        // A dead endpoint found by background polling is absence, not a
        // connection error for clients to see. Only an explicit acquire
        // reports a stale endpoint, via connectBrowser's probe.
        if (!(await endpointLive())) return;
        nextReconnectAt = Date.now() + reconnectDelayMs;
        reconnectDelayMs = Math.min(
          reconnectDelayMs * 2,
          RECONNECT_BACKOFF_MAX_MS
        );
        await ensureBrowser(() => {});
      } catch (error) {
        log(
          `cdp connection failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        endpointProbing = false;
      }
    })();
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

  /**
   * A kept gate's tab: its live page, "detached" while the group still holds it, or undefined once gone.
   * A page from an earlier connection is not live, even if it never saw its tab close: it is re-found by key.
   */
  async function gatePage(current: Browser, key: string, kept: KeptGate): Promise<Page | "detached" | undefined> {
    if (usable(kept.page, current)) return kept.page;
    const found = await pageForKey(current, key);
    if (found) {
      kept.page = found;
      return found;
    }
    return transport.tabLink?.(key)?.state === "disconnected" ? "detached" : undefined;
  }

  /**
   * The live page for a keyed tab. A tab the debugger lost while it stays in
   * the group (see TabDisconnected) is never forgotten: it throws
   * TabDisconnected and is recorded as a sign-in gate, so the auth wait
   * watches it instead of opening another tab. Only the extension re-attaches
   * it (after a detach, or when its URL changes): the extension groups any
   * tab it attaches, so an attach from here could pull a tab the user dragged
   * out back in. Undefined means the tab is closed or out of the group.
   */
  async function recoverTab(
    current: Browser,
    key: string,
    target: string | undefined,
    lastPage?: Page
  ): Promise<Page | undefined> {
    const live = await pageForKey(current, key);
    if (live) return await answeringPage(current, key, live, target, lastPage);
    let link = transport.tabLink?.(key);
    // The extension retries only on a URL change, which a signed-in
    // single-page app may never make, so a sign-in wait retries too.
    const origin = urlOrigin(keptGates.get(key)?.target ?? target ?? "");
    if (link?.state === "disconnected" && watchedGateOrigins.has(origin) && transport.retryAttach) {
      const last = signInRetries.get(key) ?? 0;
      if (Date.now() - last >= SIGN_IN_RETRY_MS) {
        signInRetries.set(key, Date.now());
        link = (await transport.retryAttach(key)) ?? link;
      }
    }
    if (link?.state === "connected") {
      // Attached a moment ago; Puppeteer has not heard yet.
      const page = await awaitPageForKey(current, key);
      if (page) return await answeringPage(current, key, page, target, lastPage);
    } else if (link?.state !== "disconnected") {
      return undefined;
    }
    const id = `t${key}`;
    const kept = keptGates.get(key);
    const url = kept?.page?.url() ?? lastPage?.url() ?? target ?? "about:blank";
    if (!kept) keptGates.set(key, { page: lastPage, target: target ?? url, keptUrl: url, detached: true });
    log(`tab ${id} is detached from the debugger: ${link.lastError ?? "waiting for it to re-attach"}`);
    throw new TabDisconnected(id, url, link.lastError);
  }

  /**
   * A re-attached tab can come back with a debugger session that never
   * reports the page's JavaScript context (seen after a password manager's
   * frame blocked the attach mid sign-in), so every evaluate would hang.
   * Such a tab is attached afresh; if that attach is blocked too, it is
   * treated as detached, which a sign-in wait retries.
   */
  async function answeringPage(
    current: Browser,
    key: string,
    page: Page,
    target: string | undefined,
    lastPage: Page | undefined
  ): Promise<Page | undefined> {
    if (!transport.refreshAttach || (await answers(page))) return page;
    log(`tab t${key} does not answer; attaching it afresh`);
    const link = await transport.refreshAttach(key);
    if (link?.state === "connected") {
      const fresh = await awaitPageForKey(current, key);
      if (fresh && (await answers(fresh))) return fresh;
      log(`tab t${key} still does not answer after a fresh attach`);
      return fresh ?? page;
    }
    return await recoverTab(current, key, target, lastPage);
  }

  async function answers(page: Page): Promise<boolean> {
    return await Promise.race([
      page.evaluate(() => true).catch(() => false),
      delay(ANSWER_TIMEOUT_MS).then(() => false),
    ]);
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

  /**
   * Leave a detached sign-in tab behind: no gate, no reuse. The extension may
   * re-attach it later; until then the origin's calls open a tab of their own.
   */
  function forgetTab(origin: string, key: string): void {
    keptGates.delete(key);
    signInRetries.delete(key);
    if (reuseKeys.get(origin) === key) {
      reuseKeys.delete(origin);
      reuseTabs.delete(origin);
    }
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
   * For an auth retry, whether the tab is still at the sign-in place it was
   * kept at. A retry that has left that place must not resolve against
   * responses captured before login (even if they match first), so its
   * captures are reset.
   */
  function authGateState(page: Page, request: BindRequest): boolean | undefined {
    if (!request.existingOnly) return undefined;
    const kept = keptGate(page);
    const atAuthGate = !kept || sameGatePlace(page.url(), kept.keptUrl);
    if (!atAuthGate) resetCaptures(page);
    return atAuthGate;
  }

  async function closeCreated(page: Page): Promise<void> {
    try {
      if (browser) await transport.preparePageRelease?.(browser, page, "close-if-created", true);
      await page.close();
      transport.recordEvent?.("Call tab closed");
    } catch {
      // The user may already have closed the tab.
    }
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
        const guarded = guardWanted.has(page);
        if (guarded) await guardDownloads(page, true);
        return performSteps(page, steps, async () => {
          await navigateFresh(page, target, loadTimeoutMs, inPage);
          if (guarded) await guardDownloads(page, true);
        });
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
    async release(options = {}) {
      released = true;
      if (connecting) await connecting.catch(() => {});
      const current = browser;
      if (!current) {
        notifyStatusChange();
        return;
      }
      try {
        await transport.prepareLeaseRelease?.(current, options);
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
          // Shown by the wait that follows (watchAuthGate), not here.
          keptGates.set(recorded, { page: reused, target, keptUrl: reused.url() });
          return true;
        }
        if (!reused && transport.tabLink?.(recorded)?.state === "disconnected") {
          keptGates.set(recorded, { page: reuseTabs.get(origin), target, keptUrl: target, detached: true });
          return true;
        }
      }
      let page: Page | undefined;
      try {
        page = await openPage(browser);
        await settle(page.goto(target, { waitUntil: "load", timeout: 15_000 }));
        keptGates.set(gateKeyOf(page), { page, target, keptUrl: page.url() });
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
      // The banner's removal fails while the debugger is detached; clear it
      // from the re-attached page before the retry, which repaints if needed.
      const reattached = () => {
        void (async () => {
          const page = await awaitPageForKey(currentBrowser, key).catch(() => undefined);
          if (page) await clearAuthBanners(page);
          exit("moved");
        })();
      };
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
        if (state === "connected") reattached();
        else exit("closed");
      };
      const unlisten = transport.onTabLinkChange?.((changed, link) => {
        if (changed !== key) return;
        if (link.state === "removed" || link.state === "closed") exit("closed");
        else if (link.state === "connected" && (!mounted || mounted.page.isClosed())) reattached();
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
        if (transport.authBanner !== false) {
          const prompt = await showAuthBanner(page, new URL(origin).hostname, `__lens_auth_t${key}`);
          if (mounted === current) current.prompt = prompt;
          else prompt.dispose();
        }
        // The wait has begun on a tab that may sit behind other tabs and
        // windows (a gate kept by an earlier call). This is the only place
        // Chrome is raised: activate the tab first so the user lands on it.
        // Show it once per wait, not on a resumed retry; a browser that
        // refuses must not fail the call.
        if (!resume && !disposed) {
          try {
            await reveal(page);
          } catch (error) {
            log(`could not bring sign-in tab t${key} to the front: ${errorMessage(error)}`);
          }
        }
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
        if (state !== "disconnected") queueMicrotask(() => state === "connected" ? reattached() : exit("closed"));
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
          // A detached tab can show no banner and cannot be raised, so a later
          // wait on it would pass unseen. A wait that ends with the tab still
          // detached leaves it behind; the next call opens one the user sees.
          if (transport.tabLink?.(key)?.state === "disconnected") {
            log(`sign-in tab t${key} is still detached after the wait; the next call opens another`);
            forgetTab(origin, key);
          }
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
      // A kept sign-in tab the debugger lost is reported as still detached
      // (TabDisconnected), with the extension's last re-attach error.
      for (const [key, kept] of keptGates) {
        if (urlOrigin(kept.target) !== urlOrigin(target)) continue;
        if (await gatePage(browser, key, kept) !== "detached") continue;
        await recoverTab(browser, key, kept.target, kept.page);
        return !!await findPage(browser, target);
      }
      return false;
    },
    async findAuthGate(origin, needsUser) {
      if (!browser?.connected) return undefined;
      const current = browser;
      const watched = watchedGateOrigins.has(origin);
      for (const [key, kept] of keptGates) {
        const page = await gatePage(browser, key, kept);
        if (!page) {
          keptGates.delete(key);
          continue;
        }
        if (urlOrigin(kept.target) !== origin) continue;
        // A detached tab blocks the site only while a call waits on it; a
        // fresh call reports it detached itself, with the latest error.
        if (page === "detached" || kept.detached) {
          if (watched) return { url: page === "detached" ? kept.page?.url() ?? kept.keptUrl : page.url(), target: kept.target };
          continue;
        }
        if (sameGatePlace(page.url(), kept.keptUrl) || watched) {
          return { url: page.url(), target: kept.target };
        }
      }
      if (!needsUser) return undefined;
      // A tab the user is signing in on, though no call kept it: the site's
      // login form is open, and touching the tab (or fetching with the site's
      // cookies) can send the user back to its first step. Keep it as the
      // gate, so the wait watches it instead of opening another.
      for (const page of await current.pages()) {
        if (!usable(page, current) || urlOrigin(page.url()) !== origin) continue;
        const url = page.url();
        if (!(await needsUser({ url, title: "" }))) continue;
        keptGates.set(gateKeyOf(page), { page, target: url, keptUrl: url });
        return { url, target: url };
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
          page = await openPage(browser);
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
          { ...request, maxBodyChars: request.maxBodyBytes ?? MAX_BODY_BYTES }
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
        await prepareCall(chosen, request);
        const atAuthGate = authGateState(chosen, request);
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
          navigated = await navigateBound(chosen, target, request);
        }
        // Sign-in has just taken the tab somewhere new; the app may still be rendering it.
        if (request.existingOnly) await settleReady(chosen, request);
        return makeSession(chosen, false, navigated, target, request.loadTimeoutMs, atAuthGate, {
          pinned: true,
          inPage: request.inPage,
        });
      }
      if (request.target === undefined) throw new Error("bind needs a target or a tab");
      const existing = await findPage(current, request.target);
      if (existing) {
        await prepareCall(existing, request);
        const atAuthGate = authGateState(existing, request);
        let navigated = false;
        if (!request.existingOnly || request.navigation === "fresh") {
          navigated = await navigateBound(existing, request.target, request);
        }
        if (request.existingOnly && !navigated) await settleReady(existing, request);
        return makeSession(existing, false, navigated, request.target, request.loadTimeoutMs, atAuthGate, {
          inPage: request.inPage,
        });
      }
      if (request.existingOnly) throw new AuthPageUnavailable("auth retry has no open target tab");
      const page = await openPage(current);
      transport.recordEvent?.("Call tab opened");
      await prepareCall(page, request);
      resetCaptures(page);
      // Register before loading: a slow sign-in redirect must not orphan the tab.
      if (request.reuse) rememberReuse(urlOrigin(request.target), page);
      try {
        await navigateBound(page, request.target, request);
      } catch (error) {
        // A reused tab is kept for the origin's next call; any other tab has no
        // session to close it, so it is closed here.
        if (!request.reuse) await closeCreated(page);
        throw error;
      }
      return makeSession(page, true, true, request.target, request.loadTimeoutMs, undefined, {
        pinned: request.reuse === true,
        inPage: request.inPage,
      });
    },
    async finish(
      session: BrowserSession,
      disposition: FinishDisposition,
      need?: string
    ): Promise<void> {
      const cdpSession = session as CdpSession;
      cdpSession.closed = true;
      if (!cdpSession.page.isClosed()) releaseDownloadsLater(cdpSession.page);
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
        // Stay in the background: only a sign-in wait (watchAuthGate) has
        // something for the user to do, and it brings this tab forward. The
        // Lenses app raises nothing; it lists the page in its inbox.
        if (need && transport.reveal) {
          try {
            await transport.reveal(cdpSession.page, need);
          } catch {
            // The user may close the page while its call is still running.
          }
        }
      } else if (!need && !cdpSession.page.isClosed()) {
        transport.settled?.(cdpSession.page);
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
