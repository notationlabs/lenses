/**
 * User-level configuration, read from ~/.config/lenses/config.json. There is
 * deliberately no project-level file: the broker is one shared daemon serving
 * every project, so it can only honour settings that are global to the user.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LensParameterValue = string | number | boolean;
export type LensParameterDefaults = Record<string, Record<string, LensParameterValue>>;

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
function readUserConfig(): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    // Missing, unreadable, and malformed config all mean default settings.
    return {};
  }
}

export function browserProfile(): string {
  const browser = readUserConfig().browser;
  const profile =
    typeof browser === "object" && browser !== null && !Array.isArray(browser)
      ? (browser as Record<string, unknown>).profile
      : undefined;
  return typeof profile === "string" && profile.length > 0 ? profile : "Default";
}

/**
 * Per-lens call parameter defaults from the user config. Keys are canonical
 * lens-name globs, for example `@djgrant/freeagent/*`. Invalid entries are
 * ignored and normal parameter validation still checks every applied value.
 */
export function userParameterDefaults(): LensParameterDefaults {
  const configured = readUserConfig().params;
  if (typeof configured !== "object" || configured === null || Array.isArray(configured)) return {};

  const defaults: LensParameterDefaults = {};
  for (const [pattern, candidate] of Object.entries(configured)) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const values: Record<string, LensParameterValue> = {};
    for (const [name, value] of Object.entries(candidate)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        values[name] = value;
      }
    }
    defaults[pattern] = values;
  }
  return defaults;
}
