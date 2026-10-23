import puppeteer, { type ConnectionTransport } from "puppeteer-core";
import { pageTargetId, type CdpTransport } from "./cdp-host.js";
import { BrowserModel, type CDPMessage, type TabLink } from "./playwright-relay/browser-model.js";

/**
 * What the Lenses app provides when it runs the broker in its own main
 * process. The app's Chromium is the browser, but it opens no debugging port:
 * the broker reaches only the tabs the app hands it, each through its own
 * debugger (Electron's webContents.debugger), as the Playwright Extension
 * hands over Chrome tabs through chrome.debugger.
 */
export interface ElectronHost {
  /** Broker port to listen on. */
  port: number;
  tabs: ElectronTabs;
  /** Each broker status frame, for the app's control panel. */
  status?(frame: unknown): void;
  /** Called once the broker is listening, with a way to read its status. */
  started?(broker: { status(): unknown }): void;
}

/**
 * The tabs the broker may drive: lens tabs and their popups. Tabs the user
 * opens are never listed, so they cannot be attached at all.
 */
export interface ElectronTabs {
  /** Lens tabs open now, e.g. when the broker reconnects. */
  list(): number[];
  /** Open a background lens tab; it is announced (onCreated) before this resolves. */
  create(url?: string): Promise<number>;
  close(tabId: number): Promise<void>;
  /** The tab needs the user (`need`: a needs_* outcome, e.g. needs_auth). */
  attention(tabId: number, need: string): void;
  /** A call on the tab ended without needing the user. */
  settled(tabId: number): void;
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  /** A command on the tab's debugger, or on one of its child sessions (an iframe). */
  send(tabId: number, sessionId: string | undefined, method: string, params?: object): Promise<unknown>;
  userAgent(): string;
  listen(listener: ElectronTabListener): () => void;
}

export interface ElectronTabListener {
  /** A lens tab or popup appeared, or a detached one should be attached again. */
  created(tabId: number): void;
  removed(tabId: number): void;
  /** The tab's main frame navigated. */
  updated(tabId: number, url: string): void;
  /** A debugger event; `sessionId` names a child session, absent for the page's own. */
  event(tabId: number, sessionId: string | undefined, method: string, params: unknown): void;
  detached(tabId: number, reason: string): void;
}

const HOST = Symbol.for("lenses.electron-host");

/** The app host, when the broker runs inside the Lenses app. */
export function electronHost(): ElectronHost | undefined {
  return (globalThis as { [HOST]?: ElectronHost })[HOST];
}

export function setElectronHost(host: ElectronHost): void {
  (globalThis as { [HOST]?: ElectronHost })[HOST] = host;
}

interface CdpCommand {
  id: number;
  method: string;
  params?: any;
  sessionId?: string;
}

/**
 * A browser-level CDP endpoint over the app's tabs, in process: Puppeteer
 * talks to it through a transport, not a socket. The tab bookkeeping is the
 * Playwright Extension relay's (BrowserModel), with the app in the
 * extension's place.
 */
export function createElectronRelay(tabs: ElectronTabs, log: (message: string) => void = () => {}) {
  let closed = false;
  const attached = new Set<number>();
  const model = new BrowserModel(async (method, args) => {
    const [first, ...rest] = args as [any, ...any[]];
    switch (method) {
      case "chrome.debugger.attach":
        await tabs.attach(first.tabId);
        attached.add(first.tabId);
        return;
      case "chrome.debugger.detach":
        attached.delete(first.tabId);
        return tabs.detach(first.tabId);
      case "chrome.debugger.sendCommand":
        return tabs.send(first.tabId, first.sessionId, rest[0], rest[1]);
      case "chrome.tabs.create":
        return { id: await tabs.create(first?.url), index: 0, windowId: 0, active: false, pinned: false };
      case "chrome.tabs.remove":
        return tabs.close(first);
    }
    throw new Error(`not supported by the Lenses app: ${method}`);
  }, log);

  const announce = (tabId: number) =>
    model.onTabCreated({ id: tabId, index: 0, windowId: 0, active: false, pinned: false });
  const unlisten = tabs.listen({
    created: announce,
    removed: (tabId) => {
      attached.delete(tabId);
      model.onTabRemoved(tabId);
    },
    updated: (tabId, url) => model.onTabUpdated(tabId, { url }),
    event: (tabId, sessionId, method, params) =>
      model.onDebuggerEvent({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params),
    detached: (tabId, reason) => {
      if (!attached.delete(tabId)) return;
      // A closing tab detaches first; anything else is worth a line.
      if (reason !== "target closed") log(`debugger detached from tab ${tabId}: ${reason}`);
      model.onDebuggerDetach({ tabId });
    },
  });
  for (const tabId of tabs.list()) announce(tabId);

  async function handle(command: CdpCommand): Promise<unknown> {
    const { method, params, sessionId } = command;
    if (!sessionId) {
      switch (method) {
        case "Browser.getVersion":
          return { protocolVersion: "1.3", product: "Lenses", revision: "", userAgent: tabs.userAgent(), jsVersion: "" };
        case "Target.getBrowserContexts":
          return { browserContextIds: [] };
        case "Target.setDiscoverTargets":
          // Tabs arrive as the app announces them.
          return {};
        case "Target.setAutoAttach":
          await model.enableAutoAttach();
          return {};
        case "Target.createTarget":
          return model.createTarget(params?.url, params?.background === true);
        case "Target.closeTarget":
          return model.closeTarget(params?.targetId);
      }
      return model.sendBrowserCommand(method, params);
    }
    const own = method === "Target.getTargetInfo" ? model.getTargetInfo(sessionId) : undefined;
    if (own) return { targetInfo: own };
    return model.sendCommand(sessionId, method, params);
  }

  const transport: ConnectionTransport = {
    send(raw) {
      if (closed) return;
      const command = JSON.parse(raw) as CdpCommand;
      const route = command.sessionId ? { sessionId: command.sessionId } : {};
      // Replies leave as commands finish, as Chromium's do.
      void handle(command).then(
        (result) => deliver({ id: command.id, result: result ?? {}, ...route }),
        (error: unknown) =>
          deliver({
            id: command.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            ...route,
          })
      );
    },
    close() {
      dispose();
    },
  };
  // Never synchronous: Puppeteer expects a reply after send returns.
  function deliver(message: CDPMessage): void {
    if (closed) return;
    setImmediate(() => {
      if (!closed) transport.onmessage?.(JSON.stringify(message));
    });
  }
  model.connectOverCDP(deliver);

  function dispose(): void {
    if (closed) return;
    closed = true;
    unlisten();
    for (const tabId of attached) void tabs.detach(tabId).catch(() => {});
    attached.clear();
    setImmediate(() => transport.onclose?.());
  }

  return { transport, model, dispose };
}

type ElectronRelay = ReturnType<typeof createElectronRelay>;

export function createElectronTransport(host: ElectronHost): CdpTransport {
  let relay: ElectronRelay | undefined;
  const linkListeners = new Set<(key: string, link: TabLink) => void>();
  const tabIdOf = (targetId: string | undefined) =>
    targetId === undefined ? undefined : relay?.model.tabIdForTarget(targetId);
  return {
    name: "electron",
    pollForConnection: true,
    retryConnect: true,
    looksReady: () => true,
    probeLive: async () => true,
    connectHint: () => "connecting to the Lenses app browser",
    staleHint: () => "The Lenses app browser is not responding; restart the app.",
    async connect() {
      relay?.dispose();
      const next = createElectronRelay(host.tabs, (message) => console.error(message));
      relay = next;
      next.model.onTabLinkChange((tabId, link) => {
        if (relay !== next) return;
        for (const listener of linkListeners) listener(String(tabId), link);
      });
      try {
        return await puppeteer.connect({ transport: next.transport, defaultViewport: null });
      } catch (error) {
        next.dispose();
        throw error;
      }
    },
    tabKey(page) {
      const tabId = tabIdOf(pageTargetId(page));
      return tabId === undefined ? undefined : String(tabId);
    },
    tabLink: (key) => relay?.model.tabLink(Number(key)),
    retryAttach: async (key) => relay?.model.retryAttach(Number(key)),
    refreshAttach: async (key) => relay?.model.refreshAttach(Number(key)),
    onTabLinkChange(listener) {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    async reveal(page, need) {
      const tabId = tabIdOf(pageTargetId(page));
      if (tabId !== undefined) host.tabs.attention(tabId, need);
    },
    settled(page) {
      const tabId = tabIdOf(pageTargetId(page));
      if (tabId !== undefined) host.tabs.settled(tabId);
    },
    dispose() {
      relay?.dispose();
      relay = undefined;
    },
  };
}
