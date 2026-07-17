import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build all packages and the Chrome extension",
  run: async (r) => {
    await r.exec("pnpm -r build");
    r.reporter.success("Built packages and extensions/chrome/dist");
  },
});
