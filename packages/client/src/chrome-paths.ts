import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT_EXTENSION_ID } from "./playwright-relay/protocol.js";

export function defaultChromeUserDataDir(): string {
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
      return join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "google-chrome"
      );
  }
}

/**
 * Whether the Playwright Extension is unpacked or Web-Store-installed in this
 * Chrome profile. Group membership is an automation boundary, not a proof of
 * cookies: the profile still holds the user's normal storage.
 */
export async function playwrightExtensionInstalled(
  userDataDir = defaultChromeUserDataDir(),
  profile = "Default"
): Promise<boolean> {
  const profileDir = join(userDataDir, profile);
  if (existsSync(join(profileDir, "Extensions", PLAYWRIGHT_EXTENSION_ID))) return true;
  for (const fileName of ["Preferences", "Secure Preferences"]) {
    if (await hasExtensionSettingsRecord(join(profileDir, fileName))) return true;
  }
  return false;
}

/**
 * Best-effort version from the configured profile's on-disk manifest. Chrome
 * can choose another installed revision at runtime, so callers must label this
 * as an installed version rather than the version of the connected extension.
 */
export async function playwrightExtensionInstalledVersion(
  userDataDir = defaultChromeUserDataDir(),
  profile = "Default"
): Promise<string | undefined> {
  const extensionDir = join(
    userDataDir,
    profile,
    "Extensions",
    PLAYWRIGHT_EXTENSION_ID
  );
  try {
    const versions = await readdir(extensionDir);
    for (const directory of versions.sort(compareVersions).reverse()) {
      try {
        const manifest = JSON.parse(
          await readFile(join(extensionDir, directory, "manifest.json"), "utf8")
        ) as { version?: unknown };
        if (typeof manifest.version === "string" && manifest.version) {
          return manifest.version;
        }
      } catch {
        // A partial update or unpacked layout may not contain this manifest.
      }
    }
  } catch {
    // The extension may only have a Preferences record, or the profile moved.
  }
  return undefined;
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

async function hasExtensionSettingsRecord(prefsPath: string): Promise<boolean> {
  try {
    const prefs = JSON.parse(await readFile(prefsPath, "utf8")) as {
      extensions?: { settings?: Record<string, unknown> };
    };
    const record = prefs.extensions?.settings?.[PLAYWRIGHT_EXTENSION_ID];
    return !!record && typeof record === "object" && Object.keys(record).length > 0;
  } catch {
    return false;
  }
}
