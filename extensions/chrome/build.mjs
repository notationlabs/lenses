import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

// service worker: ESM module (manifest declares type: "module")
await build({
  entryPoints: ["src/sw.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/sw.js",
  target: "chrome120",
});

// content scripts: classic scripts, must be IIFE
for (const name of ["content", "page"]) {
  await build({
    entryPoints: [`src/${name}.ts`],
    bundle: true,
    format: "iife",
    outfile: `dist/${name}.js`,
    target: "chrome120",
  });
}

await copyFile("manifest.json", "dist/manifest.json");
console.log("extension built → extensions/chrome/dist (load unpacked from there)");
