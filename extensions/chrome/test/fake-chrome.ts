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
  reloads: number[];
  storage: Map<string, unknown>;
  /** Seed a tab the extension did not open, e.g. one the user already had. */
  addTab(url: string): FakeTab;
  /** Drive a redirect the way a sign-in page would: same tab, new url. */
  setUrl(tabId: number, url: string): void;
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
  const reloads: number[] = [];
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
      async update(tabId: number, { url }: { url: string }) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        navigations.push([tabId, url]);
        tab.url = url;
        completeSoon(tab);
        return { ...tab };
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
    reloads,
    storage,
    addTab,
    setUrl(tabId, url) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}.`);
      tab.url = url;
    },
    redirectAll(from, to) {
      for (const tab of tabs.values()) {
        if (tab.url === from) tab.url = to;
      }
    },
  };
}
