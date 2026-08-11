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
          return {
            name: "recording-screenshot",
            pngBase64: await captureTab(active.bound.tabId),
          };
        }
        case "finish": {
          const active = session(operation.sessionId);
          sessions.delete(operation.sessionId);
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
async function captureTab(tabId: number): Promise<string> {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const result = (await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
    })) as { data?: string };
    if (!result.data) throw new Error(`Chrome returned no screenshot for tab ${tabId}`);
    return result.data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
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
