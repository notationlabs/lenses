import type { ExtensionRpcOperation } from "@djgrant/lens";
import { resetIntercepts } from "./intercepts.js";
import { formatError } from "../errors.js";

export interface BoundTab {
  tabId: number;
  created: boolean;
  navigated: boolean;
}

type BindOperation = Extract<
  ExtensionRpcOperation,
  { name: "bind" }
>;

export async function bindTab(
  request: BindOperation
): Promise<BoundTab> {
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find(
    (tab) => tab.url && sameTarget(tab.url, request.target)
  );
  if (exact?.id !== undefined) {
    if (request.navigation === "fresh") {
      await reloadTab(exact.id, request.loadTimeoutMs);
      return { tabId: exact.id, created: false, navigated: true };
    }
    await ensureContentScript(exact.id, request.loadTimeoutMs);
    return { tabId: exact.id, created: false, navigated: false };
  }

  const created = await chrome.tabs.create({
    url: request.target,
    active: false,
  });
  if (created.id === undefined) throw new Error("could not create tab");
  resetIntercepts(created.id);
  await waitForLoad(created.id, request.loadTimeoutMs);
  return { tabId: created.id, created: true, navigated: true };
}

export async function reloadTab(
  tabId: number,
  loadTimeoutMs: number
): Promise<void> {
  resetIntercepts(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: false });
  await waitForLoad(tabId, loadTimeoutMs);
}

export async function closeTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may close a background tab while its session is active.
  }
}

async function ensureContentScript(
  tabId: number,
  loadTimeoutMs: number
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await reloadTab(tabId, loadTimeoutMs);
  }
}

export function tabMessage<T>(
  tabId: number,
  payload: unknown
): Promise<T> {
  return chrome.tabs.sendMessage(tabId, payload) as Promise<T>;
}

function waitForLoad(
  tabId: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let loadSeen = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => {
      if (loadSeen) return;
      loadSeen = true;
      clearTimeout(timeout);
      graceTimer = setTimeout(() => finish(), 500);
    };
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (id === tabId && info.status === "complete") loaded();
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `tab ${tabId} did not finish loading within ${timeoutMs}ms`
          )
        ),
      timeoutMs
    );

    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete") loaded();
      },
      (error) => finish(new Error(formatError(error)))
    );
  });
}

function sameTarget(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}
