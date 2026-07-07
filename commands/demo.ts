import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "End-to-end smoke demo: MCP handshake → lens_call → sampling → cache (no browser needed)",
  run: async (r) => {
    r.reporter.info("Spawning lens-host and a fake extension over the WS bridge...");
    await r.exec("pnpm -r build");
    await r.exec("node scripts/smoke.mjs");
    r.reporter.success("Full pipeline verified: MCP → bridge → LLM tier via sampling → cache hit → accepts rejection");
    r.reporter.info("For the real thing: run `pok setup` to connect Chrome + your agent.");
  },
});
