import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Get the real thing running: Chrome extension + MCP registration",
  run: async (r) => {
    r.reporter.info("Two manual steps connect a real agent to your real browser:");
    r.reporter.step("1. Load the extension: chrome://extensions → Developer mode → Load unpacked → apps/extension/dist");
    r.reporter.step('2. Register the MCP server:  pok setup mcp');
    r.reporter.info("Then in a fresh Claude Code session ask: \"what's on the front page of hacker news? use lens_call\"");
    r.reporter.info("Diagnostics: the bridge_status tool reports whether the extension is connected (ws://127.0.0.1:4319).");
  },
});
