/**
 * User-level configuration, read from ~/.config/lenses/config.json. There is
 * deliberately no project-level file: the broker is one shared daemon serving
 * every project, so it can only honour settings that are global to the user.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function configPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "lenses",
    "config.json"
  );
}

/**
 * The Chrome profile directory to launch, e.g. "Default" or "Profile 2".
 * Chrome started without one shows the profile picker, which loads no
 * extensions — so a launch must always name a profile. If the configured
 * profile does not hold the lens extension, that is a setup issue for the
 * user to fix, not something to detect around.
 */
export function browserProfile(): string {
  try {
    const config = JSON.parse(readFileSync(configPath(), "utf8")) as {
      browser?: { profile?: unknown };
    };
    const profile = config.browser?.profile;
    if (typeof profile === "string" && profile.length > 0) return profile;
  } catch {
    // A missing or unreadable config just means the default profile.
  }
  return "Default";
}
