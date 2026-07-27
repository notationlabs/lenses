import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleExitTimer, createShutdownSequence } from "../src/broker-lifecycle.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface World {
  clients: number;
  extensionAttached: boolean;
  inFlight: number;
}

function idleWorld(idleMs: number) {
  const world: World = { clients: 0, extensionAttached: false, inFlight: 0 };
  const exits: string[] = [];
  const timer = createIdleExitTimer({
    idleMs,
    isIdle: () =>
      world.clients === 0 && !world.extensionAttached && world.inFlight === 0,
    onExit: () => void exits.push("exit"),
  });
  timer.reset();
  return { world, exits, timer };
}

describe("idle self-exit", () => {
  it("exits after the idle window when nothing is using the broker", () => {
    const { exits } = idleWorld(1_000);
    vi.advanceTimersByTime(999);
    expect(exits).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(exits).toEqual(["exit"]);
  });

  it("stays resident while a client is connected", () => {
    const { world, exits, timer } = idleWorld(1_000);
    world.clients = 1;
    timer.reset();
    expect(timer.armed).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(exits).toHaveLength(0);
  });

  it("stays resident while the extension is attached, so its socket survives", () => {
    const { world, exits, timer } = idleWorld(1_000);
    world.extensionAttached = true;
    timer.reset();
    vi.advanceTimersByTime(5_000);
    expect(exits).toHaveLength(0);
    // Detaching arms the countdown again.
    world.extensionAttached = false;
    timer.reset();
    vi.advanceTimersByTime(1_000);
    expect(exits).toEqual(["exit"]);
  });

  it("restarts the countdown on each activity, rather than exiting mid-window", () => {
    const { world, exits, timer } = idleWorld(1_000);
    for (let tick = 0; tick < 5; tick += 1) {
      vi.advanceTimersByTime(900);
      world.clients = 1;
      timer.reset();
      world.clients = 0;
      timer.reset();
    }
    expect(exits).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(exits).toEqual(["exit"]);
  });

  it("does not exit when work arrives between the last reset and the deadline", () => {
    const { world, exits } = idleWorld(1_000);
    world.inFlight = 1;
    vi.advanceTimersByTime(1_000);
    expect(exits).toHaveLength(0);
  });

  it("never arms when the window is disabled", () => {
    const { exits, timer } = idleWorld(0);
    expect(timer.armed).toBe(false);
    vi.advanceTimersByTime(60 * 60_000);
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
      release: async () => void order.push("release"),
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
      sleep: async () => {
        inFlight = 0;
        order.push("drain");
      },
    });
    await shutdown("test");
    expect(order).toEqual(["drain", "release", "stop", "exit"]);
  });

  it("gives up draining a wedged call and still releases the lease", async () => {
    const order: string[] = [];
    let now = 0;
    vi.setSystemTime(0);
    const shutdown = createShutdownSequence({
      inFlight: () => 1,
      drainTimeoutMs: 100,
      release: async () => void order.push("release"),
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
      sleep: async (ms) => {
        now += ms;
        vi.setSystemTime(now);
      },
    });
    await shutdown("test");
    expect(order).toEqual(["release", "stop", "exit"]);
  });

  it("still exits when releasing the lease fails, and runs only once", async () => {
    const order: string[] = [];
    const shutdown = createShutdownSequence({
      inFlight: () => 0,
      drainTimeoutMs: 10,
      release: async () => {
        throw new Error("cdp gone");
      },
      stop: () => order.push("stop"),
      exit: () => order.push("exit"),
    });
    await shutdown("first");
    await shutdown("second");
    expect(order).toEqual(["stop", "exit"]);
  });
});
