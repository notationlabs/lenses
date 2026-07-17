import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run lens-host in the foreground (debugging; normally your agent spawns it)",
  run: async (r) => {
    r.reporter.info("MCP on stdio, extension bridge on ws://127.0.0.1:4319 — Ctrl-C to stop");
    await r.exec(`LENS_DIR="$PWD/lenses" bun packages/host/src/index.ts`);
  },
});
