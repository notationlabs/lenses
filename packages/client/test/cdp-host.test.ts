import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(host.info()).toEqual({ name: "cdp", detail: "Chrome/144.0.0.0" });
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
