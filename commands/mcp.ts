import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run lens-mcp in the foreground",
  run: async (r) => {
    r.reporter.info("MCP on stdio, extension bridge on ws://127.0.0.1:4319 — Ctrl-C to stop");
    await r.exec(`LENS_DIR="$PWD/lenses" bun packages/mcp/src/index.ts`);
  },
});
