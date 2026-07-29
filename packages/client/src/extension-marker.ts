/**
 * Records that a Chrome extension has completed a handshake on this machine.
 * The broker cannot ask Chrome whether the extension is installed, so a fresh
 * broker uses this marker to decide whether waiting for it is worthwhile
 * before falling back to CDP and its Allow dialog.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MARKER_PATH = join(homedir(), ".cache", "lenses", "extension-seen.json");
/** Long enough to survive holidays; a removed extension costs one grace period. */
const MARKER_TTL_MS = 90 * 24 * 60 * 60_000;

export function markExtensionSeen(version: string, ua?: string): void {
  try {
    mkdirSync(dirname(MARKER_PATH), { recursive: true });
    writeFileSync(
      MARKER_PATH,
      JSON.stringify({ version, ua, seenAt: Date.now() })
    );
  } catch {
    // The marker is an optimisation; failing to write it only costs a fallback.
  }
}

export function extensionSeenRecently(now = Date.now()): boolean {
  try {
    const marker = JSON.parse(readFileSync(MARKER_PATH, "utf8")) as {
      seenAt?: unknown;
    };
    return (
      typeof marker.seenAt === "number" && now - marker.seenAt < MARKER_TTL_MS
    );
  } catch {
    return false;
  }
}
