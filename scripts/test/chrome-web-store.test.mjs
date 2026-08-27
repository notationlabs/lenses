import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDeterministicZip, validateRelease, waitForUpload } from "../chrome-web-store.mjs";

test("release tag, package, and manifest versions must agree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cws-version-"));
  const manifestPath = path.join(root, "manifest.json");
  const packagePath = path.join(root, "package.json");
  await writeFile(manifestPath, JSON.stringify({ version: "1.2.3" }));
  await writeFile(packagePath, JSON.stringify({ version: "1.2.3" }));

  assert.deepEqual(
    await validateRelease({ tag: "refs/tags/chrome-v1.2.3", manifestPath, packagePath, checkGit: false }),
    { tag: "chrome-v1.2.3", version: "1.2.3" },
  );
  await assert.rejects(
    validateRelease({ tag: "chrome-v1.2.4", manifestPath, packagePath, checkGit: false }),
    /does not match manifest version/,
  );
});

test("ZIP output is byte-for-byte reproducible and rooted at manifest.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cws-zip-"));
  const source = path.join(root, "dist");
  await mkdir(path.join(source, "icons"), { recursive: true });
  await writeFile(path.join(source, "manifest.json"), '{"version":"1.0.0"}\n');
  await writeFile(path.join(source, "worker.js"), "console.log('hello');\n");
  await writeFile(path.join(source, "icons", "icon.png"), Buffer.from([0, 1, 2, 3]));

  const first = path.join(root, "first.zip");
  const second = path.join(root, "second.zip");
  const a = await createDeterministicZip(source, first);
  await utimes(path.join(source, "worker.js"), new Date(2_000_000_000_000), new Date(2_000_000_000_000));
  const b = await createDeterministicZip(source, second);

  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(a.files, ["icons/icon.png", "manifest.json", "worker.js"]);
  execFileSync("unzip", ["-t", first], { stdio: "ignore" });
  const names = execFileSync("unzip", ["-Z1", first], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(names, a.files);
});

test("in-progress uploads are polled until success", async () => {
  const responses = [
    { lastAsyncUploadState: "IN_PROGRESS" },
    { lastAsyncUploadState: "SUCCEEDED" },
  ];
  const fetchImpl = async () => new Response(JSON.stringify(responses.shift()), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.equal(
    await waitForUpload({ fetchImpl, statusUrl: "https://example.test/status", token: "test", initialState: "IN_PROGRESS", pollMs: 0 }),
    "SUCCEEDED",
  );
});

test("failed uploads stop publishing", async () => {
  await assert.rejects(
    waitForUpload({ statusUrl: "unused", token: "test", initialState: "FAILED", pollMs: 0 }),
    /ended in state FAILED/,
  );
});
