import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tabs a retiring broker leaves for the broker that replaces it. The
 * Playwright Extension ungroups a client's tabs when its connection closes,
 * and attaching a tab puts it back in the new client's group without
 * reloading it, so a signed-in tab survives a broker restart. A Chrome tab id
 * lasts until Chrome quits; the target id confirms it is still the same tab.
 */
export interface HandedOverTab {
  tabId: number;
  targetId: string;
  url: string;
}

interface Handover {
  profile: string;
  savedAt: number;
  tabs: HandedOverTab[];
}

/** Long enough for a client to respawn the broker and make its call. */
export const HANDOVER_TTL_MS = 2 * 60_000;

export function handoverPath(): string {
  return join(
    process.env.LENS_CACHE_DIR ?? join(homedir(), ".cache", "lenses"),
    "tab-handover.json"
  );
}

export function saveHandover(
  profile: string,
  tabs: HandedOverTab[],
  path = handoverPath(),
  now = Date.now()
): void {
  if (tabs.length === 0) return;
  const handover: Handover = { profile, savedAt: now, tabs };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(handover), { mode: 0o600 });
  } catch {
    // Without a handover the next broker opens its own tabs.
  }
}

/** The tabs left for this profile, at most once and only while fresh. */
export function takeHandover(
  profile: string,
  path = handoverPath(),
  now = Date.now()
): HandedOverTab[] {
  let handover: Partial<Handover>;
  try {
    handover = JSON.parse(readFileSync(path, "utf8")) as Partial<Handover>;
  } catch {
    return [];
  }
  rmSync(path, { force: true });
  if (handover.profile !== profile) return [];
  if (typeof handover.savedAt !== "number" || now - handover.savedAt > HANDOVER_TTL_MS) return [];
  return (handover.tabs ?? []).filter(
    (tab) =>
      Number.isSafeInteger(tab?.tabId) &&
      typeof tab.targetId === "string" &&
      typeof tab.url === "string"
  );
}
