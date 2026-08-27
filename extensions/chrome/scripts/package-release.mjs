import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { readAndValidateMetadata } from "./validate-metadata.mjs";

const root = process.cwd();
const dist = resolve(root, "dist");
const { packageJson, manifest } = await readAndValidateMetadata(root);
const contentScripts = manifest.content_scripts.flatMap((script) => script.js ?? []);
const expected = new Set([
  "action.css", "action.html", "action.js", ...contentScripts,
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png",
  "manifest.json", "privacy.css", "privacy.html", "sw.js",
]);
const paths = (await walk(dist)).sort();
const names = paths.map((path) => relative(dist, path).replaceAll("\\", "/"));
const unexpected = names.filter((name) => !expected.has(name));
const missing = [...expected].filter((name) => !names.includes(name));
if (unexpected.length || missing.length) {
  throw new Error(`invalid dist contents; unexpected=[${unexpected}], missing=[${missing}]`);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
const entries = await Promise.all(paths.map(async (path, index) => ({
  name: names[index],
  data: await readFile(path),
})));
const zip = createZip(entries);
const outputDir = resolve(root, "../../artifacts");
const output = resolve(outputDir, `lenses-chrome-${packageJson.version}.zip`);
await mkdir(outputDir, { recursive: true });
await writeFile(output, zip);

// Parse the archive we just wrote rather than trusting only the input list.
const archived = listZipEntries(zip);
if (archived.join("\n") !== names.join("\n")) {
  throw new Error("ZIP validation failed: central-directory contents differ from dist");
}
const sha256 = createHash("sha256").update(zip).digest("hex");
console.log(`${relative(root, output)} ${zip.length} bytes sha256:${sha256}`);

async function walk(directory) {
  const output = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".") || item.isSymbolicLink()) {
      throw new Error(`release input contains forbidden entry: ${item.name}`);
    }
    const path = resolve(directory, item.name);
    if (item.isDirectory()) output.push(...await walk(path));
    else if (item.isFile()) output.push(path);
    else throw new Error(`release input is not a regular file: ${path}`);
  }
  return output;
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // stored, deterministic
    local.writeUInt16LE(0, 10); // 1980-01-01 00:00:00
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function listZipEntries(zip) {
  const endOffset = zip.length - 22;
  if (zip.readUInt32LE(endOffset) !== 0x06054b50) throw new Error("ZIP has no EOCD");
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad ZIP central directory");
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
