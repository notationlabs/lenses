import { matchUrl, type LensSpec } from "@djgrant/lens";
import { resetIntercepts } from "./intercepts.js";
import { formatError } from "../errors.js";

export interface BoundTab {
  tabId: number;
  created: boolean;
  navigated: boolean;
}

export async function bindTab(spec: LensSpec, target: string): Promise<BoundTab> {
  const loadTimeoutMs = spec.loadTimeoutMs;
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find((tab) => tab.url && sameTarget(tab.url, target));
  if (exact?.id !== undefined) {
    await ensureContentScript(exact.id, loadTimeoutMs);
    return { tabId: exact.id, created: false, navigated: false };
  }

  const accepted = tabs.find((tab) => tab.url && matchUrl(spec.accepts, tab.url));
  if (accepted?.id !== undefined) {
    resetIntercepts(accepted.id);
    await chrome.tabs.update(accepted.id, { url: target });
    await waitForLoad(accepted.id, loadTimeoutMs);
    return { tabId: accepted.id, created: false, navigated: true };
  }

  const created = await chrome.tabs.create({ url: target, active: false });
  if (created.id === undefined) throw new Error("could not create tab");
  await waitForLoad(created.id, loadTimeoutMs);
  return { tabId: created.id, created: true, navigated: true };
}

export async function bindObservedTab(target: string): Promise<BoundTab> {
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find((tab) => tab.url && sameTarget(tab.url, target));
  if (exact?.id !== undefined) {
    resetIntercepts(exact.id);
    await chrome.tabs.reload(exact.id, { bypassCache: false });
    await waitForLoad(exact.id);
    return { tabId: exact.id, created: false, navigated: true };
  }

  const created = await chrome.tabs.create({ url: target, active: false });
  if (created.id === undefined) throw new Error("could not create tab");
  await waitForLoad(created.id);
  return { tabId: created.id, created: true, navigated: true };
}

export async function reloadTab(tabId: number, loadTimeoutMs?: number): Promise<void> {
  resetIntercepts(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: false });
  await waitForLoad(tabId, loadTimeoutMs);
}

export async function ensureContentScript(tabId: number, loadTimeoutMs?: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await reloadTab(tabId, loadTimeoutMs);
  }
}

export async function closeIfCreated(
  bound: BoundTab,
  result: { kind: string; name?: string }
): Promise<void> {
  if (!bound.created) return;
  if (result.kind === "outcome" && result.name?.startsWith("needs_")) return;

  try {
    await chrome.tabs.remove(bound.tabId);
  } catch {
    // The user may close a background tab while its call is still running.
  }
}

export function tabMessage<T>(tabId: number, payload: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, payload) as Promise<T>;
}

export function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
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
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") loaded();
    };
    const timeout = setTimeout(
      () => finish(new Error(`tab ${tabId} did not finish loading within ${timeoutMs}ms`)),
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
