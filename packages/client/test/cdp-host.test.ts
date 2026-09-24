import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  endpointAvailable: false,
  connect: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock("node:fs", () => ({
  existsSync: () => state.endpointAvailable,
  readFileSync: () => "9222\n/devtools/browser/fake",
}));

vi.mock("puppeteer-core", () => ({
  default: {
    connect: () => state.connect?.(),
  },
}));

vi.mock("../src/auth-banner.js", () => ({
  showAuthBanner: async () => ({ update: () => {}, dispose: () => {} }),
}));
vi.mock("../src/launch-browser.js", () => ({ raiseChrome: async () => {} }));

import { createCdpBackend } from "../src/cdp-host.js";

interface FakeBrowser {
  connected: boolean;
  version(): Promise<string>;
  on(event: string, listener: () => void): void;
  pages(): Promise<never>;
  disconnect(): void;
  emitDisconnected(): void;
}

function fakeBrowser(): FakeBrowser {
  let disconnected: (() => void) | undefined;
  return {
    connected: true,
    async version() {
      return "Chrome/144.0.0.0";
    },
    on(event, listener) {
      if (event === "disconnected") disconnected = listener;
    },
    async pages() {
      throw new Error("page access is not part of this connection test");
    },
    disconnect() {
      // puppeteer emits "disconnected" when the client disconnects itself.
      this.emitDisconnected();
    },
    emitDisconnected() {
      this.connected = false;
      disconnected?.();
    },
  };
}

beforeEach(() => {
  state.endpointAvailable = false;
  state.connect = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CDP sign-in gate", () => {
  it("discards pre-login captures when a retry binds the departed kept tab", async () => {
    const origin = "https://example.com";
    const target = `${origin}/settings`;
    class GatePage extends EventEmitter {
      currentUrl = "about:blank";
      url() { return this.currentUrl; }
      isClosed() { return false; }
      mainFrame() { return this; }
      async goto() { this.currentUrl = `${origin}/login`; }
      async bringToFront() {}
      async title() { return "test"; }
      async reload() { this.emit("response", response(200)); }
      navigate(url: string) { this.currentUrl = url; }
    }
    const response = (status: number) => ({
      headers: () => ({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ signedIn: status === 200 }),
      url: () => `${origin}/api/usage`,
      request: () => ({ method: () => "GET" }),
      status: () => status,
    });
    const page = new GatePage();
    const browser = Object.assign(new EventEmitter(), {
      connected: true,
      version: async () => "Chrome/144.0.0.0",
      newPage: vi.fn(async () => page),
      pages: async () => [page],
    });
    const host = createCdpBackend(() => {}, {
      name: "test", pollForConnection: false, retryConnect: false,
      looksReady: () => true, probeLive: async () => true,
      connect: async () => browser as never,
      connectHint: () => "test", staleHint: () => "test",
    });
    await host.acquire();
    expect(await host.openAuthGate(origin, target)).toBe(true);
    // Install the capture listener while the original login form is open.
    const form = await host.bind({ target: `${origin}/login`, existingOnly: true, navigation: "reuse", loadTimeoutMs: 100 });
    expect(form.atAuthGate).toBe(true);
    page.emit("response", response(401));
    await Promise.resolve();
    expect((await form.readIntercepts(0, 0)).captures).toMatchObject([{ status: 401 }]);
    await host.finish(form, "close-if-created");

    page.navigate(target);
    expect(await host.hasOpenTarget?.(target)).toBe(true);
    const retry = await host.bind({ target, existingOnly: true, navigation: "reuse", loadTimeoutMs: 100 });
    expect(retry.atAuthGate).toBe(false);
    expect((await retry.readIntercepts(0, 0)).captures).toEqual([]);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    await host.finish(retry, "close-if-created");
  });

  it("keeps the original gate place across retries, but watches each new login step", async () => {
    const origin = "https://example.com";
    const target = `${origin}/login`;
    class GatePage extends EventEmitter {
      currentUrl = "about:blank";
      closed = false;
      url() { return this.currentUrl; }
      isClosed() { return this.closed; }
      mainFrame() { return this; }
      async goto(url: string) { this.currentUrl = url; }
      async bringToFront() {}
      async close() { this.closed = true; this.emit("close"); }
      navigate(url: string) { this.currentUrl = url; this.emit("framenavigated", this); }
    }
    const page = new GatePage();
    const browser = Object.assign(new EventEmitter(), {
      connected: true,
      version: async () => "Chrome/144.0.0.0",
      newPage: vi.fn(async () => page),
      pages: async () => [page],
      disconnect() { this.connected = false; this.emit("disconnected"); },
    });
    const host = createCdpBackend(() => {}, {
      name: "test", pollForConnection: false, retryConnect: false,
      looksReady: () => true, probeLive: async () => true,
      connect: async () => browser as never,
      connectHint: () => "test", staleHint: () => "test",
    });
    await host.acquire();
    expect(await host.openAuthGate(origin, target)).toBe(true);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    const exits: string[] = [];
    vi.useFakeTimers();
    try {
      let watch = await host.watchAuthGate(origin, (reason) => exits.push(reason));
      expect(watch).toBeDefined();
      page.navigate(`${origin}/login/password?step=1`);
      await vi.advanceTimersByTimeAsync(750);
      expect(exits).toEqual(["moved"]);
      watch!.dispose();
      expect(await host.findAuthGate(origin)).toBeUndefined();

      // A retry still needs auth on an intermediate page. Resume the same tab,
      // without treating its already-observed movement as a new move.
      expect(await host.watchAuthGate(origin, () => {})).toBeUndefined();
      watch = await host.watchAuthGate(origin, (reason) => exits.push(reason), true);
      expect(watch).toBeDefined();
      expect(browser.newPage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(750);
      expect(exits).toEqual(["moved"]);
      expect(await host.findAuthGate(origin)).toEqual({ url: page.url(), target });
      page.navigate(`${origin}/login/password?step=2#fragment`);
      await vi.advanceTimersByTimeAsync(750);
      expect(exits).toEqual(["moved"]);
      page.navigate(`${origin}/protected`);
      await vi.advanceTimersByTimeAsync(750);
      expect(exits).toEqual(["moved", "moved"]);
      watch!.dispose();
      // Even if the retry on /protected still says needs_auth, attaching a
      // fresh watcher must not make /protected the original gate place.
      watch = await host.watchAuthGate(origin, (reason) => exits.push(reason), true);
      expect(watch).toBeDefined();
      await vi.advanceTimersByTimeAsync(750);
      expect(exits).toEqual(["moved", "moved"]);
      watch!.dispose();
      expect(await host.findAuthGate(origin)).toBeUndefined();
      vi.useRealTimers();
      expect(await host.openAuthGate(origin, target)).toBe(true);
      expect(browser.newPage).toHaveBeenCalledTimes(2);
    } finally {
      await host.release();
    }
  });
});

describe("CDP host connection lifecycle", () => {
  it("publishes live connection and disconnection state", async () => {
    const browser = fakeBrowser();
    state.endpointAvailable = true;
    state.connect = vi.fn(async () => browser);
    const host = createCdpBackend();
    const statuses: boolean[] = [];
    host.onStatusChange(() => statuses.push(host.available()));

    host.start();
    await vi.waitFor(() => expect(host.available()).toBe(true));
    host.stop();
    expect(host.info()).toMatchObject({
      name: "cdp",
      detail: "Chrome/144.0.0.0",
      capabilities: [
        "browser-session",
        "credentialed-http",
        "credentialed-http-body",
        "same-origin-page-http",
      ],
    });
    expect(statuses).toEqual([true]);

    browser.emitDisconnected();
    expect(host.available()).toBe(false);
    expect(statuses).toEqual([true, false]);
  });

  it("releases the CDP lease without auto-reconnecting, and reacquires on demand", async () => {
    state.endpointAvailable = true;
    state.connect = vi.fn(async () => fakeBrowser());
    const host = createCdpBackend();
    host.start();
    await vi.waitFor(() => expect(host.available()).toBe(true));
    expect(host.lease()).toBe("held");

    await host.release();
    expect(host.available()).toBe(false);
    expect(host.lease()).toBe("released");

    // The endpoint poll must not silently reacquire (that would re-prompt the
    // user with a fresh Allow dialog in Chrome).
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(host.lease()).toBe("released");

    // An explicit acquire (or any lens call) reconnects.
    await host.acquire();
    expect(host.lease()).toBe("held");
    expect(state.connect).toHaveBeenCalledTimes(2);
    host.stop();
  });

  it("reacquires lazily when a request arrives after a release", async () => {
    state.endpointAvailable = true;
    state.connect = vi.fn(async () => fakeBrowser());
    const host = createCdpBackend();
    host.start();
    await vi.waitFor(() => expect(host.available()).toBe(true));
    await host.release();
    expect(host.lease()).toBe("released");

    await expect(
      host.bind({
        target: "https://example.com",
        loadTimeoutMs: 30_000,
        navigation: "fresh",
      })
    ).rejects.toThrow("page access is not part of this connection test");
    host.stop();

    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(host.lease()).toBe("held");
  });

  it("fails fast with actionable advice for a stale saved endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    state.endpointAvailable = true;
    state.connect = vi.fn(async () => {
      throw new Error("connect should not be attempted for a dead endpoint");
    });

    await expect(createCdpBackend().acquire()).rejects.toThrow(
      "Chrome remote debugging is not responding. " +
        "Open chrome://inspect/#remote-debugging in Chrome, " +
        "re-enable Remote Debugging, then retry."
    );
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("shares an in-flight connection between monitoring and a request", async () => {
    const browser = fakeBrowser();
    let resolveConnection!: (browser: FakeBrowser) => void;
    state.endpointAvailable = true;
    state.connect = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        })
    );
    const host = createCdpBackend();
    host.start();
    const request = host.bind({
      target: "https://example.com",
      loadTimeoutMs: 30_000,
      navigation: "fresh",
    });

    await vi.waitFor(() => expect(state.connect).toHaveBeenCalledTimes(1));
    resolveConnection(browser);
    await expect(request).rejects.toThrow("page access is not part of this connection test");
    host.stop();

    expect(state.connect).toHaveBeenCalledTimes(1);
  });
});
