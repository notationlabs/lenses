import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_LOCK_MS = 60_000;

export interface RespawnLock {
  release(): void;
}

export function respawnLockPath(port: number, root = tmpdir()): string {
  return join(root, `lens-broker-respawn-${port}.lock`);
}

/**
 * mkdir is atomic on every platform we run on, so it doubles as a cross-process
 * mutex: whichever client creates the directory owns the respawn, the rest wait.
 */
export function acquireRespawnLock(path: string): RespawnLock | null {
  try {
    mkdirSync(path);
  } catch {
    if (!clearStaleLock(path)) return null;
    try {
      mkdirSync(path);
    } catch {
      return null;
    }
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // A lock we cannot remove ages out via clearStaleLock.
      }
    },
  };
}

function clearStaleLock(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs < STALE_LOCK_MS) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface CoordinateRespawnOptions {
  respawn: () => Promise<void>;
  lockPath?: string;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Exactly one concurrent caller runs `respawn`; the others wait for it to finish
 * and report "waited" so they can simply reconnect.
 */
export async function coordinateRespawn(
  port: number,
  options: CoordinateRespawnOptions
): Promise<"respawned" | "waited"> {
  const path = options.lockPath ?? respawnLockPath(port);
  const lock = acquireRespawnLock(path);
  if (!lock) {
    await waitForLock(path, options.waitMs ?? 10_000, options.pollMs ?? 25);
    return "waited";
  }
  try {
    await options.respawn();
  } finally {
    lock.release();
  }
  return "respawned";
}

async function waitForLock(path: string, waitMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      statSync(path);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
