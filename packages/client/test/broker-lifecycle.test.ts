import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleExitTimer, createShutdownSequence } from "../src/broker-lifecycle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface World {
  clients: number;
  extensionAttached: boolean;
  inFlight: number;
  browserLive: boolean;
}

function idleWorld(idleMs: number, options: { browserLive?: boolean; noBrowserMs?: number } = {}) {
  const world: World = {
    clients: 0,
    extensionAttached: false,
    inFlight: 0,
    browserLive: options.browserLive ?? true,
  };
  const exits: string[] = [];
  const timer = createIdleExitTimer({
    idleMs,
    noBrowserMs: options.noBrowserMs ?? 100,
    isIdle: () =>
      world.clients === 0 && !world.extensionAttached && world.inFlight === 0,
    browserLive: async () => world.browserLive,
    onExit: (reason) => void exits.push(reason),
  });
  timer.reset();
  return { world, exits, timer };
}

describe("idle self-exit", () => {
  it("exits after the long window when a browser is there but unused", async () => {
    const { exits } = idleWorld(1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(exits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual(["idle for 1000ms"]);
  });

  it("exits quickly when no browser is reachable at all", async () => {
    const { exits } = idleWorld(15 * 60_000, { browserLive: false, noBrowserMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    // No waiting out the long window: the broker cannot run a lens anyway.
    expect(exits).toEqual(["no browser is reachable"]);
  });

  it("stays resident while a client is connected", async () => {
    const { world, exits, timer } = idleWorld(1_000);
    world.clients = 1;
    timer.reset();
    expect(timer.armed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exits).toHaveLength(0);
  });

  it("stays resident with no browser while a client is connected", async () => {
    const { world, exits, timer } = idleWorld(1_000, { browserLive: false });
    world.clients = 1;
    timer.reset();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exits).toHaveLength(0);
  });

  it("stays resident while the extension is attached, so its socket survives", async () => {
    const { world, exits, timer } = idleWorld(1_000);
    world.extensionAttached = true;
    timer.reset();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exits).toHaveLength(0);
    // Detaching arms the countdown again.
    world.extensionAttached = false;
    timer.reset();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toEqual(["idle for 1000ms"]);
  });

  it("restarts the countdown on each activity, rather than exiting mid-window", async () => {
    const { world, exits, timer } = idleWorld(1_000);
    for (let tick = 0; tick < 5; tick += 1) {
      await vi.advanceTimersByTimeAsync(900);
      world.clients = 1;
      timer.reset();
      world.clients = 0;
      timer.reset();
    }
    expect(exits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toEqual(["idle for 1000ms"]);
  });

  it("does not exit when work arrives between the last reset and the deadline", async () => {
    const { world, exits } = idleWorld(1_000);
    world.inFlight = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exits).toHaveLength(0);
  });

  it("never arms when the window is disabled", async () => {
    const { exits, timer } = idleWorld(0, { browserLive: false });
    expect(timer.armed).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(exits).toHaveLength(0);
  });
});

describe("shutdown sequence", () => {
  it("drains in-flight work, releases the CDP lease, then exits", async () => {
    const order: string[] = [];
    let inFlight = 1;
    const shutdown = createShutdownSequence({
      inFlight: () => inFlight,
      drainTimeoutMs: 10_000,
      stopListening: () => order.push("stop listening"),
      closeSockets: () => order.push("close sockets"),
      release: async () => void order.push("release"),
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
      // Only the drain poll ticks here; the release bound uses the same hook.
      sleep: async (ms) => {
        if (ms !== 25) return;
        inFlight = 0;
        order.push("drain");
      },
    });
    await shutdown("test");
    // The port is freed first (a restarting client waits on it), but client
    // sockets outlive the drain so an in-flight call still gets its result.
    expect(order).toEqual([
      "stop listening",
      "drain",
      "close sockets",
      "release",
      "stop",
      "exit",
    ]);
  });

  it("gives up draining a wedged call and still releases the lease", async () => {
    const order: string[] = [];
    let now = 0;
    vi.setSystemTime(0);
    const shutdown = createShutdownSequence({
      inFlight: () => 1,
      drainTimeoutMs: 100,
      stopListening: () => order.push("stop listening"),
      closeSockets: () => order.push("close sockets"),
      release: async () => void order.push("release"),
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
      sleep: async (ms) => {
        now += ms;
        vi.setSystemTime(now);
      },
    });
    await shutdown("test");
    expect(order).toEqual(["stop listening", "close sockets", "release", "stop", "exit"]);
  });

  it("still exits when releasing the lease fails, and runs only once", async () => {
    const order: string[] = [];
    const shutdown = createShutdownSequence({
      inFlight: () => 0,
      drainTimeoutMs: 10,
      stopListening: () => order.push("stop listening"),
      closeSockets: () => order.push("close sockets"),
      release: async () => {
        throw new Error("cdp gone");
      },
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
    });
    await shutdown("first");
    await shutdown("second");
    expect(order).toEqual(["stop listening", "close sockets", "stop", "exit"]);
  });

  it("exits even when releasing the lease never settles", async () => {
    const order: string[] = [];
    const shutdown = createShutdownSequence({
      inFlight: () => 0,
      drainTimeoutMs: 10,
      releaseTimeoutMs: 5_000,
      stopListening: () => order.push("stop listening"),
      closeSockets: () => order.push("close sockets"),
      // Chrome can leave a connect attempt outstanding for tens of seconds.
      release: () => new Promise<void>(() => {}),
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
      sleep: async (ms) => {
        if (ms === 5_000) order.push("release timeout");
      },
    });
    await shutdown("test");
    expect(order).toEqual(["stop listening", "close sockets", "release timeout", "stop", "exit"]);
  });
});
