import { afterEach, describe, expect, it } from "vitest";
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

  it("creates the first real target and removes the token-approved connect page", async () => {
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
        params: { url: "https://example.com/new" },
      })
    );
    await viWait(() => replies.some((row) => (row as { id?: number }).id === 2));

    expect(extension.commands.map((command) => command.method)).toContain("chrome.tabs.create");
    expect(
      extension.commands.filter((command) => command.method === "chrome.debugger.attach")
    ).toHaveLength(2); // the initial tab and the newly-created tab, once each
    expect(extension.commands).toContainEqual({
      method: "chrome.tabs.create",
      params: [{ url: "https://example.com/new" }],
    });
    expect(extension.commands).toContainEqual({
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
