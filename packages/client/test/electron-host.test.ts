import { afterEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  createElectronRelay,
  type ElectronTabListener,
  type ElectronTabs,
} from "../src/electron-host.js";

/** The app's side: lens tabs, each with a debugger that answers what Puppeteer asks on attach. */
class FakeTabs implements ElectronTabs {
  readonly calls: string[] = [];
  readonly sent: { tabId: number; sessionId?: string; method: string }[] = [];
  readonly attached = new Set<number>();
  private readonly urls = new Map<number, string>();
  private readonly listeners = new Set<ElectronTabListener>();
  private nextId = 10;

  open(url: string): number {
    const id = ++this.nextId;
    this.urls.set(id, url);
    for (const listener of this.listeners) listener.created(id);
    return id;
  }

  list() {
    return [...this.urls.keys()];
  }
  async create(url?: string) {
    this.calls.push(`create ${url ?? ""}`);
    return this.open(url ?? "about:blank");
  }
  async close(tabId: number) {
    this.calls.push(`close ${tabId}`);
    this.urls.delete(tabId);
    for (const listener of this.listeners) listener.removed(tabId);
  }
  reveal(tabId: number) {
    this.calls.push(`reveal ${tabId}`);
  }
  async attach(tabId: number) {
    if (!this.urls.has(tabId)) throw new Error(`no lens tab ${tabId}`);
    if (this.attached.has(tabId)) throw new Error("Debugger is already attached");
    this.attached.add(tabId);
  }
  async detach(tabId: number) {
    this.attached.delete(tabId);
  }
  userAgent() {
    return "Lenses test";
  }
  listen(listener: ElectronTabListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  navigate(tabId: number, url: string) {
    this.urls.set(tabId, url);
    for (const listener of this.listeners) listener.updated(tabId, url);
  }
  emit(tabId: number, sessionId: string | undefined, method: string, params: unknown) {
    for (const listener of this.listeners) listener.event(tabId, sessionId, method, params);
  }

  async send(tabId: number, sessionId: string | undefined, method: string, params?: any) {
    if (!this.attached.has(tabId)) throw new Error(`tab ${tabId} is not attached`);
    this.sent.push({ tabId, ...(sessionId ? { sessionId } : {}), method });
    const url = this.urls.get(tabId) ?? "";
    const frame = { id: `frame-${tabId}`, loaderId: "loader", url, securityOrigin: "", mimeType: "text/html" };
    switch (method) {
      case "Target.getTargetInfo":
        return { targetInfo: { targetId: `target-${tabId}`, type: "page", url, title: "", attached: true, canAccessOpener: false } };
      case "Page.getFrameTree":
        return { frameTree: { frame } };
      case "Runtime.enable":
        queueMicrotask(() =>
          this.emit(tabId, sessionId, "Runtime.executionContextCreated", {
            context: { id: tabId, origin: "", name: "", uniqueId: `ctx-${tabId}`, auxData: { isDefault: true, type: "default", frameId: frame.id } },
          })
        );
        return {};
      case "Page.createIsolatedWorld":
        return { executionContextId: tabId + 100 };
    }
    return {};
  }
}

describe("electron relay", () => {
  let tabs: FakeTabs;
  let relay: ReturnType<typeof createElectronRelay> | undefined;
  let browser: Browser | undefined;

  async function connect() {
    relay = createElectronRelay(tabs);
    browser = await puppeteer.connect({ transport: relay.transport, defaultViewport: null });
    return browser;
  }

  afterEach(async () => {
    await browser?.disconnect().catch(() => {});
    relay?.dispose();
    browser = undefined;
    relay = undefined;
  });

  it("shows Puppeteer the lens tabs open when it connects", async () => {
    tabs = new FakeTabs();
    const lens = tabs.open("https://example.com/");
    await connect();
    const pages = await browser!.pages();
    expect(pages.map((page) => page.url())).toEqual(["https://example.com/"]);
    expect(tabs.attached).toEqual(new Set([lens]));
    expect(relay!.model.tabIdForTarget(`target-${lens}`)).toBe(lens);
  });

  it("opens a new page as a background lens tab, and closes it through the app", async () => {
    tabs = new FakeTabs();
    await connect();
    const page = await browser!.newPage({ background: true });
    const tabId = [...tabs.attached][0]!;
    expect(tabs.calls).toEqual(["create about:blank"]);
    expect(page.target().url()).toBe("about:blank");
    await page.close();
    expect(tabs.calls).toContain(`close ${tabId}`);
  });

  it("attaches a lens popup the app announces", async () => {
    tabs = new FakeTabs();
    await connect();
    const created = new Promise((resolve) => browser!.once("targetcreated", resolve));
    const popup = tabs.open("https://accounts.example/oauth");
    await created;
    expect(tabs.attached.has(popup)).toBe(true);
    expect((await browser!.pages()).map((page) => page.url())).toContain("https://accounts.example/oauth");
  });

  it("tells Puppeteer a tab's new URL when the app reports a navigation", async () => {
    tabs = new FakeTabs();
    const lens = tabs.open("");
    await connect();
    // Announced before its first load: the initial about:blank document.
    await expect.poll(() => browser!.targets().map((target) => target.url())).toContain("about:blank");
    const arrived = browser!.waitForTarget((target) => target.url() === "https://example.com/docs");
    tabs.navigate(lens, "https://example.com/docs");
    await arrived;
  });

  it("routes a child session (an out-of-process iframe) to its tab's debugger", async () => {
    tabs = new FakeTabs();
    const lens = tabs.open("https://example.com/");
    await connect();
    await browser!.pages();
    tabs.emit(lens, undefined, "Target.attachedToTarget", {
      sessionId: "child-1",
      targetInfo: { targetId: "frame-target", type: "iframe", url: "https://captcha.example/", title: "", attached: true, canAccessOpener: false },
      waitingForDebugger: true,
    });
    // Puppeteer resumes the paused frame on its own session.
    await expect.poll(() => tabs.sent.some((call) => call.sessionId === "child-1" && call.method === "Runtime.runIfWaitingForDebugger")).toBe(true);
    expect(tabs.sent.find((call) => call.sessionId === "child-1")?.tabId).toBe(lens);
  });

  it("lets go of every tab when the broker disconnects", async () => {
    tabs = new FakeTabs();
    tabs.open("https://example.com/");
    await connect();
    await browser!.pages();
    await browser!.disconnect();
    relay!.dispose();
    expect(tabs.attached.size).toBe(0);
    // The next broker can attach afresh.
    await connect();
    expect((await browser!.pages()).length).toBe(1);
  });
});
