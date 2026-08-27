import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserProfile, playwrightExtensionToken } from "../src/user-config.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousProfile = process.env.LENS_BROWSER_PROFILE;
const previousToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;

afterEach(() => {
  restore(previousConfigHome, "XDG_CONFIG_HOME");
  restore(previousProfile, "LENS_BROWSER_PROFILE");
  restore(previousToken, "PLAYWRIGHT_MCP_EXTENSION_TOKEN");
});

function restore(value: string | undefined, name: string): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeConfig(browser: Record<string, unknown>): void {
  const root = join(tmpdir(), `lenses-config-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "lenses"), { recursive: true });
  writeFileSync(join(root, "lenses", "config.json"), JSON.stringify({ browser }));
  process.env.XDG_CONFIG_HOME = root;
}

describe("browser user config", () => {
  it("reads profile and token from config when env is unset", () => {
    delete process.env.LENS_BROWSER_PROFILE;
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    writeConfig({ profile: "Profile 4", playwrightExtensionToken: "secret-token" });
    expect(browserProfile()).toBe("Profile 4");
    expect(playwrightExtensionToken()).toBe("secret-token");
  });

  it("lets env override config", () => {
    writeConfig({ profile: "Profile 4", playwrightExtensionToken: "from-file" });
    process.env.LENS_BROWSER_PROFILE = "Default";
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = "from-env";
    expect(browserProfile()).toBe("Default");
    expect(playwrightExtensionToken()).toBe("from-env");
  });
});
