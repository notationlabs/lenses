import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build all packages",
  run: async (r) => {
    await r.exec("pnpm -r build");
    r.reporter.success("Built packages");
  },
});
