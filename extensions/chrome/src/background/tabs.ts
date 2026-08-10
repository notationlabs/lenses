import { sameTarget, type ExtensionRpcOperation } from "@djgrant/lenses-core";
import { resetIntercepts } from "./intercepts.js";
import { loadCreatedTabLeases } from "./tab-leases.js";
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

  // A tab this extension opened for the target is reusable whatever it is
  // showing now: a signed-out target redirects onto a sign-in form, and
  // matching on URL alone would miss it and open another tab for every later
  // call. The lease stays with the call that took it, so this one borrows the
  // tab and leaves its disposal to the holder.
  const leased = await leasedTabFor(request.target, tabs);
  if (leased) return bindExisting(leased, request);

  const exact = tabs.find(
    (tab) => tab.url && sameTarget(tab.url, request.target)
  );
  if (exact) return bindExisting(exact, request);

  const created = await chrome.tabs.create({
    url: request.target,
    active: false,
  });
  if (created.id === undefined) throw new Error("could not create tab");
  resetIntercepts(created.id);
  await waitForLoad(created.id, request.loadTimeoutMs);
  return { tabId: created.id, created: true, navigated: true };
}

async function leasedTabFor(
  target: string,
  tabs: chrome.tabs.Tab[]
): Promise<chrome.tabs.Tab | undefined> {
  const leases = await loadCreatedTabLeases();
  const leased = leases.find(
    (lease) => lease.target && sameTarget(lease.target, target)
  );
  if (!leased) return undefined;
  // The user may have closed the tab since; its lease is then dead weight the
  // reaper clears, and this call falls through to opening a new tab.
  return tabs.find((tab) => tab.id === leased.tabId);
}

// Only chrome.tabs.create makes a tab this call may close: everything bound
// here already belonged to someone else, the user or an earlier lease.
async function bindExisting(
  tab: chrome.tabs.Tab,
  request: BindOperation
): Promise<BoundTab> {
  const tabId = tab.id;
  if (tabId === undefined) throw new Error("could not bind tab");
  if (!tab.url || !sameTarget(tab.url, request.target)) {
    await navigateTab(tabId, request.target, request.loadTimeoutMs);
    return { tabId, created: false, navigated: true };
  }
  if (request.navigation === "fresh") {
    await reloadTab(tabId, request.loadTimeoutMs);
    return { tabId, created: false, navigated: true };
  }
  await ensureContentScript(tabId, request.loadTimeoutMs);
  return { tabId, created: false, navigated: false };
}

export async function navigateTab(
  tabId: number,
  url: string,
  loadTimeoutMs: number
): Promise<void> {
  resetIntercepts(tabId);
  // The tab still reports the previous page as complete for a moment, so wait
  // for the load event rather than the status we can read now — and listen
  // before navigating, since a fast load can complete before update resolves.
  const loaded = waitForLoad(tabId, loadTimeoutMs, true);
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    loaded.catch(() => {});
    throw error;
  }
  await loaded;
}

export async function reloadTab(
  tabId: number,
  loadTimeoutMs: number
): Promise<void> {
  resetIntercepts(tabId);
  await chrome.tabs.reload(tabId, { bypassCache: false });
  await waitForLoad(tabId, loadTimeoutMs);
}

export async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // The user may have closed the tab; there is nothing left to focus.
  }
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
  timeoutMs: number,
  awaitEvent = false
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
        if (tab.status === "complete" && !awaitEvent) loaded();
      },
      (error) => finish(new Error(formatError(error)))
    );
  });
}
