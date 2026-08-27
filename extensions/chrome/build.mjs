import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { pageFunctionsStamp } from "@djgrant/lenses-core/page-stamp";

// The extension bundles the page functions, so it must be able to say which
// copy it bundled. Injected as a constant, it ships inside the bundle and
// therefore travels with the instance Chrome is running.
const stamp = pageFunctionsStamp();
const define = { PAGE_FUNCTIONS_STAMP: JSON.stringify(stamp) };

await mkdir("dist", { recursive: true });

// service worker: ESM module (manifest declares type: "module")
await build({
  entryPoints: ["src/sw.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/sw.js",
  target: "chrome120",
  define,
});

// The isolated-world content script remains a classic IIFE. MAIN-world
// interception is injected only for active sessions by the service worker.
await build({
  entryPoints: ["src/content.ts"],
  bundle: true,
  format: "iife",
  outfile: "dist/content.js",
  target: "chrome120",
  define,
});

await copyFile("manifest.json", "dist/manifest.json");
await copyFile("icon128.png", "dist/icon128.png");
console.log(`extension built \u2192 extensions/chrome/dist (page functions ${stamp})`);
console.log("load unpacked from there, and reload at chrome://extensions to pick this up");
