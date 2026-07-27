import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRespawnLock,
  coordinateRespawn,
  respawnLockPath,
} from "../src/broker-respawn.js";
import { computeBuildStamp } from "../src/broker-stamp.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lens-respawn-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("respawn coordination", () => {
  it("grants the lock to one holder at a time", () => {
    const path = respawnLockPath(4319, root);
    const first = acquireRespawnLock(path);
    expect(first).not.toBeNull();
    expect(acquireRespawnLock(path)).toBeNull();
    first?.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireRespawnLock(path);
    expect(second).not.toBeNull();
    second?.release();
  });

  it("respawns exactly once when several clients see a stale stamp", async () => {
    const lockPath = respawnLockPath(4319, root);
    let respawns = 0;
    const respawn = async () => {
      respawns += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        coordinateRespawn(4319, { respawn, lockPath, waitMs: 2_000, pollMs: 5 })
      )
    );
    expect(respawns).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "respawned")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "waited")).toHaveLength(4);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the respawn fails", async () => {
    const lockPath = respawnLockPath(4319, root);
    await expect(
      coordinateRespawn(4319, {
        respawn: async () => {
          throw new Error("shutdown failed");
        },
        lockPath,
      })
    ).rejects.toThrow("shutdown failed");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("waiters stop waiting once the holder releases", async () => {
    const lockPath = respawnLockPath(4319, root);
    const holder = acquireRespawnLock(lockPath);
    setTimeout(() => holder?.release(), 40);
    const startedAt = Date.now();
    const outcome = await coordinateRespawn(4319, {
      respawn: async () => {
        throw new Error("waiter must not respawn");
      },
      lockPath,
      waitMs: 2_000,
      pollMs: 5,
    });
    expect(outcome).toBe("waited");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("build stamps", () => {
  it("changes when a module's contents change", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "broker-daemon.js"), "export const a = 1;\n");
    const before = computeBuildStamp(root);
    writeFileSync(join(root, "broker-daemon.js"), "export const a = 2;\n");
    expect(computeBuildStamp(root)).not.toBe(before);
  });

  it("ignores declaration files and non-module assets", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "broker-daemon.js"), "export const a = 1;\n");
    const before = computeBuildStamp(root);
    writeFileSync(join(root, "broker-daemon.d.ts"), "export declare const a: number;\n");
    writeFileSync(join(root, "notes.md"), "hello\n");
    expect(computeBuildStamp(root)).toBe(before);
  });
});
