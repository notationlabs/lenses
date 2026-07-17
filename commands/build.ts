import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build the Chrome extension (the only artifact that needs building)",
  run: async (r) => {
    await r.exec("pnpm --filter @djgrant/lens-extension-chrome build");
    r.reporter.success("Built extensions/chrome → extensions/chrome/dist");
  },
});
