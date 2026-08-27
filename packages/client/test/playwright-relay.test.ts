import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserModel } from "../src/playwright-relay/browser-model.js";
import { CDPRelayServer } from "../src/playwright-relay/cdp-relay.js";

class FakeExtension {
  readonly commands: { method: string; params: unknown }[] = [];
  private socket: WebSocket | undefined;
  private nextTabId = 1;

  async attach(endpoint: string): Promise<void> {
    this.socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("open", () => resolve());
      this.socket!.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (message.id === undefined || !message.method) return;
      this.commands.push({ method: message.method, params: message.params });
      const result = this.result(message.method, message.params);
      if (message.method === "chrome.tabs.create") {
        // Chrome emits onCreated as part of the same operation. The relay must
        // coalesce auto-attach with createTarget's explicit attach.
        this.socket!.send(JSON.stringify({ method: "chrome.tabs.onCreated", params: [result] }));
      }
      this.socket!.send(JSON.stringify({ id: message.id, result }));
    });
    this.socket.send(
      JSON.stringify({
        method: "chrome.tabs.onCreated",
        params: [
          {
            id: this.nextTabId,
            index: 0,
            windowId: 1,
            url: "https://example.com/",
            active: true,
            pinned: false,
          },
        ],
      })
    );
    this.socket.send(JSON.stringify({ method: "extension.initialized", params: [] }));
  }

  private result(method: string, params: unknown) {
    if (method === "chrome.tabs.create") {
      const [{ url }] = params as [{ url?: string }];
      this.nextTabId += 1;
      return {
        id: this.nextTabId,
        index: 1,
        windowId: 1,
        url: url ?? "about:blank",
        active: true,
        pinned: false,
      };
    }
    if (method === "chrome.debugger.sendCommand") {
      const [, cdpMethod] = params as [unknown, string];
      if (cdpMethod === "Target.getTargetInfo") {
        return { targetInfo: { targetId: `target-${this.nextTabId}`, type: "page" } };
      }
      return {};
    }
    return {};
  }

  close(): void {
    this.socket?.close();
  }
}

describe("Playwright CDP relay", () => {
  let relay: CDPRelayServer | undefined;
  let extension: FakeExtension | undefined;
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

  it("translates Target.createTarget into chrome.tabs.create after handshake", async () => {
    relay = new CDPRelayServer();
    await relay.start();
    extension = new FakeExtension();
    await extension.attach(relay.extensionEndpoint());
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
