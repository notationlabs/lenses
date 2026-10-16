import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth-banner.js", () => ({
  showAuthBanner: async () => ({ update: () => {}, dispose: () => {} }),
}));
vi.mock("../src/launch-browser.js", () => ({ raiseChrome: async () => {} }));

import { createCdpBackend, sameSite } from "../src/cdp-host.js";
import { TabClosed } from "../src/browser-backend.js";

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
