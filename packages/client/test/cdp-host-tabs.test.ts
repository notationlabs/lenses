import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth-banner.js", () => ({
  showAuthBanner: async () => ({ update: () => {}, dispose: () => {} }),
}));
vi.mock("../src/launch-browser.js", () => ({ raiseChrome: async () => {} }));

import { createCdpBackend, sameSite } from "../src/cdp-host.js";
import { TabClosed, TabDisconnected } from "../src/browser-backend.js";
import { createAuthLeases } from "../src/auth-leases.js";
import type { TabLink } from "../src/playwright-relay/browser-model.js";

const origin = "https://bank.example";

/** A tab whose session lives in the document: any load or reload signs it out. */
class SpaPage extends EventEmitter {
  currentUrl = "about:blank";
  closed = false;
  loads: string[] = [];
  reloads = 0;
  routes: string[] = [];
  foregrounded = 0;
  /** Where the app's boot-time session check sends a fresh document, if anywhere. */
  bootRedirect: string | undefined;
  private booting = false;
  constructor(private readonly owner: () => unknown) { super(); }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  browser() { return this.owner(); }
  mainFrame() { return this; }
  async title() { return "Bank"; }
  async bringToFront() { this.foregrounded += 1; }
  async goto(url: string) { this.loads.push(url); this.currentUrl = url; this.booting = true; }
  async reload() { this.reloads += 1; }
  /** Selectors the rendered page currently matches. */
  present = new Set<string>();
  async evaluate(_fn: unknown, arg: string) {
    // Routing passes a path; a ready probe passes a selector.
    if (!arg.startsWith("/")) return this.present.has(arg);
    this.routes.push(arg);
    this.currentUrl = `${origin}${arg}`;
  }
  /** The app finishes booting while its requests are in flight. */
  async waitForNetworkIdle() {
    if (this.booting && this.bootRedirect) this.currentUrl = this.bootRedirect;
    this.booting = false;
  }
  async close() { this.closed = true; this.emit("close"); }
}

function setup({ keyed = true } = {}) {
  const pages: SpaPage[] = [];
  const keys = new WeakMap<SpaPage, string>();
  const browser = Object.assign(new EventEmitter(), {
    connected: true,
    version: async () => "Chrome/144.0.0.0",
    newPage: vi.fn(async () => {
      const page = new SpaPage(() => browser);
      pages.push(page);
      return page;
    }),
    pages: async () => pages.filter((page) => !page.closed),
  });
  const host = createCdpBackend(() => {}, {
    name: "test", pollForConnection: false, retryConnect: false,
    looksReady: () => true, probeLive: async () => true,
    connect: async () => browser as never,
    connectHint: () => "test", staleHint: () => "test",
    tabKey: (page: SpaPage) => {
      if (!keyed) return undefined;
      if (!keys.has(page)) keys.set(page, String(pages.indexOf(page) + 1));
      return keys.get(page);
    },
  } as never);
  return { host, browser, pages };
}

describe("tab reuse and in-page navigation", () => {
  it("binds one tab per origin, routes in-page, and never closes it", async () => {
    const { host, browser, pages } = setup();
    const first = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true,
      navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(first.created).toBe(true);
    await host.finish(first, "close-if-created");
    expect(pages[0].closed).toBe(false);

    const second = await host.bind({
      target: `${origin}/statements?account=1`, reuse: true, inPage: true,
      navigation: "fresh", loadTimeoutMs: 100,
    });
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(second.created).toBe(false);
    expect(second.navigated).toBe(true);
    expect(second.tab).toBe(first.tab);
    expect(pages[0].loads).toEqual([`${origin}/account-summary`]);
    expect(pages[0].routes).toEqual(["/statements?account=1"]);
    expect(pages[0].reloads).toBe(0);

    // An intercept miss under in-page navigation re-routes, never reloads.
    await second.reload(100);
    expect(pages[0].reloads).toBe(0);
    expect(pages[0].routes).toHaveLength(2);
    await host.finish(second, "close-if-created");
    expect(pages[0].closed).toBe(false);
  });

  it("does not reload a reused tab already at the target", async () => {
    const { host, pages } = setup();
    const first = await host.bind({
      target: `${origin}/a`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(first, "close-if-created");
    const again = await host.bind({
      target: `${origin}/a`, reuse: true, inPage: true, navigation: "fresh", loadTimeoutMs: 100,
    });
    expect(again.navigated).toBe(false);
    expect(pages[0].reloads).toBe(0);
    expect(pages[0].routes).toEqual([]);
  });

  it("binds a tab by id in place, and fails a closed tab with TabClosed", async () => {
    const { host, browser, pages } = setup();
    const opened = await host.bind({
      target: `${origin}/login`, reuse: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(opened, "close-if-created");
    pages[0].currentUrl = `${origin}/account-summary`;

    const inPlace = await host.bind({ tab: opened.tab, navigation: "reuse", loadTimeoutMs: 100 });
    expect(inPlace.tab).toBe(opened.tab);
    expect(inPlace.navigated).toBe(false);
    expect(pages[0].loads).toHaveLength(1);
    expect(pages[0].routes).toEqual([]);
    await host.finish(inPlace, "close-if-created");
    expect(pages[0].closed).toBe(false);

    const routed = await host.bind({
      tab: opened.tab, target: `${origin}/payees`, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(pages[0].routes).toEqual(["/payees"]);
    await host.finish(routed, "close-if-created");

    await pages[0].close();
    await expect(host.bind({ tab: opened.tab, navigation: "reuse", loadTimeoutMs: 100 }))
      .rejects.toBeInstanceOf(TabClosed);
    expect(await host.hasOpenTarget?.(`${origin}/payees`, { tab: opened.tab })).toBe(false);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
  });

  it("lets an auth retry follow the reused tab through a multi-step sign-in", async () => {
    const { host, browser, pages } = setup();
    const target = `${origin}/account-summary`;
    const gate = await host.bind({ target, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100 });
    // The app redirects to its login route; the call keeps the tab for sign-in.
    pages[0].currentUrl = `${origin}/login`;
    await host.finish(gate, "keep");

    pages[0].currentUrl = `${origin}/login/security-details/option-2`;
    expect(await host.hasOpenTarget?.(target)).toBe(false);
    expect(await host.hasOpenTarget?.(target, { reuse: true })).toBe(true);
    const retry = await host.bind({
      target, reuse: true, inPage: true, existingOnly: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    // A retry reads the tab where sign-in has taken it, without moving it.
    expect(retry.atAuthGate).toBe(false);
    expect(pages[0].routes).toEqual([]);
    expect(pages[0].currentUrl).toBe(`${origin}/login/security-details/option-2`);
    await host.finish(retry, "close-if-created");
    expect(pages[0].closed).toBe(false);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
  });

  it("lets an in-page app finish booting before tiers read a fresh tab", async () => {
    const { host, browser } = setup();
    browser.newPage.mockImplementationOnce(async () => {
      const page = new SpaPage(() => browser);
      page.bootRedirect = `${origin}/login`;
      return page;
    });
    const session = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    // The transient /account-summary screen is gone; a needs_auth matcher sees /login.
    expect((await session.recordingState()).url).toBe(`${origin}/login`);
  });

  it("brings a reused tab to the front when it needs sign-in", async () => {
    const { host, pages } = setup();
    const session = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(session, "keep");
    expect(pages[0].foregrounded).toBe(1);
    expect(await host.findAuthGate(origin)).toMatchObject({ target: `${origin}/account-summary` });
  });

  it("gives a tab without a transport key no id", async () => {
    const { host } = setup({ keyed: false });
    const session = await host.bind({
      target: `${origin}/account-summary`, reuse: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(session.tab).toBeUndefined();
  });

  it("keeps closing ordinary created tabs", async () => {
    const { host, pages } = setup();
    const session = await host.bind({ target: `${origin}/public`, navigation: "reuse", loadTimeoutMs: 100 });
    await host.finish(session, "close-if-created");
    expect(pages[0].closed).toBe(true);
  });
});

describe("tabs outside the group", () => {
  /**
   * One Chrome, many broker connections. Like the Playwright Extension, a
   * connection only sees tabs in its group: the ones it opened. A tab keeps
   * its Chrome id across connections, but leaves the group when one ends.
   */
  function chrome() {
    const tabs = new Map<string, SpaPage>();
    let nextId = 100;
    const connect = () => {
      const visible = new Set<SpaPage>();
      const browser: Record<string, unknown> = Object.assign(new EventEmitter(), {
        connected: true,
        version: async () => "Chrome/144.0.0.0",
        newPage: vi.fn(async () => {
          const page = new SpaPage(() => browser);
          tabs.set(String(nextId++), page);
          visible.add(page);
          return page;
        }),
        pages: async () => [...visible].filter((page) => !page.closed),
      });
      const transport = {
        name: "test", pollForConnection: false, retryConnect: false,
        looksReady: () => true, probeLive: async () => true,
        connect: async () => browser as never,
        connectHint: () => "test", staleHint: () => "test",
        tabKey: (page: SpaPage) => [...tabs].find(([, tab]) => tab === page)?.[0],
      };
      return { browser, transport, visible };
    };
    return { tabs, connect };
  }

  it("opens a new tab after a restart instead of pulling the old one back into the group", async () => {
    const world = chrome();
    const first = world.connect();
    const before = createCdpBackend(() => {}, first.transport as never);
    const opened = await before.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await before.finish(opened, "close-if-created");

    const second = world.connect();
    const after = createCdpBackend(() => {}, second.transport as never);
    const resumed = await after.bind({
      target: `${origin}/payees`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(second.browser.newPage).toHaveBeenCalledTimes(1);
    expect(resumed.tab).toBe("t101");
    const old = world.tabs.get("100")!;
    expect(old.loads).toEqual([`${origin}/account-summary`]);
    expect(old.routes).toEqual([]);
  });

  it("reports a tab named by id as closed once it is outside the group", async () => {
    const world = chrome();
    const first = world.connect();
    const before = createCdpBackend(() => {}, first.transport as never);
    const opened = await before.bind({ target: `${origin}/a`, navigation: "reuse", loadTimeoutMs: 100 });
    await before.finish(opened, "keep");

    const second = world.connect();
    const after = createCdpBackend(() => {}, second.transport as never);
    await expect(after.bind({ tab: opened.tab, navigation: "reuse", loadTimeoutMs: 100 }))
      .rejects.toBeInstanceOf(TabClosed);
    await after.acquire();
    expect(await after.hasOpenTarget?.(`${origin}/a`, { tab: opened.tab })).toBe(false);
    expect(second.browser.newPage).not.toHaveBeenCalled();
  });

  it("finds the reused tab again after a full navigation replaces its page object", async () => {
    const world = chrome();
    const { browser, transport, visible } = world.connect();
    const host = createCdpBackend(() => {}, transport as never);
    const first = await host.bind({
      target: `${origin}/login`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(first, "keep");

    // Signing in forces a document load: the debugger re-attaches the same
    // Chrome tab, and puppeteer hands out a new page object for it.
    const before = world.tabs.get("100")!;
    before.closed = true;
    const after = new SpaPage(() => browser);
    after.currentUrl = `${origin}/account-summary?isForcedNavigation=true`;
    world.tabs.set("100", after);
    visible.add(after);

    const session = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(session.tab).toBe("t100");
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(after.loads).toEqual([]);
  });

  it("signs in on the reused tab instead of opening a sign-in tab", async () => {
    const world = chrome();
    const { browser, transport } = world.connect();
    const host = createCdpBackend(() => {}, transport as never);
    const opened = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(opened, "close-if-created");

    expect(await host.openAuthGate?.(origin, `${origin}/account-summary`)).toBe(true);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(world.tabs.get("100")!.foregrounded).toBe(1);
    expect(await host.findAuthGate(origin)).toMatchObject({ target: `${origin}/account-summary` });
  });
});

describe("same-site reuse", () => {
  it("treats a bank's logout host as the same site, and other sites as not", () => {
    expect(sameSite("https://www.rbs.co.uk/business/logout.html", origin)).toBe(false); // bank.example fixture
    const bank = "https://www.digitalbanking.rbs.co.uk";
    expect(sameSite("https://www.rbs.co.uk/business/logout.html", bank)).toBe(true);
    expect(sameSite("https://evil.co.uk/", bank)).toBe(false);
    expect(sameSite("https://app.example.com/x", "https://www.example.com")).toBe(true);
    expect(sameSite("chrome://newtab/", bank)).toBe(false);
  });

  it("reuses a signed-out tab on the site's logout page instead of opening another", async () => {
    const { host, browser, pages } = setup();
    const first = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(first, "close-if-created");
    pages[0].currentUrl = "https://www.bank.example/logout.html";
    const again = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    expect(again.tab).toBe(first.tab);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    // Cross-origin, so the lens URL is loaded, not routed.
    expect(pages[0].loads).toEqual([`${origin}/account-summary`, `${origin}/account-summary`]);
  });

  it("waits for a lens ready selector, or a page that needs the user", async () => {
    const { host, browser } = setup();
    const timed = (after: (page: SpaPage) => void) =>
      browser.newPage.mockImplementationOnce(async () => {
        const page = new SpaPage(() => browser);
        const goto = page.goto.bind(page);
        page.goto = async (url: string) => {
          await goto(url);
          setTimeout(() => after(page), 30);
        };
        return page;
      });
    const bindReady = () => host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse",
      loadTimeoutMs: 5000, ready: "#accounts",
      holdAt: async (page) => page.url.endsWith("/login"),
    });

    // The app shows an error screen, then redirects to sign-in on a timer.
    timed((page) => { page.currentUrl = `${origin}/login`; });
    let started = Date.now();
    const signedOut = await bindReady();
    expect((await signedOut.recordingState()).url).toBe(`${origin}/login`);
    expect(Date.now() - started).toBeLessThan(2000);
    await host.finish(signedOut, "close-if-created");
  });

  it("returns as soon as the ready selector renders", async () => {
    const { host, browser } = setup();
    browser.newPage.mockImplementationOnce(async () => {
      const page = new SpaPage(() => browser);
      const goto = page.goto.bind(page);
      page.goto = async (url: string) => {
        await goto(url);
        setTimeout(() => page.present.add("#accounts"), 30);
      };
      return page;
    });
    const started = Date.now();
    await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse",
      loadTimeoutMs: 5000, ready: "#accounts",
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(2000);
  });

  it("adds no fixed delay without a ready selector", async () => {
    const { host } = setup();
    const started = Date.now();
    await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 5000,
    });
    // Only the post-load grace (LOAD_GRACE_MS) remains.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("tabs part-way through sign-in", () => {
  it("leaves a reused tab on a sign-in page where it is", async () => {
    const { host, pages } = setup();
    const first = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
    });
    await host.finish(first, "close-if-created");
    pages[0].currentUrl = `${origin}/login/security-details/option-2`;
    const seen: string[] = [];
    const held = await host.bind({
      target: `${origin}/account-summary`, reuse: true, inPage: true, navigation: "reuse", loadTimeoutMs: 100,
      holdAt: async ({ url }) => { seen.push(url); return url.includes("/login"); },
    });
    expect(seen).toEqual([`${origin}/login/security-details/option-2`]);
    expect(held.navigated).toBe(false);
    expect(pages[0].routes).toEqual([]);
    expect(pages[0].currentUrl).toBe(`${origin}/login/security-details/option-2`);
  });
});

describe("tabs the debugger loses", () => {
  const passwordManager = "Cannot access a chrome-extension:// URL of different extension";

  /**
   * Like the Playwright Extension relay: a password manager's frame makes
   * Chrome detach the debugger from the whole tab. The tab stays open in the
   * group, its page object goes away, and re-attaching fails until the frame
   * is gone.
   */
  function relayChrome() {
    const tabs = new Map<string, SpaPage>();
    const keys = new WeakMap<SpaPage, string>();
    const links = new Map<string, TabLink>();
    const listeners = new Set<(key: string, link: TabLink) => void>();
    const visible = new Set<SpaPage>();
    let nextId = 100;
    const setLink = (key: string, link: TabLink) => {
      links.set(key, link);
      for (const listener of listeners) listener(key, link);
    };
    const browser: Record<string, unknown> = Object.assign(new EventEmitter(), {
      connected: true,
      version: async () => "Chrome/144.0.0.0",
      newPage: vi.fn(async () => {
        const page = new SpaPage(() => browser);
        const key = String(nextId++);
        tabs.set(key, page);
        keys.set(page, key);
        links.set(key, { state: "connected" });
        visible.add(page);
        return page;
      }),
      pages: async () => [...visible].filter((page) => !page.closed),
    });
    /** The debugger has the tab again: Puppeteer hands out a new page object for it. */
    const reconnect = (key: string) => {
      const after = new SpaPage(() => browser);
      after.currentUrl = tabs.get(key)!.currentUrl;
      tabs.set(key, after);
      keys.set(after, key);
      visible.add(after);
      setLink(key, { state: "connected" });
      return after;
    };
    const transport = {
      name: "test", pollForConnection: false, retryConnect: false,
      looksReady: () => true, probeLive: async () => true,
      connect: async () => browser as never,
      connectHint: () => "test", staleHint: () => "test",
      tabKey: (page: SpaPage) => keys.get(page),
      tabLink: (key: string) => links.get(key),
      onTabLinkChange(listener: (key: string, link: TabLink) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      browser: browser as { newPage: ReturnType<typeof vi.fn> },
      transport,
      tabs,
      reconnect,
      /** Chrome lets go of the tab; it stays open in the group. */
      detach(key: string) {
        const page = tabs.get(key)!;
        setLink(key, { state: "disconnected" });
        visible.delete(page);
        page.closed = true;
        page.emit("close");
      },
      /** The extension asks for the tab back, and Chrome refuses while the frame is there. */
      retryFails(key: string) {
        setLink(key, { state: "disconnected", lastError: passwordManager });
      },
      /** A detach the extension never asked to undo: the user dragged the tab out. */
      dragOut(key: string) {
        setLink(key, { state: "removed" });
      },
    };
  }

  const reuse = (target = `${origin}/account-summary`) => ({
    target, reuse: true, inPage: true, navigation: "reuse" as const, loadTimeoutMs: 100,
  });

  it("does not open a second tab when the reused tab detaches and later re-attaches", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const first = await host.bind(reuse(`${origin}/login`));
    await host.finish(first, "close-if-created");

    chrome.detach("100");
    chrome.retryFails("100");
    const failure = await host.bind(reuse()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TabDisconnected);
    expect(failure).toMatchObject({ tab: "t100", url: `${origin}/login`, detail: passwordManager });
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);

    // The frame goes and the tab's URL changes; the extension re-attaches it.
    chrome.reconnect("100");
    const again = await host.bind(reuse());
    expect(again.tab).toBe("t100");
    expect(again.created).toBe(false);
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);
  });

  it("finds a tab the extension re-attached on its own", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const first = await host.bind(reuse());
    await host.finish(first, "close-if-created");
    chrome.detach("100");
    chrome.reconnect("100");

    const again = await host.bind({ tab: first.tab, navigation: "reuse", loadTimeoutMs: 100 });
    expect(again.tab).toBe("t100");
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);
  });

  it("forgets a tab that detached and never re-attached", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const first = await host.bind(reuse());
    await host.finish(first, "close-if-created");
    chrome.detach("100");
    chrome.dragOut("100");

    await expect(host.bind({ tab: first.tab, navigation: "reuse", loadTimeoutMs: 100 }))
      .rejects.toThrow("tab t100 is no longer in the Lenses tab group");
    const next = await host.bind(reuse());
    expect(next.tab).toBe("t101");
    expect(next.created).toBe(true);
    expect(chrome.tabs.get("100")!.loads).toEqual([`${origin}/account-summary`]);
  });

  it("says a closed tab was closed", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const first = await host.bind(reuse());
    await host.finish(first, "close-if-created");
    await chrome.tabs.get("100")!.close();
    chrome.transport.tabLink = (key: string) => (key === "100" ? { state: "closed" } : undefined);

    await expect(host.bind({ tab: first.tab, navigation: "reuse", loadTimeoutMs: 100 }))
      .rejects.toThrow("tab t100 was closed");
    await expect(host.bind({ tab: "t999", navigation: "reuse", loadTimeoutMs: 100 }))
      .rejects.toThrow("tab t999 is closed or no longer in the Lenses tab group");
  });

  it("keeps the sign-in wait through a detach, and retries once the tab re-attaches", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const target = `${origin}/account-summary`;
    const gate = await host.bind(reuse());
    chrome.tabs.get("100")!.currentUrl = `${origin}/login`;
    await host.finish(gate, "keep");

    const leases = createAuthLeases((gateOrigin, _target, onExit, resume) =>
      host.watchAuthGate!(gateOrigin, onExit, resume));
    leases.retain(origin);
    const waiting = leases.wait(origin, target, Date.now() + 10_000);
    await vi.waitFor(async () => expect(await host.findAuthGate(origin)).toBeDefined());

    // The user focuses the password field; the password manager's frame detaches the tab.
    chrome.detach("100");
    chrome.retryFails("100");
    expect(await waiting).toBe("poll");
    expect(await host.findAuthGate(origin)).toMatchObject({ url: `${origin}/login`, target });

    // Each poll tick's retry finds it still detached: still signing in.
    await expect(host.hasOpenTarget!(target, { reuse: true })).rejects.toMatchObject({
      tab: "t100", detail: passwordManager,
    });
    expect(await host.openAuthGate!(origin, target)).toBe(true);
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);

    // The extension re-attaches it: the wait ends as a move, and the retry reads the same tab.
    const next = leases.wait(origin, target, Date.now() + 10_000);
    await vi.waitFor(async () => expect(await host.findAuthGate(origin)).toBeDefined());
    chrome.reconnect("100");
    expect(await next).toBe("moved");
    expect(await host.hasOpenTarget!(target, { reuse: true })).toBe(true);
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);
    leases.close(origin);
  });

  it("ends the sign-in wait when the detached tab is dragged out of the group", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const gate = await host.bind(reuse(`${origin}/login`));
    await host.finish(gate, "keep");
    const exits: string[] = [];
    const prompt = await host.watchAuthGate!(origin, (reason) => exits.push(reason));
    expect(prompt).toBeDefined();

    chrome.detach("100");
    expect(exits).toEqual([]);
    chrome.dragOut("100");
    expect(exits).toEqual(["closed"]);
    prompt!.dispose();
    expect(await host.findAuthGate(origin)).toBeUndefined();
  });

  it("signs in on a reused tab it finds detached, without opening another", async () => {
    const chrome = relayChrome();
    const host = createCdpBackend(() => {}, chrome.transport as never);
    const target = `${origin}/account-summary`;
    const first = await host.bind(reuse());
    await host.finish(first, "close-if-created");
    chrome.detach("100");

    await expect(host.bind(reuse())).rejects.toBeInstanceOf(TabDisconnected);
    // Not a gate for a fresh call: that call should try re-attaching instead.
    expect(await host.findAuthGate(origin)).toBeUndefined();
    expect(await host.openAuthGate!(origin, target)).toBe(true);
    const exits: string[] = [];
    const prompt = await host.watchAuthGate!(origin, (reason) => exits.push(reason));
    expect(prompt).toBeDefined();
    expect(chrome.browser.newPage).toHaveBeenCalledTimes(1);

    chrome.reconnect("100");
    expect(exits).toEqual(["moved"]);
    prompt!.dispose();
  });
});
