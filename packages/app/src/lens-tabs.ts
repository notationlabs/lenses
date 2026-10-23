/**
 * The tabs the broker may drive, each through its own debugger. Only what the
 * browser hands over (lens tabs and their popups) is listed; anything else is
 * refused, so the user's tabs cannot be attached at all.
 */
import { app, type WebContents } from "electron";
import type { ElectronTabListener, ElectronTabs } from "@djgrant/lenses-client/electron-host";

/** As the Playwright Extension asks for a tab back after Chrome detaches its debugger. */
const REANNOUNCE_MS = 150;

export interface LensTabsOptions {
  /** Open a background lens tab; the browser hands it over (add) as it opens. */
  open(url?: string): WebContents;
  /** Show a lens tab or popup, for a sign-in. */
  reveal(contents: WebContents): void;
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
    // Not fired for our own detach: the page closed, or DevTools took over.
    contents.debugger.on("detach", (_event, reason) => {
      each((listener) => listener.detached(tabId, reason));
      setTimeout(() => {
        if (!contents.isDestroyed()) each((listener) => listener.created(tabId));
      }, REANNOUNCE_MS);
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
    reveal(tabId) {
      const contents = exposed.get(tabId);
      if (contents && !contents.isDestroyed()) options.reveal(contents);
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
