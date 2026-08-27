import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

export function chromeExecutablePath(): string | undefined {
  switch (process.platform) {
    case "darwin": {
      const path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      return existsSync(path) ? path : undefined;
    }
    case "win32": {
      const path = join(
        process.env.PROGRAMFILES ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe"
      );
      return existsSync(path) ? path : undefined;
    }
    default: {
      for (const path of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
        if (existsSync(path)) return path;
      }
      return undefined;
    }
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
