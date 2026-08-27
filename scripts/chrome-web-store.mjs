#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const API_ROOT = "https://chromewebstore.googleapis.com";
const STORE_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const DOS_DATE = 0x21; // 1980-01-01
const UTF8_FLAG = 0x800;

function assertChromeVersion(version, label) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(version)) {
    throw new Error(`${label} must be one to four dot-separated integers (received ${JSON.stringify(version)})`);
  }
  if (version.split(".").some((part) => Number(part) > 65535)) {
    throw new Error(`${label} components must not exceed 65535 (received ${version})`);
  }
}

export async function validateRelease({
  tag,
  manifestPath = "extensions/chrome/manifest.json",
  packagePath = "extensions/chrome/package.json",
  checkGit = true,
} = {}) {
  const shortTag = tag?.replace(/^refs\/tags\//, "");
  const match = /^chrome-v(.+)$/.exec(shortTag ?? "");
  if (!match) throw new Error(`release tag must have the form chrome-v<version> (received ${JSON.stringify(tag)})`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const version = match[1];
  assertChromeVersion(version, "tag version");
  assertChromeVersion(manifest.version, "manifest version");

  if (manifest.version !== version) {
    throw new Error(`tag ${shortTag} does not match manifest version ${manifest.version}`);
  }
  if (packageJson.version !== version) {
    throw new Error(`extension package version ${packageJson.version} does not match manifest version ${version}`);
  }

  if (checkGit) {
    const tagged = execFileSync("git", ["rev-list", "-n", "1", `refs/tags/${shortTag}`], { encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!tagged || tagged !== head) throw new Error(`tag ${shortTag} does not point at checked-out commit ${head}`);
  }

  return { tag: shortTag, version };
}

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    else throw new Error(`refusing to package non-regular file: ${child}`);
  }
  return files;
}

export async function createDeterministicZip(sourceDirectory, outputFile, { expectedVersion } = {}) {
  const rootStat = await lstat(sourceDirectory);
  if (!rootStat.isDirectory()) throw new Error(`${sourceDirectory} is not a directory`);
  const files = await listFiles(sourceDirectory);
  if (!files.includes("manifest.json")) throw new Error(`${sourceDirectory} does not contain manifest.json`);
  if (expectedVersion) {
    const builtManifest = JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"));
    if (builtManifest.version !== expectedVersion) {
      throw new Error(`built manifest version ${builtManifest.version} does not match release version ${expectedVersion}`);
    }
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const name of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = await readFile(path.join(sourceDirectory, ...name.split("/")));
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await mkdir(path.dirname(outputFile), { recursive: true });
  const archive = Buffer.concat([...localParts, ...centralParts, end]);
  await writeFile(outputFile, archive);
  return { files, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
}

function normalizeUploadState(state) {
  return state?.replace(/^UPLOAD_/, "");
}

async function responseError(response) {
  const text = await response.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = JSON.stringify(parsed.error ?? parsed);
  } catch {}
  const error = new Error(`Chrome Web Store API ${response.status} ${response.statusText}: ${detail.slice(0, 2000)}`);
  error.status = response.status;
  return error;
}

async function apiJson(fetchImpl, url, { token, method = "GET", body, contentType } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  });
  if (!response.ok) throw await responseError(response);
  return response.status === 204 ? {} : response.json();
}

export async function waitForUpload({ fetchImpl = fetch, statusUrl, token, initialState, timeoutMs = 600_000, pollMs = 5_000 }) {
  let state = normalizeUploadState(initialState);
  const deadline = Date.now() + timeoutMs;
  while (state === "IN_PROGRESS") {
    if (Date.now() >= deadline) throw new Error(`upload did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try {
      const status = await apiJson(fetchImpl, statusUrl, { token });
      state = normalizeUploadState(status.lastAsyncUploadState);
      if (!state) throw new Error("fetchStatus did not return lastAsyncUploadState for an in-progress upload");
    } catch (error) {
      if (!(error instanceof TypeError) && error.status !== 429 && !(error.status >= 500)) throw error;
      console.warn(`transient fetchStatus failure; retrying: ${error.message}`);
    }
  }
  if (state !== "SUCCEEDED") throw new Error(`Chrome Web Store upload ended in state ${state ?? "UNKNOWN"}`);
  return state;
}

export async function uploadAndPublish({
  zipFile,
  version,
  publisherId,
  itemId,
  token,
  fetchImpl = fetch,
  timeoutMs,
  pollMs,
}) {
  for (const [name, value] of Object.entries({ publisherId, itemId, token, zipFile, version })) {
    if (!value) throw new Error(`${name} is required`);
  }
  assertChromeVersion(version, "release version");
  const resource = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const uploadUrl = `${API_ROOT}/upload/v2/${resource}:upload`;
  const statusUrl = `${API_ROOT}/v2/${resource}:fetchStatus`;
  const publishUrl = `${API_ROOT}/v2/${resource}:publish`;

  const upload = await apiJson(fetchImpl, uploadUrl, {
    token,
    method: "POST",
    contentType: "application/zip",
    body: await readFile(zipFile),
  });
  console.log(`upload accepted (state: ${upload.uploadState ?? "UNKNOWN"})`);
  await waitForUpload({ fetchImpl, statusUrl, token, initialState: upload.uploadState, timeoutMs, pollMs });
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`store reported uploaded version ${upload.crxVersion}, expected ${version}`);
  }

  const publish = await apiJson(fetchImpl, publishUrl, {
    token,
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false, blockOnWarnings: true }),
  });
  if (!new Set(["PENDING_REVIEW", "PUBLISHED"]).has(publish.state)) {
    throw new Error(`unexpected publish state ${publish.state ?? "UNKNOWN"}`);
  }
  console.log(`submitted ${itemId} version ${version} (state: ${publish.state})`);
  return { upload, publish };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") {
    const result = await validateRelease({ tag: option("tag") });
    console.log(`validated ${result.tag} at version ${result.version}`);
  } else if (command === "package") {
    const output = option("output");
    if (!output) throw new Error("--output is required");
    const result = await createDeterministicZip(option("source") ?? "extensions/chrome/dist", output, {
      expectedVersion: option("version"),
    });
    console.log(`created ${output} (${result.files.length} files, sha256 ${result.sha256})`);
  } else if (command === "publish") {
    await uploadAndPublish({
      zipFile: option("zip"),
      version: option("version"),
      publisherId: process.env.CWS_PUBLISHER_ID,
      itemId: process.env.CWS_EXTENSION_ID,
      token: process.env.CWS_ACCESS_TOKEN,
      timeoutMs: Number(process.env.CWS_UPLOAD_TIMEOUT_MS || 600_000),
      pollMs: Number(process.env.CWS_UPLOAD_POLL_MS || 5_000),
    });
  } else {
    throw new Error(`usage: ${path.basename(process.argv[1])} <validate|package|publish> [options]\nOAuth scope: ${STORE_SCOPE}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
