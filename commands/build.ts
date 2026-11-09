import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build and type-check all packages",
  run: async (r) => {
    await r.exec("pnpm -r build");
    // Packages without a build (cli, mcp) are type-checked here instead.
    await r.exec("pnpm -r typecheck");
    r.reporter.success("Built packages");
  },
});
