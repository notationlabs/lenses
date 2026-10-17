import { afterEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer-core";
import { WebSocket } from "ws";
import { BrowserModel } from "../src/playwright-relay/browser-model.js";
import { CDPRelayServer } from "../src/playwright-relay/cdp-relay.js";

import { FakePlaywrightExtension } from "./playwright-relay-fake.js";

describe("Playwright CDP relay", () => {
  let relay: CDPRelayServer | undefined;
  let extension: FakePlaywrightExtension | undefined;
  let cdp: WebSocket | undefined;

  afterEach(() => {
    cdp?.close();
    extension?.close();
    relay?.stop();
    relay = undefined;
    extension = undefined;
    cdp = undefined;
  });

  it("detaches a tab when initialization fails", async () => {
    const commands: string[] = [];
    const model = new BrowserModel(async (method) => {
      commands.push(method);
      if (method === "chrome.tabs.create") {
        return {
          id: 1,
          index: 0,
          windowId: 1,
          active: true,
          pinned: false,
        };
      }
      if (method === "chrome.debugger.sendCommand") throw new Error("target disappeared");
      return undefined;
    });

    await expect(model.createTarget("https://example.com/")).rejects.toThrow(
      "target disappeared"
    );
    expect(commands).toEqual([
      "chrome.tabs.create",
      "chrome.debugger.attach",
      "chrome.debugger.sendCommand",
      "chrome.debugger.detach",
    ]);
  });

  it("accepts the beforeunload prompt of a tab it closes", async () => {
    const commands: { method: string; params: any }[] = [];
    const emitted: { method?: string }[] = [];
    const model: BrowserModel = new BrowserModel(async (method, params) => {
      commands.push({ method, params });
      if (method === "chrome.tabs.create") {
        return { id: 1, index: 0, windowId: 1, active: true, pinned: false };
      }
      if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "target-1", type: "page" } };
      }
      if (method === "chrome.tabs.remove") {
        // Chrome holds the tab open while the page's beforeunload prompt is up.
        model.onDebuggerEvent({ tabId: 1 }, "Page.javascriptDialogOpening", {
          type: "beforeunload",
          message: "",
        });
      }
      return undefined;
    });
    model.connectOverCDP((message) => emitted.push(message));

    const { targetId } = await model.createTarget("https://github.com/");
    await expect(model.closeTarget(targetId)).resolves.toEqual({ success: true });

    expect(commands).toContainEqual({
      method: "chrome.debugger.sendCommand",
      params: [{ tabId: 1 }, "Page.handleJavaScriptDialog", { accept: true }],
    });
    expect(emitted.map((row) => row.method)).not.toContain("Page.javascriptDialogOpening");
  });

  it("forwards the beforeunload prompt of a tab it is not closing", async () => {
    const commands: string[] = [];
    const emitted: { method?: string }[] = [];
    const model = new BrowserModel(async (method) => {
      commands.push(method);
      if (method === "chrome.tabs.create") {
        return { id: 1, index: 0, windowId: 1, active: true, pinned: false };
      }
      return { targetInfo: { targetId: "target-1", type: "page" } };
    });
    model.connectOverCDP((message) => emitted.push(message));

    await model.createTarget("https://github.com/");
    model.onDebuggerEvent({ tabId: 1 }, "Page.javascriptDialogOpening", {
      type: "beforeunload",
      message: "",
    });

    expect(emitted.map((row) => row.method)).toContain("Page.javascriptDialogOpening");
    expect(commands).not.toContain("chrome.tabs.remove");
  });

  it("names an attached target by its Chrome tab id", async () => {
    const model = new BrowserModel(async (method, params) => {
      if (method === "chrome.tabs.create") return { id: 7 };
      if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
        return { targetInfo: { targetId: `target-${params[0].tabId}`, type: "page" } };
      }
      return undefined;
    });
    model.connectOverCDP(() => {});

    expect(await model.createTarget("https://example.com")).toEqual({ targetId: "target-7" });
    expect(model.tabIdForTarget("target-7")).toBe(7);
    expect(model.tabIdForTarget("target-99")).toBeUndefined();
  });

  /** A model whose tab 1 Chrome refuses to re-attach while a password manager's frame is in it. */
  function detachableModel() {
    const blocked = { frame: true };
    const commands: string[] = [];
    const emitted: { method?: string; params?: any }[] = [];
    const logs: string[] = [];
    const links: string[] = [];
    let attaches = 0;
    const model = new BrowserModel(async (method, params) => {
      commands.push(method);
      if (method === "chrome.tabs.create") return { id: 1, index: 0, windowId: 1, active: true, pinned: false };
      if (method === "chrome.debugger.attach") {
        if (attaches++ > 0 && blocked.frame) {
          throw new Error("Cannot access a chrome-extension:// URL of different extension");
        }
        return undefined;
      }
      if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "target-1", type: "page" } };
      }
      return undefined;
    }, (message) => logs.push(message));
    model.connectOverCDP((message) => emitted.push(message));
    model.onTabLinkChange((tabId, link) => links.push(`${tabId}:${link.state}`));
    const tab = { id: 1, index: 0, windowId: 1, active: true, pinned: false };
    return { model, blocked, commands, emitted, logs, links, tab };
  }

  const attachCount = (commands: string[]) =>
    commands.filter((method) => method === "chrome.debugger.attach").length;

  it("keeps a detached tab the extension asks back for, and attaches it only when asked", async () => {
    const { model, blocked, commands, emitted, logs, links, tab } = detachableModel();
    await model.enableAutoAttach();
    await model.createTarget("https://bank.example/login");

    model.onDebuggerDetach({ tabId: 1 });
    expect(model.tabLink(1)).toEqual({ state: "disconnected" });
    expect(emitted.map((row) => row.method)).toContain("Target.detachedFromTarget");
    // The page object is gone, but the tab is still nameable.
    expect(model.tabIdForTarget("target-1")).toBe(1);

    // The extension's own retry (chrome.tabs.onCreated) fails while the frame is there.
    model.onTabCreated(tab);
    await vi.waitFor(() => expect(model.tabLink(1)?.lastError).toBeDefined());
    expect(model.tabLink(1)).toEqual({
      state: "disconnected",
      lastError: "Cannot access a chrome-extension:// URL of different extension",
    });
    expect(attachCount(commands)).toBe(2);

    // The frame goes and the tab's URL changes; the extension asks again.
    blocked.frame = false;
    model.onTabCreated(tab);
    await vi.waitFor(() => expect(model.tabLink(1)).toEqual({ state: "connected" }));
    expect(attachCount(commands)).toBe(3);
    expect(emitted.filter((row) => row.method === "Target.attachedToTarget")).toHaveLength(2);
    expect(links).toEqual(["1:connected", "1:disconnected", "1:connected"]);
    expect(logs).toContain("reattach tab 1 (extension retry)");
    expect(logs).toContain(
      "reattach tab 1 failed: Cannot access a chrome-extension:// URL of different extension"
    );
    expect(logs).toContain("reattached tab 1");
  });

  it("re-attaches a blocked tab on a sign-in wait's retry, never a tab out of the group", async () => {
    const { model, blocked, commands, logs, tab } = detachableModel();
    await model.enableAutoAttach();
    await model.createTarget("https://bank.example/login");
    model.onDebuggerDetach({ tabId: 1 });
    model.onTabCreated(tab);
    await vi.waitFor(() => expect(model.tabLink(1)?.lastError).toBeDefined());

    // Still blocked: the retry fails and the tab stays disconnected.
    expect((await model.retryAttach(1))?.state).toBe("disconnected");
    expect(attachCount(commands)).toBe(3);

    // The frame goes without a URL change; only the retry notices.
    blocked.frame = false;
    expect(await model.retryAttach(1)).toEqual({ state: "connected" });
    expect(logs).toContain("reattach tab 1 (sign-in wait retry)");

    // Attached or unknown tabs are left alone.
    expect(await model.retryAttach(1)).toEqual({ state: "connected" });
    expect(await model.retryAttach(99)).toBeUndefined();
    expect(attachCount(commands)).toBe(4);
  });

  it("attaches an attached tab afresh on request, leaving a blocked one for the sign-in retry", async () => {
    const { model, blocked, commands, emitted, logs } = detachableModel();
    await model.enableAutoAttach();
    await model.createTarget("https://bank.example/login");
    blocked.frame = false;

    expect(await model.refreshAttach(1)).toEqual({ state: "connected" });
    expect(commands).toContain("chrome.debugger.detach");
    expect(emitted.map((row) => row.method)).toEqual([
      "Target.attachedToTarget",
      "Target.detachedFromTarget",
      "Target.attachedToTarget",
    ]);
    expect(logs).toContain("refresh tab 1: its debugger session is unresponsive");
    expect(emitted[2]!.params.sessionId).not.toBe(emitted[0]!.params.sessionId);

    blocked.frame = true;
    expect((await model.refreshAttach(1))?.state).toBe("disconnected");
    blocked.frame = false;
    expect(await model.retryAttach(1)).toEqual({ state: "connected" });

    // Unknown tabs are left alone.
    expect(await model.refreshAttach(99)).toBeUndefined();
  });

  it("adopts a handed-over tab only while it is still the same target", async () => {
    const commands: { method: string; params: any }[] = [];
    const emitted: { method?: string; params?: any }[] = [];
    const logs: string[] = [];
    const model = new BrowserModel(async (method, params) => {
      commands.push({ method, params });
      if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
        // Tab 9 now holds a different page than the one handed over.
        const targetId = params[0].tabId === 9 ? "someone-else" : `target-${params[0].tabId}`;
        return { targetInfo: { targetId, type: "page" } };
      }
      return undefined;
    }, (message) => logs.push(message));
    model.connectOverCDP((message) => emitted.push(message));

    await model.adoptTabs([
      { tabId: 4, targetId: "target-4" },
      { tabId: 9, targetId: "target-9" },
    ]);
    // Nothing attaches until Puppeteer turns on auto-attach.
    expect(commands).toEqual([]);
    await model.enableAutoAttach();

    expect(model.tabLink(4)).toEqual({ state: "connected" });
    expect(model.tabIdForTarget("target-4")).toBe(4);
    expect(model.tabLink(9)).toBeUndefined();
    expect(commands).toContainEqual({ method: "chrome.debugger.detach", params: [{ tabId: 9 }] });
    expect(logs).toContain("handed-over tab 9 not adopted: tab 9 is no longer target target-9");
    expect(emitted.map((row) => row.params?.targetInfo?.targetId)).toEqual(["target-4"]);
  });

  it("does not retry a tab that left the group", async () => {
    vi.useFakeTimers();
    try {
      const { model, commands } = detachableModel();
      await model.enableAutoAttach();
      await model.createTarget("https://bank.example/login");
      model.onDebuggerDetach({ tabId: 1 });
      vi.advanceTimersByTime(2_000);
      expect(model.tabLink(1)).toEqual({ state: "removed" });
      expect(await model.retryAttach(1)).toEqual({ state: "removed" });
      expect(attachCount(commands)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a detach the extension never asks back for", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts a single detach as leaving the group", async () => {
      vi.useFakeTimers();
      const { model, links } = detachableModel();
      await model.enableAutoAttach();
      await model.createTarget("https://bank.example/login");
      model.onDebuggerDetach({ tabId: 1 });
      vi.advanceTimersByTime(1_999);
      expect(model.tabLink(1)?.state).toBe("disconnected");
      vi.advanceTimersByTime(1);
      expect(model.tabLink(1)).toEqual({ state: "removed" });

      model.onTabRemoved(1);
      expect(model.tabLink(1)).toEqual({ state: "closed" });
      expect(links).toEqual(["1:connected", "1:disconnected", "1:removed", "1:closed"]);
    });

    it("keeps a tab that re-detached within the extension's 3s cooldown", async () => {
      vi.useFakeTimers();
      const { model, blocked, commands, tab } = detachableModel();
      blocked.frame = false;
      await model.enableAutoAttach();
      await model.createTarget("https://bank.example/login");
      model.onDebuggerDetach({ tabId: 1 });
      vi.advanceTimersByTime(150);
      model.onTabCreated(tab);
      await vi.waitFor(() => expect(model.tabLink(1)?.state).toBe("connected"));

      // The next field focus reopens the password manager's menu: the
      // extension skips this retry.
      vi.advanceTimersByTime(1_000);
      model.onDebuggerDetach({ tabId: 1 });
      vi.advanceTimersByTime(60_000);
      expect(model.tabLink(1)).toEqual({ state: "disconnected" });

      // Its next URL change brings it back.
      model.onTabCreated(tab);
      await vi.waitFor(() => expect(model.tabLink(1)?.state).toBe("connected"));
      expect(attachCount(commands)).toBe(3);
    });

    it("never attaches a disconnected tab the user drags out", async () => {
      vi.useFakeTimers();
      const { model, blocked, commands, tab } = detachableModel();
      blocked.frame = false;
      await model.enableAutoAttach();
      await model.createTarget("https://bank.example/login");
      model.onDebuggerDetach({ tabId: 1 });
      model.onTabCreated(tab);
      await vi.waitFor(() => expect(model.tabLink(1)?.state).toBe("connected"));
      model.onDebuggerDetach({ tabId: 1 });
      const attaches = attachCount(commands);

      // Dragged out while detached: the extension sends nothing, and the
      // relay has no way to start an attach of its own.
      vi.advanceTimersByTime(60_000);
      expect(attachCount(commands)).toBe(attaches);
      expect("reattachTab" in model).toBe(false);
    });
  });

  it("accepts a real Puppeteer connection", async () => {
    relay = new CDPRelayServer();
    await relay.start();
    extension = new FakePlaywrightExtension();
    await extension.attach(relay.extensionEndpoint());
    await relay.waitForExtension();

    const browser = await puppeteer.connect({
      browserWSEndpoint: relay.cdpEndpoint(),
      defaultViewport: null,
    });
    expect(browser.connected).toBe(true);
    await browser.disconnect();
  });

  it("shows Puppeteer a handed-over tab as a page, without navigating it", async () => {
    relay = new CDPRelayServer();
    await relay.start();
    extension = new FakePlaywrightExtension();
    await extension.attach(relay.extensionEndpoint());
    await relay.waitForExtension();
    extension.openTab(5, "https://bank.example/accounts");
    await relay.adoptTabs([{ tabId: 5, targetId: "target-5" }]);

    const browser = await puppeteer.connect({
      browserWSEndpoint: relay.cdpEndpoint(),
      defaultViewport: null,
    });
    try {
      const urls = (await browser.targets()).map((target) => target.url());
      expect(urls).toContain("https://bank.example/accounts");
      expect(relay.tabIdForTarget("target-5")).toBe(5);
      expect(relay.tabLink(5)).toEqual({ state: "connected" });
      const commands = extension.commands.map((command) => command.params as any[]);
      expect(commands.some((params) => params?.[0]?.tabId === 5 && /Page\.(navigate|reload)/.test(params?.[1]))).toBe(false);
    } finally {
      await browser.disconnect();
    }
  });

  it("creates the first real target without prematurely activating it", async () => {
    relay = new CDPRelayServer();
    await relay.start();
    extension = new FakePlaywrightExtension();
    await extension.attach(
      relay.extensionEndpoint(),
      "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html"
    );
    await relay.waitForExtension();

    cdp = new WebSocket(relay.cdpEndpoint());
    await new Promise<void>((resolve, reject) => {
      cdp!.once("open", () => resolve());
      cdp!.once("error", reject);
    });

    const replies: unknown[] = [];
    cdp.on("message", (data) => replies.push(JSON.parse(data.toString())));
    cdp.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await viWait(() => replies.some((row) => (row as { id?: number }).id === 1));
    cdp.send(
      JSON.stringify({
        id: 2,
        method: "Target.createTarget",
        params: { url: "https://example.com/new", background: true },
      })
    );
    await viWait(() => replies.some((row) => (row as { id?: number }).id === 2));

    expect(extension.commands.map((command) => command.method)).toContain("chrome.tabs.create");
    expect(
      extension.commands.filter((command) => command.method === "chrome.debugger.attach")
    ).toHaveLength(2); // the initial tab and the newly-created tab, once each
    expect(extension.commands).toContainEqual({
      method: "chrome.tabs.create",
      params: [{ url: "https://example.com/new", active: false }],
    });
    expect(extension.commands).not.toContainEqual({
      method: "chrome.tabs.remove",
      params: [1],
    });
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 2,
        result: { targetId: "target-2" },
      })
    );
  });
});

function viWait(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
