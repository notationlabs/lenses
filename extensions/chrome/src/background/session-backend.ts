import {
  sameGatePlace,
  urlOrigin,
  type AuthGate,
  type ExtensionRpcRequest,
  type ExtensionRpcResult,
} from "@djgrant/lenses-core";
import { readIntercepts } from "./intercepts.js";
import {
  forgetCreatedTab,
  loadCreatedTabLeases,
  recordKeptUrl,
  rememberCreatedTab,
  takeCreatedTabLeases,
} from "./tab-leases.js";
import {
  chromeHasOsFocus,
  notifySignInNeeded,
} from "./notifications.js";
import {
  bindTab,
  closeTab,
  focusTab,
  reloadTab,
  tabMessage,
  type BoundTab,
} from "./tabs.js";
import { performSteps } from "./perform.js";

interface SessionState {
  id: string;
  bound: BoundTab;
  /** the expanded lens URL the session was bound to, for `navigate: "fresh"` */
  target: string;
  loadTimeoutMs: number;
  documentRevision: number;
  loading: boolean;
  captureAbort: AbortController;
  captures: Set<Promise<string>>;
}

export interface ExtensionSessionBackend {
  handle(request: ExtensionRpcRequest): Promise<ExtensionRpcResult>;
  close(): Promise<void>;
}

export async function reapAbandonedTabLeases(): Promise<void> {
  const leases = await takeCreatedTabLeases();
  await Promise.all(leases.map((lease) => closeTab(lease.tabId)));
}

export function createExtensionSessionBackend(): ExtensionSessionBackend {
  const sessions = new Map<string, SessionState>();
  const trackNavigation = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
    for (const active of sessions.values()) {
      if (active.bound.tabId !== tabId) continue;
      if (info.status === "loading") {
        active.documentRevision += 1;
        active.loading = true;
      } else if (info.status === "complete") {
        active.loading = false;
      }
    }
  };
  chrome.tabs.onUpdated.addListener(trackNavigation);

  const session = (sessionId: string): SessionState => {
    const found = sessions.get(sessionId);
    if (!found) throw new Error(`unknown browser session ${sessionId}`);
    return found;
  };

  return {
    async handle(request) {
      const operation = request.operation;
      switch (operation.name) {
        case "bind": {
          const bound = await bindTab(operation);
          const id = crypto.randomUUID();
          sessions.set(id, {
            id,
            bound,
            target: operation.target,
            loadTimeoutMs: operation.loadTimeoutMs,
            documentRevision: 0,
            loading: false,
            captureAbort: new AbortController(),
            captures: new Set(),
          });
          if (bound.created) {
            await rememberCreatedTab(bound.tabId, operation.target);
          }
          return {
            name: "bind",
            session: {
              id,
              created: bound.created,
              navigated: bound.navigated,
            },
          };
        }
        case "reload": {
          await reloadTab(
            session(operation.sessionId).bound.tabId,
            operation.loadTimeoutMs
          );
          return { name: "reload" };
        }
        case "read-intercepts": {
          const delta = await readIntercepts(
            session(operation.sessionId).bound.tabId,
            operation.cursor,
            operation.pollDeadline
          );
          return { name: "read-intercepts", ...delta };
        }
        case "dom-extract": {
          const extraction = await checkedTabMessage<{
            url: string;
            title: string;
            value: unknown;
          }>(session(operation.sessionId).bound.tabId, {
            type: "dom_extract",
            spec: operation.resolver,
          });
          return { name: "dom-extract", extraction };
        }
        case "perform": {
          const active = session(operation.sessionId);
          return {
            name: "perform",
            result: await performSteps(
              {
                tabId: active.bound.tabId,
                target: active.target,
                loadTimeoutMs: active.loadTimeoutMs,
              },
              operation.steps
            ),
          };
        }
        case "snapshot": {
          const snapshot = await checkedTabMessage<{
            url: string;
            title: string;
            text: string;
            html?: string;
          }>(session(operation.sessionId).bound.tabId, {
            type: "snapshot",
            maxChars: operation.maxChars,
            html: operation.html,
            maxHtmlChars: operation.maxHtmlChars,
          });
          return { name: "snapshot", snapshot };
        }
        case "recording-state": {
          const active = session(operation.sessionId);
          const tab = await chrome.tabs.get(active.bound.tabId);
          return {
            name: "recording-state",
            state: {
              url: tab.url ?? "",
              title: tab.title ?? "",
              documentRevision: active.documentRevision,
              loading: active.loading || tab.status === "loading",
            },
          };
        }
        case "recording-screenshot": {
          const active = session(operation.sessionId);
          const capture = captureTab(
            active.bound.tabId,
            request.deadline,
            active.captureAbort.signal
          );
          active.captures.add(capture);
          try {
            return {
              name: "recording-screenshot",
              pngBase64: await capture,
            };
          } finally {
            active.captures.delete(capture);
          }
        }
        case "finish": {
          const active = session(operation.sessionId);
          sessions.delete(operation.sessionId);
          active.captureAbort.abort();
          await Promise.allSettled(active.captures);
          if (operation.disposition === "keep") {
            // The lease is the gate's durable memory: while the tab stays at
            // this place, find-gate reports the site as blocked, whatever
            // broker process is asking.
            await recordCurrentUrlAsKept(active.bound.tabId);
            // Read OS focus before raising the tab: raising rewrites it.
            const chromeVisible = await chromeHasOsFocus();
            // The tab was opened in the background, so without this the
            // sign-in page sits unseen behind whatever the user is doing.
            await focusTab(active.bound.tabId);
            if (!chromeVisible) {
              await notifySignInNeeded(active.bound.tabId);
            }
          }
          if (active.bound.created) {
            if (operation.disposition === "close-if-created") {
              await forgetCreatedTab(active.bound.tabId);
              await closeTab(active.bound.tabId);
            }
            // A kept tab holds a sign-in page the caller still needs, so it
            // outlives its session — but its lease outlives it too. Dropping
            // the lease here left the tab untracked and therefore permanent,
            // and since a needs_auth redirect moves the tab off the target
            // URL, the next call could not rebind to it either: one orphan
            // per signed-out call, forever. The reaper collects it instead.
          }
          return { name: "finish" };
        }
        case "find-gate": {
          return { name: "find-gate", gate: await findGate(operation.origin) };
        }
        case "http-fetch": {
          // Runs in the service worker, so host_permissions exempt it from
          // CORS and the browser attaches the site's cookies — one request
          // where the page tiers would cost a whole tab.
          const { method, url, headers } = operation.request;
          const response = await fetch(url, {
            method,
            headers,
            credentials: "include",
            redirect: "follow",
            signal: AbortSignal.timeout(
              Math.max(1, request.deadline - Date.now())
            ),
          });
          const body = (await response.text()).slice(
            0,
            operation.maxBodyChars ?? 512 * 1024
          );
          return {
            name: "http-fetch",
            response: {
              url: response.url || url,
              method,
              status: response.status,
              body,
              timestamp: Date.now(),
            },
          };
        }
      }
    },
    async close() {
      chrome.tabs.onUpdated.removeListener(trackNavigation);
      const active = [...sessions.values()];
      sessions.clear();
      for (const item of active) item.captureAbort.abort();
      await Promise.allSettled(active.flatMap((item) => [...item.captures]));
      await Promise.all(
        active
          .filter((item) => item.bound.created)
          .map(async (item) => {
            await forgetCreatedTab(item.bound.tabId);
            await closeTab(item.bound.tabId);
          })
      );
    },
  };
}

/**
 * captureVisibleTab can only capture whichever tab is active. The debugger API
 * is the smallest Chrome API that can capture the participating background tab
 * without briefly selecting it (and risking an unrelated-tab screenshot).
 */
const captureTails = new Map<number, Promise<void>>();
// Full-resolution captures of very long pages can make Chrome allocate several
// hundred MB (the 91bc page was 1512×21321 CSS px at DPR 2) and leave
// Page.captureScreenshot pending until the whole call expires. Keep the CSS
// surface near 8 MP and its longest edge within 8192 px; at DPR 2 that bounds
// the encoded raster to roughly 32 MP / 128 MB while retaining a readable
// full-page image.
const MAX_SCREENSHOT_CSS_PIXELS = 8_000_000;
const MAX_SCREENSHOT_CSS_EDGE = 8_192;
const DEBUGGER_DETACH_TIMEOUT_MS = 1_000;

/** Serialize captures for a tab, including captures requested by another broker. */
function captureTab(
  tabId: number,
  deadline: number,
  signal: AbortSignal
): Promise<string> {
  const previous = captureTails.get(tabId) ?? Promise.resolve();
  const capture = previous
    .catch(() => {})
    .then(() => captureTabNow(tabId, deadline, signal));
  const tail = capture.then(
    () => {},
    () => {}
  );
  captureTails.set(tabId, tail);
  void tail.then(() => {
    if (captureTails.get(tabId) === tail) captureTails.delete(tabId);
  });
  return capture;
}

async function captureTabNow(
  tabId: number,
  deadline: number,
  signal: AbortSignal
): Promise<string> {
  const target = { tabId };
  let attached = false;
  let detached: Promise<void> | undefined;
  let cancelled = signal.aborted;
  let rejectCancellation: ((error: Error) => void) | undefined;

  const detach = (): Promise<void> => {
    if (!attached) return detached ?? Promise.resolve();
    // Mark it released before calling Chrome: a wedged debugger command can
    // also wedge detach. Cleanup remains best-effort, but must never prevent
    // the screenshot deadline from settling the RPC and broker queue.
    attached = false;
    const operation = chrome.debugger.detach(target).catch(() => {});
    detached = Promise.race([
      operation,
      new Promise<void>((resolve) =>
        setTimeout(resolve, DEBUGGER_DETACH_TIMEOUT_MS)
      ),
    ]).then(() => {});
    return detached;
  };
  const cancel = (message: string) => {
    if (cancelled) return;
    cancelled = true;
    rejectCancellation?.(new Error(message));
    void detach();
  };
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
    if (cancelled) reject(new Error(`screenshot for tab ${tabId} was cancelled`));
  });
  const onAbort = () => cancel(`screenshot for tab ${tabId} was cancelled`);
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => cancel(`screenshot for tab ${tabId} deadline exceeded`),
    Math.max(0, deadline - Date.now())
  );

  const work = (async () => {
    if (cancelled || Date.now() >= deadline) {
      throw new Error(`screenshot for tab ${tabId} deadline exceeded`);
    }
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (error) {
      // An interrupted service worker can leave this extension's debugger
      // attached. detach() cannot remove DevTools or another extension, so a
      // successful detach identifies an attachment that is safe to recover.
      try {
        await chrome.debugger.detach(target);
      } catch {
        throw error;
      }
      await chrome.debugger.attach(target, "1.3");
    }
    attached = true;
    if (cancelled) throw new Error(`screenshot for tab ${tabId} was cancelled`);
    try {
      const metrics = (await chrome.debugger.sendCommand(
        target,
        "Page.getLayoutMetrics"
      )) as {
        cssContentSize?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      };
      const content = metrics.cssContentSize ?? metrics.contentSize;
      if (!content || content.width <= 0 || content.height <= 0) {
        throw new Error(`Chrome returned no page dimensions for tab ${tabId}`);
      }
      const scale = Math.min(
        1,
        Math.sqrt(
          MAX_SCREENSHOT_CSS_PIXELS / (content.width * content.height)
        ),
        MAX_SCREENSHOT_CSS_EDGE / Math.max(content.width, content.height)
      );
      const result = (await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        optimizeForSpeed: true,
        clip: {
          x: 0,
          y: 0,
          width: content.width,
          height: content.height,
          scale,
        },
      })) as { data?: string };
      if (!result.data) throw new Error(`Chrome returned no screenshot for tab ${tabId}`);
      return result.data;
    } finally {
      await detach();
    }
  })();

  try {
    return await Promise.race([work, cancellation]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    await detach();
  }
}

async function recordCurrentUrlAsKept(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) await recordKeptUrl(tabId, tab.url);
  } catch {
    // The user closed the tab mid-call; there is nothing left to gate.
  }
}

async function findGate(origin: string): Promise<AuthGate | null> {
  for (const lease of await loadCreatedTabLeases()) {
    if (!lease.target || !lease.keptUrl) continue;
    if (urlOrigin(lease.target) !== origin) continue;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(lease.tabId);
    } catch {
      continue; // The kept tab was closed; that lease no longer gates.
    }
    if (tab.url && sameGatePlace(tab.url, lease.keptUrl)) {
      return { url: tab.url, target: lease.target };
    }
  }
  return null;
}

async function checkedTabMessage<T>(
  tabId: number,
  payload: unknown
): Promise<T> {
  const response = await tabMessage<T | { error: string }>(
    tabId,
    payload
  );
  if (
    typeof response === "object" &&
    response !== null &&
    "error" in response
  ) {
    throw new Error(response.error);
  }
  return response;
}
