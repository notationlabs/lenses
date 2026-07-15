import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Get the real thing running: Chrome extension + MCP registration",
  run: async (r) => {
    r.reporter.info("Three steps connect a real agent to your real browser:");
    r.reporter.step("1. Load the extension: chrome://extensions → Developer mode → Load unpacked → apps/extension/dist");
    r.reporter.step('2. Register the MCP server:  pok setup mcp');
    r.reporter.step('3. Install the native helper: pok setup native  (silent, instant host discovery)');
    r.reporter.info("Then in a fresh Claude Code session ask: \"what's on the front page of hacker news? use lens_call\"");
    r.reporter.info("Diagnostics: the bridge_status tool reports whether the extension is connected (ws://127.0.0.1:4319).");
    r.reporter.info("Step 3 is optional: without it the extension still discovers hosts on page loads, just less instantly.");
  },
});
