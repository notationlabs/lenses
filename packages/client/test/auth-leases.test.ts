import { afterEach, expect, test, vi } from "vitest";
import { createAuthLeases } from "../src/auth-leases.js";

afterEach(() => vi.useRealTimers());

test("joined calls share one gate but retain independent deadlines", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const updates: Array<[number, number]> = [];
  let exit!: (reason: "moved" | "closed" | "cancelled" | "expired") => void;
  const dispose = vi.fn();
  const watch = vi.fn(async (_origin, _target, callback) => {
    exit = callback;
    return { update: (deadline: number, count: number) => updates.push([deadline, count]), dispose };
  });
  const leases = createAuthLeases(watch);
  const first = leases.wait("https://example.com", "/login", 1_800);
  const second = leases.wait("https://example.com", "/login", 3_000);
  await Promise.resolve();
  expect(watch).toHaveBeenCalledTimes(1);
  expect(updates.at(-1)).toEqual([3_000, 2]);
  await vi.advanceTimersByTimeAsync(801);
  expect(await first).toBe("expired");
  expect(updates.at(-1)).toEqual([3_000, 1]);
  exit("moved");
  expect(await second).toBe("moved");
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("a disconnected caller leaves other waiters alone", async () => {
  const controller = new AbortController();
  let exit!: (reason: "moved" | "closed" | "cancelled" | "expired") => void;
  const leases = createAuthLeases(async (_origin, _target, callback) => {
    exit = callback;
    return { update() {}, dispose() {} };
  });
  const one = leases.wait("https://example.com", "/login", Date.now() + 5000, controller.signal);
  const two = leases.wait("https://example.com", "/login", Date.now() + 5000);
  await Promise.resolve();
  controller.abort();
  expect(await one).toBe("cancelled");
  exit("moved");
  expect(await two).toBe("moved");
});

test("periodic checks do not extend the original auth deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const dispose = vi.fn();
  const watch = vi.fn(async () => ({ update() {}, dispose }));
  const leases = createAuthLeases(watch);
  const first = leases.wait("https://example.com", "/login", 8_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await first).toBe("poll");
  expect(dispose).not.toHaveBeenCalled();
  const second = leases.wait("https://example.com", "/login", 8_000, undefined, true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await second).toBe("poll");
  expect(watch).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
  vi.setSystemTime(7_900);
  const last = leases.wait("https://example.com", "/login", 8_000, undefined, true);
  await vi.advanceTimersByTimeAsync(100);
  expect(await last).toBe("expired");
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("cancel ends every waiter", async () => {
  let exit!: (reason: "moved" | "closed" | "cancelled" | "expired") => void;
  const leases = createAuthLeases(async (_origin, _target, callback) => {
    exit = callback;
    return { update() {}, dispose() {} };
  });
  const one = leases.wait("https://example.com", "/login", Date.now() + 5000);
  const two = leases.wait("https://example.com", "/login", Date.now() + 5000);
  await Promise.resolve();
  exit("cancelled");
  expect(await Promise.all([one, two])).toEqual(["cancelled", "cancelled"]);
});
