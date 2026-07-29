import {
  sameGatePlace,
  type AuthGate,
  type ExtensionRpcRequest,
  type ExtensionRpcResult,
} from "@djgrant/lens";
import { readIntercepts } from "./intercepts.js";
import {
  forgetCreatedTab,
  loadCreatedTabLeases,
  recordKeptUrl,
  rememberCreatedTab,
  takeCreatedTabLeases,
} from "./tab-leases.js";
import {
  bindTab,
  closeTab,
  reloadTab,
  tabMessage,
  type BoundTab,
} from "./tabs.js";

interface SessionState {
  id: string;
  bound: BoundTab;
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
          sessions.set(id, { id, bound });
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
        case "finish": {
          const active = session(operation.sessionId);
          sessions.delete(operation.sessionId);
          if (operation.disposition === "keep") {
            // The lease is the gate's durable memory: while the tab stays at
            // this place, find-gate reports the site as blocked, whatever
            // broker process is asking.
            await recordCurrentUrlAsKept(active.bound.tabId);
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
      }
    },
    async close() {
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
    if (targetOrigin(lease.target) !== origin) continue;
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

function targetOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
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
