import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const dist = join(packageRoot, "dist");

test("the public root exposes the client", async () => {
  const lenses = await import("@djgrant/lenses");
  assert.equal(typeof lenses.createLensClient, "function");
  const client = lenses.createLensClient({ catalog: [] });
  assert.deepEqual(await client.list(), []);
  await client.close();
});

test("public subpaths expose core and MCP APIs", async () => {
  const core = await import("@djgrant/lenses/core");
  const mcp = await import("@djgrant/lenses/mcp");
  const { pageFunctionsStamp } = await import("@djgrant/lenses/page-stamp");
  assert.equal(typeof core.evaluate, "function");
  assert.equal(typeof mcp.createLensMcpServer, "function");
  assert.match(pageFunctionsStamp(), /^[0-9a-f]{16}$/);
});

test("bundled output has no private workspace imports", async () => {
  for (const path of await files(dist)) {
    if (extname(path) !== ".js" && !path.endsWith(".d.ts")) continue;
    const contents = await readFile(path, "utf8");
    assert.doesNotMatch(contents, /@djgrant\/lenses-(?:core|client|cli|mcp)(?:["/])/);
  }
});

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
