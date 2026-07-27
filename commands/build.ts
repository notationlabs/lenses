import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build all packages and the Chrome extension",
  run: async (r) => {
    await r.exec("pnpm -r build");
    r.reporter.success("Built packages and extensions/chrome/dist");
    // The content script bundles the page functions, so Chrome keeps running
    // the copy it loaded until the extension is reloaded — a rebuilt dist on
    // disk reaches nobody, and the stale behaviour is indistinguishable from
    // an unshipped fix.
    r.reporter.info("Reload the extension at chrome://extensions to pick up this build");
  },
});
