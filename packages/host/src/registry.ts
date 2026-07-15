import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

/**
 * Announce this lens-host to the browser extension by writing a per-port file
 * into ~/.actors/hosts. The native-messaging helper watches that directory and
 * pushes the live-port list to the extension, so the extension only ever dials
 * ports that actually have a host — no speculative probing, no console noise.
 */
const DIR = join(homedir(), ".actors", "hosts");

export function registerHost(port: number): void {
  const file = join(DIR, `${port}.json`);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }));

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort; the helper drops entries whose pid is gone anyway
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}
