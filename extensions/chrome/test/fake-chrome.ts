export interface FakeTab {
  id: number;
  url: string;
  status: "loading" | "complete";
}

class FakeEvent<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  addListener(listener: (...args: Args) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: Args) => void): void {
    this.listeners.delete(listener);
  }

  emit(...args: Args): void {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

export interface FakeChrome {
  api: unknown;
  tabs: Map<number, FakeTab>;
  /** Every tab id passed to chrome.tabs.remove, including repeats. */
  removed: number[];
  /** Every url passed to chrome.tabs.create, in order. */
  createdUrls: string[];
  /** Every [tabId, url] passed to chrome.tabs.update, in order. */
  navigations: [number, string][];
  /** Every tab id activated via chrome.tabs.update, in order. */
  activated: number[];
  /** Every window id passed to chrome.windows.update with focused. */
  focusedWindows: number[];
  /** Every notification created, in order. */
  notifications: { id: string; title: string; message: string }[];
  reloads: number[];
  debuggerAttached: Set<number>;
  debuggerDetaches: number[];
  storage: Map<string, unknown>;
  /** Seed a tab the extension did not open, e.g. one the user already had. */
  addTab(url: string): FakeTab;
  /** Drive a redirect the way a sign-in page would: same tab, new url. */
  setUrl(tabId: number, url: string): void;
  /** Whether a Chrome window holds OS focus; defaults to true. */
  setOsFocus(focused: boolean): void;
  /** Simulate the user clicking a notification. */
  clickNotification(id: string): void;
  /**
   * A signed-out account bounces every tab pointed at the target, not just the
   * one the last call happened to bind.
   */
  redirectAll(from: string, to: string): void;
}

export function createFakeChrome(): FakeChrome {
  const tabs = new Map<number, FakeTab>();
  const removed: number[] = [];
  const createdUrls: string[] = [];
  const navigations: [number, string][] = [];
  const activated: number[] = [];
  const focusedWindows: number[] = [];
  const notifications: { id: string; title: string; message: string }[] = [];
  const onNotificationClicked = new FakeEvent<[string]>();
  let osFocused = true;
  const reloads: number[] = [];
  const debuggerAttached = new Set<number>();
  const debuggerDetaches: number[] = [];
  const storage = new Map<string, unknown>();
  const onUpdated = new FakeEvent<
    [number, { status?: string }, FakeTab]
  >();
  const onRemoved = new FakeEvent<[number]>();
  const onMessage = new FakeEvent<[unknown, unknown, unknown]>();
  let nextTabId = 1;

  const addTab = (url: string): FakeTab => {
    const tab: FakeTab = { id: nextTabId++, url, status: "complete" };
    tabs.set(tab.id, tab);
    return tab;
  };

  // Chrome reports "complete" one turn after the navigation starts; resolving
  // it synchronously would let waitForLoad settle on the previous page.
  const completeSoon = (tab: FakeTab): void => {
    tab.status = "loading";
    queueMicrotask(() => {
      if (!tabs.has(tab.id)) return;
      tab.status = "complete";
      onUpdated.emit(tab.id, { status: "complete" }, tab);
    });
  };

  const api = {
    runtime: { onMessage },
    debugger: {
      async attach({ tabId }: { tabId: number }) {
        if (debuggerAttached.has(tabId)) {
          throw new Error(`Another debugger is already attached to the tab with id: ${tabId}`);
        }
        debuggerAttached.add(tabId);
      },
      async sendCommand(_target: unknown, command: string) {
        if (command === "Page.getLayoutMetrics") {
          return { cssContentSize: { width: 1200, height: 3400 } };
        }
        if (command === "Page.captureScreenshot") return { data: "fake-png" };
        throw new Error(`unexpected debugger command ${command}`);
      },
      async detach({ tabId }: { tabId: number }) {
        if (!debuggerAttached.delete(tabId)) throw new Error("Debugger is not attached");
        debuggerDetaches.push(tabId);
      },
    },
    tabs: {
      onUpdated,
      onRemoved,
      async query() {
        return [...tabs.values()].map((tab) => ({ ...tab }));
      },
      async create({ url }: { url: string }) {
        createdUrls.push(url);
        const tab = addTab(url);
        completeSoon(tab);
        return { ...tab };
      },
      async get(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return { ...tab };
      },
      async update(
        tabId: number,
        { url, active }: { url?: string; active?: boolean }
      ) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        if (active) activated.push(tabId);
        if (url !== undefined) {
          navigations.push([tabId, url]);
          tab.url = url;
          completeSoon(tab);
        }
        return { ...tab, windowId: 1 };
      },
      async reload(tabId: number) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        reloads.push(tabId);
        completeSoon(tab);
      },
      async remove(tabId: number) {
        removed.push(tabId);
        if (!tabs.delete(tabId)) {
          throw new Error(`No tab with id: ${tabId}.`);
        }
        onRemoved.emit(tabId);
      },
      async sendMessage(tabId: number, message: { type: string }) {
        if (!tabs.has(tabId)) {
          throw new Error(`No tab with id: ${tabId}.`);
        }
        if (message.type === "ping") return { ok: true };
        throw new Error(`unexpected tab message ${message.type}`);
      },
    },
    windows: {
      async update(windowId: number, { focused }: { focused?: boolean }) {
        if (focused) focusedWindows.push(windowId);
      },
      async getLastFocused() {
        return { id: 1, focused: osFocused };
      },
    },
    notifications: {
      onClicked: onNotificationClicked,
      async create(
        id: string,
        { title, message }: { title: string; message: string }
      ) {
        notifications.push({ id, title, message });
        return id;
      },
      async clear(id: string) {
        const index = notifications.findIndex((item) => item.id === id);
        if (index >= 0) notifications.splice(index, 1);
        return index >= 0;
      },
    },
    storage: {
      session: {
        async get(key: string) {
          return { [key]: storage.get(key) };
        },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) {
            storage.set(key, value);
          }
        },
        async remove(key: string) {
          storage.delete(key);
        },
      },
    },
  };

  return {
    api,
    tabs,
    removed,
    createdUrls,
    navigations,
    activated,
    focusedWindows,
    notifications,
    reloads,
    debuggerAttached,
    debuggerDetaches,
    storage,
    addTab,
    setUrl(tabId, url) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      tab.url = url;
    },
    setOsFocus(focused) {
      osFocused = focused;
    },
    clickNotification(id) {
      onNotificationClicked.emit(id);
    },
    redirectAll(from, to) {
      for (const tab of tabs.values()) {
        if (tab.url === from) tab.url = to;
      }
    },
  };
}
