import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build the extension and open chrome://extensions to load it",
  run: async (r) => {
    await r.exec("pnpm -r build");
    r.reporter.info("Chrome can't open chrome:// URLs from the CLI — opening Chrome; then:");
    r.reporter.step("chrome://extensions → Developer mode → Load unpacked → apps/extension/dist");
    r.reporter.step("Reload any tabs that were already open (content scripts inject on load).");
    await r.exec('open -a "Google Chrome"');
  },
});
