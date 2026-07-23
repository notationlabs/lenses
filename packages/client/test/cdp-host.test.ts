import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  endpointAvailable: false,
  connect: undefined as undefined | (() => Promise<unknown>),
}));

vi.mock("node:fs", () => ({
  existsSync: () => state.endpointAvailable,
}));

vi.mock("puppeteer-core", () => ({
  default: {
    connect: () => state.connect?.(),
  },
}));

import { createCdpHost } from "../src/cdp-host.js";

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
    disconnect() {},
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
    const host = createCdpHost();
    const statuses: boolean[] = [];
    host.onStatusChange(() => statuses.push(host.available()));

    host.start();
    await vi.waitFor(() => expect(host.available()).toBe(true));
    host.stop();
    expect(host.info()).toBe("cdp Chrome/144.0.0.0");
    expect(statuses).toEqual([true]);

    browser.emitDisconnected();
    expect(host.available()).toBe(false);
    expect(statuses).toEqual([true, false]);
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
    const host = createCdpHost();
    host.start();
    const frames: unknown[] = [];
    const request = host.handle(
      { type: "observe", id: "observe_1", target: "https://example.com", waitMs: 0 },
      (frame) => frames.push(frame)
    );

    await vi.waitFor(() => expect(state.connect).toHaveBeenCalledTimes(1));
    resolveConnection(browser);
    await request;
    host.stop();

    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual({
      type: "result",
      id: "observe_1",
      result: { kind: "error", message: "page access is not part of this connection test" },
    });
  });
});
