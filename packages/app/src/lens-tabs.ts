/**
 * The pages the broker may drive, each through its own debugger: what the
 * app hands over (lens pages, and the popups and pages they open). Anything
 * else is refused, the app's own windows included.
 */
import { app, type WebContents } from "electron";
import type { ElectronTabListener, ElectronTabs } from "@djgrant/lenses-client/electron-host";

/** As the Playwright Extension asks for a tab back after Chrome detaches its debugger. */
const REANNOUNCE_MS = 150;

export interface LensTabsOptions {
  /** Open a background lens page; it is handed over (add) as it opens. */
  open(url?: string): WebContents;
  /** The page needs the user: a needs_* outcome, e.g. needs_auth. */
  attention(contents: WebContents, need: string): void;
  /** A call on the page ended without needing the user. */
  settled(contents: WebContents): void;
}

export function createLensTabs(options: LensTabsOptions) {
  const exposed = new Map<number, WebContents>();
  const listeners = new Set<ElectronTabListener>();
  const each = (fn: (listener: ElectronTabListener) => void) => {
    for (const listener of listeners) fn(listener);
  };

  function contentsOf(tabId: number): WebContents {
    const contents = exposed.get(tabId);
    if (!contents || contents.isDestroyed()) throw new Error(`no lens tab ${tabId}`);
    return contents;
  }

  /** Hand a lens tab or popup to the broker. */
  function add(contents: WebContents): void {
    const tabId = contents.id;
    if (exposed.has(tabId)) return;
    exposed.set(tabId, contents);
    contents.debugger.on("message", (_event, method, params, sessionId) =>
      each((listener) => listener.event(tabId, sessionId || undefined, method, params))
    );
    // Not fired for our own detach: the page closed, or crashed.
    contents.debugger.on("detach", (_event, reason) => {
      each((listener) => listener.detached(tabId, reason));
      setTimeout(() => {
        if (!contents.isDestroyed()) each((listener) => listener.created(tabId));
      }, REANNOUNCE_MS);
    });
    // Its own debugger never reports the page's URL to the broker; the tab does.
    const navigated = (url: string) => each((listener) => listener.updated(tabId, url));
    contents.on("did-navigate", (_event, url) => navigated(url));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) navigated(url);
    });
    contents.once("destroyed", () => {
      exposed.delete(tabId);
      each((listener) => listener.removed(tabId));
    });
    each((listener) => listener.created(tabId));
  }

  const tabs: ElectronTabs = {
    list: () => [...exposed.keys()],
    async create(url) {
      return options.open(url).id;
    },
    async close(tabId) {
      contentsOf(tabId).close();
    },
    attention(tabId, need) {
      const contents = exposed.get(tabId);
      if (contents && !contents.isDestroyed()) options.attention(contents, need);
    },
    settled(tabId) {
      const contents = exposed.get(tabId);
      if (contents && !contents.isDestroyed()) options.settled(contents);
    },
    async attach(tabId) {
      const contents = contentsOf(tabId);
      if (contents.debugger.isAttached()) contents.debugger.detach();
      contents.debugger.attach("1.3");
    },
    async detach(tabId) {
      const contents = exposed.get(tabId);
      if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    },
    send: (tabId, sessionId, method, params) =>
      contentsOf(tabId).debugger.sendCommand(method, params, sessionId),
    userAgent: () => app.userAgentFallback,
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return { tabs, add };
}
