import { defineCommand } from "@pokit/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const HOST_NAME = "com.actors.lens_host";
// Stable extension ID, derived from the pinned `key` in apps/extension/manifest.json.
const EXTENSION_ID = "mbanohpojdbbnbnmppepaihihmkoibaj";

// Chromium-family browsers each keep their own NativeMessagingHosts dir on macOS.
const BROWSER_DIRS: Record<string, string> = {
  "Google Chrome": "Google/Chrome",
  "Chrome Beta": "Google/Chrome Beta",
  "Chrome Canary": "Google/Chrome Canary",
  Chromium: "Chromium",
  Brave: "BraveSoftware/Brave-Browser",
  Edge: "Microsoft Edge",
};

export const command = defineCommand({
  label: "Install the native-messaging helper so the extension discovers hosts silently",
  run: async (r) => {
    if (process.platform !== "darwin") {
      r.reporter.warn(`This installer targets macOS; on ${process.platform} install the manifest manually.`);
    }
    const cwd = process.cwd();
    const hostPath = join(cwd, "apps/extension/native/host.mjs");
    if (!existsSync(hostPath)) {
      r.reporter.error(`Native helper not found at ${hostPath} — run this from the repo root.`);
      return;
    }
    chmodSync(hostPath, 0o755); // Chrome executes `path` directly

    const manifest = {
      name: HOST_NAME,
      description: "Lens Host native bridge — announces live lens-host ports to the extension",
      path: hostPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    };

    const support = join(homedir(), "Library", "Application Support");
    let installed = 0;
    for (const [label, rel] of Object.entries(BROWSER_DIRS)) {
      if (!existsSync(join(support, rel))) continue; // browser not installed
      const dir = join(support, rel, "NativeMessagingHosts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
      r.reporter.step(`Registered with ${label}`);
      installed++;
    }

    if (installed === 0) {
      r.reporter.warn("No supported browser found under ~/Library/Application Support.");
      return;
    }
    r.reporter.success(
      `Native helper installed for ${installed} browser(s). Reload the extension (chrome://extensions) to pick it up — ` +
        "hosts will now connect instantly and silently."
    );
  },
});
