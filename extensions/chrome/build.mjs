import { build } from "esbuild";
import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { pageFunctionsStamp } from "@djgrant/lenses-core/page-stamp";
import { readAndValidateMetadata } from "./scripts/validate-metadata.mjs";

const { packageJson, manifest, extensionId } = await readAndValidateMetadata();

// The extension bundles the page functions, so it must be able to say which
// copy it bundled. Injected as a constant, it ships inside the bundle and
// therefore travels with the instance Chrome is running.
const stamp = pageFunctionsStamp();
const define = { PAGE_FUNCTIONS_STAMP: JSON.stringify(stamp) };

// Never let files left by an older build leak into an unpacked extension or ZIP.
await rm("dist", { recursive: true, force: true });
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

// package.json is the release version source; validation above ensures the
// checked-in loadable manifest was updated in the same change.
await writeFile(
  "dist/manifest.json",
  `${JSON.stringify({ ...manifest, version: packageJson.version }, null, 2)}\n`
);
await cp("icons", "dist/icons", { recursive: true });
for (const file of [
  "action.html",
  "action.css",
  "action.js",
  "privacy.html",
  "privacy.css",
]) {
  await copyFile(file, `dist/${file}`);
}

console.log(`extension built → extensions/chrome/dist (v${packageJson.version}, ${extensionId})`);
console.log(`page functions ${stamp}`);
console.log("load unpacked from there, and reload at chrome://extensions to pick this up");
