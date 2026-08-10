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

// content scripts: classic scripts, must be IIFE
for (const name of ["content", "page"]) {
  await build({
    entryPoints: [`src/${name}.ts`],
    bundle: true,
    format: "iife",
    outfile: `dist/${name}.js`,
    target: "chrome120",
    define,
  });
}

await copyFile("manifest.json", "dist/manifest.json");
await copyFile("icon128.png", "dist/icon128.png");
console.log(`extension built \u2192 extensions/chrome/dist (page functions ${stamp})`);
console.log("load unpacked from there, and reload at chrome://extensions to pick this up");
