import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const here = import.meta.dirname;
const internalPackages = /^@djgrant\/lenses-(?:core|client)(?:\/|$)/;

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "../core/src/index.ts",
    graphql: "../core/src/graphql.ts",
    "page-stamp": "../core/src/page-stamp.ts",
    mcp: "../mcp/src/server.ts",
    cli: "../cli/src/index.ts",
    "mcp-cli": "../mcp/src/index.ts",
    "broker-daemon": "../client/src/broker-daemon.ts",
  },
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: [internalPackages],
  esbuildOptions(options) {
    options.alias = {
      "@djgrant/lenses-core/graphql": resolve(here, "../core/src/graphql.ts"),
      "@djgrant/lenses-core/page-stamp": resolve(here, "../core/src/page-stamp.ts"),
      "@djgrant/lenses-core": resolve(here, "../core/src/index.ts"),
      "@djgrant/lenses-client": resolve(here, "../client/src/index.ts"),
    };
  },
  async onSuccess() {
    await Promise.all([
      cp(resolve(here, "../../README.md"), resolve(here, "README.md")),
      cp(resolve(here, "../../skill/SKILL.md"), resolve(here, "SKILL.md")),
      cp(resolve(here, "../core/src/page-functions.ts"), resolve(here, "dist/page-functions.ts")),
    ]);
  },
});
