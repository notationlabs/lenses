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
 * extensions — so a launch must always name a profile. Playwright Extension
 * must be installed in that profile for the preferred transport.
 *
 * Override with `LENS_BROWSER_PROFILE`, CLI `--profile`, or
 * `browser.profile` in this file. The Playwright token is
 * `PLAYWRIGHT_MCP_EXTENSION_TOKEN`, `--playwright-extension-token`, or
 * `browser.playwrightExtensionToken`.
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

function browserSettings(): Record<string, unknown> {
  const browser = readUserConfig().browser;
  return typeof browser === "object" && browser !== null && !Array.isArray(browser)
    ? (browser as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function browserProfile(): string {
  return (
    nonEmpty(process.env.LENS_BROWSER_PROFILE) ??
    nonEmpty(browserSettings().profile) ??
    "Default"
  );
}

/** Token from Playwright Extension's status page; skips repeated connect approval. */
export function playwrightExtensionToken(): string | undefined {
  return (
    nonEmpty(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) ??
    nonEmpty(browserSettings().playwrightExtensionToken)
  );
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
