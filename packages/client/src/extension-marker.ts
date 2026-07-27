/**
 * Records that a Chrome extension has completed a handshake on this machine.
 * The broker cannot ask Chrome whether the extension is installed, so a fresh
 * broker uses this marker to decide whether waiting for it is worthwhile
 * before falling back to CDP and its Allow dialog.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Fixed by the "key" in extensions/chrome/manifest.json, so it never varies. */
const EXTENSION_ID = "mbanohpojdbbnbnmppepaihihmkoibaj";

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

/**
 * Whether Chrome has the lens extension installed and enabled, read from the
 * profile preferences. This is the bootstrap signal: on a first run no marker
 * exists yet, and without it the broker would exit before a sleeping service
 * worker ever gets the chance to hand-shake and create one.
 */
export function extensionInstalled(userDataDir = chromeUserDataDir()): boolean {
  return extensionProfile(userDataDir) !== undefined;
}

/**
 * The profile directory holding the extension, e.g. "Default". Chrome opens the
 * profile picker when started without one, and the picker loads no extensions —
 * so a launch that means to reach the extension must name this profile.
 */
export function extensionProfile(
  userDataDir = chromeUserDataDir()
): string | undefined {
  try {
    for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const prefs = join(userDataDir, entry.name, "Secure Preferences");
      if (!existsSync(prefs)) continue;
      const settings = JSON.parse(readFileSync(prefs, "utf8"))?.extensions
        ?.settings?.[EXTENSION_ID];
      if (!settings || settings.disable_reasons) continue;
      // An unpacked extension whose directory is gone is loaded no longer.
      if (typeof settings.path === "string" && !existsSync(settings.path)) continue;
      return entry.name;
    }
  } catch {
    // An unreadable profile just means falling back to the handshake marker.
  }
  return undefined;
}

function chromeUserDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data"
      );
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "google-chrome");
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
