/**
 * CDP-backed lens host: drives the user's running default-profile Chrome via
 * the Chrome 144+ consent-gated remote debugging endpoint (enabled at
 * chrome://inspect/#remote-debugging).
 *
 * Implements the EngineIO contract, so the engine and resolvers in
 * @djgrant/lens run unchanged against any host.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  executeLens,
  expandUrl,
  pageDomExtract,
  pageSnapshot,
  type DomResolver,
  type EngineIO,
  type InterceptedResponse,
  type LensBridgeRequest,
  type LensResult,
  type LensSpec,
} from "@djgrant/lens";

const MAX_CAPTURES = 200;
const MAX_BODY_BYTES = 512 * 1024;
const LOAD_GRACE_MS = 500;
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const CONNECT_WINDOW_MS = 45_000;
const CONNECT_RETRY_MS = 2_000;
const CONNECT_ATTEMPT_MS = 10_000;
const ENDPOINT_POLL_MS = 500;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

/** Where Chrome stable writes DevToolsActivePort when remote debugging is on. */
function defaultUserDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "google-chrome");
  }
}

interface BoundPage {
  page: Page;
  created: boolean;
  navigated: boolean;
}

export type CdpLease = "held" | "released" | "disconnected";

export interface CdpHost {
  /** true when the broker has a live CDP connection to Chrome */
  available(): boolean;
  info(): string;
  /**
   * held: live CDP connection (Chrome's consented debugging slot is ours).
   * released: connection dropped on purpose; other CDP tools may use Chrome.
   * disconnected: no connection and none deliberately released (e.g. remote
   * debugging is off, or Chrome closed the socket).
   */
  lease(): CdpLease;
  /**
   * Drop the CDP connection and stop auto-reconnecting, freeing Chrome's single
   * consented debugging slot for other tools. The next lens call (or acquire)
   * silently reconnects: Chrome scopes consent to the browser session, so no
   * new Allow dialog appears. Release is cooperative slot-sharing, not a
   * consent boundary or a hard stop.
   */
  release(): Promise<void>;
  /** Reconnect after a release (prompts the user to Allow in Chrome). */
  acquire(progress?: (message: string) => void): Promise<void>;
  start(): void;
  stop(): void;
  onStatusChange(listener: () => void): () => void;
  handle(
    message: LensBridgeRequest,
    emit: (frame: { type: "result"; id: string; result: LensResult } | { type: "progress"; id: string; message: string }) => void
  ): Promise<void>;
}

export function createCdpHost(log: (message: string) => void = () => {}): CdpHost {
  let browser: Browser | undefined;
  let browserVersion = "";
  let connecting: Promise<Browser> | undefined;
  let endpointPresent = false;
  let endpointPoll: ReturnType<typeof setInterval> | undefined;
  /** true after an explicit release(): suppress auto-reconnect until asked. */
  let released = false;
  let reconnectDelayMs = CONNECT_RETRY_MS;
  let nextReconnectAt = 0;
  const captures = new WeakMap<Page, InterceptedResponse[]>();
  const statusListeners = new Set<() => void>();

  const endpointAvailable = () => existsSync(join(defaultUserDataDir(), "DevToolsActivePort"));
  const available = () => browser?.connected === true;
  const notifyStatusChange = () => {
    for (const listener of statusListeners) listener();
  };

  async function ensureBrowser(progress: (message: string) => void): Promise<Browser> {
    // A lens call is an explicit demand for the browser: leave the released
    // state and reacquire. Consent is session-scoped in Chrome, so this
    // reconnect raises no new Allow dialog.
    released = false;
    if (browser?.connected) return browser;
    if (connecting) return connecting;
    if (!endpointAvailable()) {
      throw new Error(
        "browser is not connected (enable chrome://inspect/#remote-debugging in Chrome)"
      );
    }
    connecting = connectBrowser(progress);
    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }

  async function connectBrowser(progress: (message: string) => void): Promise<Browser> {
    progress("connecting to Chrome (a permission dialog may appear — click Allow)");
    // Chrome holds or rejects the socket until the user answers the consent
    // dialog, so keep retrying while they decide.
    const deadline = Date.now() + CONNECT_WINDOW_MS;
    let connected: Browser | undefined;
    for (;;) {
      try {
        // channel resolves the default user data dir and reads DevToolsActivePort.
        // defaultViewport: null — don't emulate a fixed viewport in the
        // user's real browser windows; use each window's actual size.
        // Chrome can hold the socket open without answering while consent is
        // pending, so a single connect attempt can hang forever; bound each
        // attempt so the overall deadline is actually enforced.
        connected = await attemptWithTimeout(
          puppeteer.connect({ channel: "chrome", defaultViewport: null }),
          CONNECT_ATTEMPT_MS
        );
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `could not connect to Chrome (${reason}); approve the permission dialog in Chrome, ` +
              "or re-enable remote debugging at chrome://inspect/#remote-debugging"
          );
        }
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    }
    const version = await connected.version();
    browser = connected;
    browserVersion = version;
    reconnectDelayMs = CONNECT_RETRY_MS;
    nextReconnectAt = 0;
    connected.on("disconnected", () => {
      if (browser !== connected) return;
      browser = undefined;
      browserVersion = "";
      endpointPresent = false;
      notifyStatusChange();
    });
    log(`cdp connected: ${browserVersion}`);
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
    // A failed attempt must not end reconnection while the endpoint is live:
    // keep retrying with backoff instead of latching on endpointPresent.
    if (!fresh && Date.now() < nextReconnectAt) return;
    nextReconnectAt = Date.now() + reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_BACKOFF_MAX_MS);
    void ensureBrowser(() => {}).catch((error) => {
      log(`cdp connection failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function buffer(page: Page): InterceptedResponse[] {
    let buf = captures.get(page);
    if (!buf) {
      buf = [];
      captures.set(page, buf);
      page.on("response", (res) => {
        void (async () => {
          const ct = res.headers()["content-type"] ?? "";
          if (!/json|text|^$/.test(ct)) return;
          try {
            const body = await res.text();
            const trimmed = body.trimStart();
            const looksJson = ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
            if (!looksJson || body.length > MAX_BODY_BYTES) return;
            const store = captures.get(page);
            if (!store) return;
            store.push({
              url: res.url(),
              method: res.request().method(),
              status: res.status(),
              body,
              timestamp: Date.now(),
            });
            if (store.length > MAX_CAPTURES) store.splice(0, store.length - MAX_CAPTURES);
          } catch {
            // Body evicted (e.g. by a navigation) before we read it.
          }
        })();
      });
    }
    return buf;
  }

  const resetCaptures = (page: Page) => void (buffer(page).length = 0);

  async function settle(action: Promise<unknown>): Promise<void> {
    await action;
    // Grace period after "load" so late DOM writes land before extraction.
    await new Promise((resolve) => setTimeout(resolve, LOAD_GRACE_MS));
  }

  async function reloadPage(page: Page, loadTimeoutMs?: number): Promise<void> {
    resetCaptures(page);
    await settle(page.reload({ waitUntil: "load", timeout: loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS }));
  }

  async function bindPage(b: Browser, spec: LensSpec, target: string): Promise<BoundPage> {
    const existing = await findPage(b, target);
    if (existing) {
      buffer(existing);
      // Intercept resolvers read capture buffers that only fill during a
      // navigation, so a reused page must be reloaded with fresh captures.
      if (spec.resolve.some((resolver) => resolver.kind === "intercept")) {
        await reloadPage(existing, spec.loadTimeoutMs);
        return { page: existing, created: false, navigated: true };
      }
      return { page: existing, created: false, navigated: false };
    }
    // background: don't steal focus from the user's active tab or window.
    const page = await b.newPage({ background: true });
    buffer(page);
    await settle(page.goto(target, { waitUntil: "load", timeout: spec.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS }));
    return { page, created: true, navigated: true };
  }

  async function bindObservedPage(b: Browser, target: string): Promise<BoundPage> {
    const existing = await findPage(b, target);
    if (existing) {
      buffer(existing);
      await reloadPage(existing);
      return { page: existing, created: false, navigated: true };
    }
    const page = await b.newPage({ background: true });
    buffer(page);
    await settle(page.goto(target, { waitUntil: "load", timeout: DEFAULT_LOAD_TIMEOUT_MS }));
    return { page, created: true, navigated: true };
  }

  async function closeIfCreated(bound: BoundPage, result: { kind: string; name?: string }): Promise<void> {
    if (!bound.created) return;
    // Keep pages open when the caller must act in them (e.g. a login flow).
    if (result.kind === "outcome" && result.name?.startsWith("needs_")) return;
    try {
      await bound.page.close();
    } catch {
      // The user may close the page while its call is still running.
    }
  }

  async function callLens(
    spec: LensSpec,
    params: Record<string, unknown>,
    progress: (message: string) => void
  ): Promise<LensResult> {
    const b = await ensureBrowser(progress);
    const target = expandUrl(spec.url, params);
    progress(`binding browser page for ${target}`);
    const bound = await bindPage(b, spec, target);
    progress(`bound page${bound.created ? " (created)" : " (existing)"}`);
    let navigationIsFresh = bound.navigated;
    const io: EngineIO = {
      getIntercepted: async () => [...buffer(bound.page)],
      reload: async () => {
        if (navigationIsFresh) {
          navigationIsFresh = false;
          progress("using the page's fresh navigation for intercept capture");
          return;
        }
        await reloadPage(bound.page, spec.loadTimeoutMs);
      },
      domExtract: (resolver: DomResolver) =>
        bound.page.evaluate(pageDomExtract, { item: resolver.item, fields: resolver.fields }),
      snapshot: (maxChars: number) => bound.page.evaluate(pageSnapshot, { maxChars }),
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: progress,
    };

    let result: LensResult | undefined;
    try {
      result = await executeLens(spec, params, io);
      return result;
    } finally {
      await closeIfCreated(bound, result ?? { kind: "error" });
    }
  }

  async function observePage(target: string, waitMs: number, html: boolean, progress: (message: string) => void) {
    const b = await ensureBrowser(progress);
    progress(`binding browser page for ${target}`);
    const bound = await bindObservedPage(b, target);
    try {
      progress(`collecting page activity for ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const requests = buffer(bound.page)
        .slice(-40)
        .map((capture) => ({
          method: capture.method,
          url: capture.url,
          status: capture.status,
          bodyPreview: capture.body.slice(0, 2000),
        }));
      const snapshot = await bound.page.evaluate(pageSnapshot, { maxChars: 6000, html });
      progress(`collected ${requests.length} captured requests`);
      return { kind: "value" as const, value: { snapshot, requests } };
    } finally {
      await closeIfCreated(bound, { kind: "value" });
    }
  }

  return {
    available,
    info: () => `cdp ${browserVersion}`,
    lease: () => (available() ? "held" : released ? "released" : "disconnected"),
    async release() {
      released = true;
      // Settle any in-flight connect first so we do not leak a connection that
      // completes after the release.
      if (connecting) await connecting.catch(() => {});
      const current = browser;
      if (!current) {
        notifyStatusChange();
        return;
      }
      try {
        await current.disconnect();
      } catch {
        // Socket already gone; the disconnected listener has cleaned up.
      }
      log("cdp lease released");
    },
    async acquire(progress = () => {}) {
      await ensureBrowser(progress);
    },
    start() {
      if (endpointPoll) return;
      pollEndpoint();
      endpointPoll = setInterval(pollEndpoint, ENDPOINT_POLL_MS);
    },
    stop() {
      if (!endpointPoll) return;
      clearInterval(endpointPoll);
      endpointPoll = undefined;
    },
    onStatusChange(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async handle(message, emit) {
      const progress = (text: string) => emit({ type: "progress", id: message.id, message: text });
      try {
        if (message.type === "control") {
          throw new Error("control messages are handled by the broker, not the CDP host");
        }
        const result =
          message.type === "call"
            ? await callLens(message.spec, message.params, progress)
            : await observePage(message.target, message.waitMs, message.html ?? false, progress);
        emit({ type: "result", id: message.id, result: result as LensResult });
      } catch (error) {
        emit({
          type: "result",
          id: message.id,
          result: { kind: "error", message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
}

/**
 * Bound a connect attempt. A timed-out attempt may still resolve later, in
 * which case its browser must be disconnected rather than leaked.
 */
function attemptWithTimeout(connect: Promise<Browser>, timeoutMs: number): Promise<Browser> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`connect attempt timed out after ${timeoutMs}ms`));
      connect.then((late) => void late.disconnect()).catch(() => {});
    }, timeoutMs);
    connect.then(
      (browser) => {
        clearTimeout(timer);
        resolve(browser);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function findPage(b: Browser, target: string): Promise<Page | undefined> {
  const pages = await b.pages();
  return pages.find((page) => sameTarget(page.url(), target));
}

function sameTarget(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}
