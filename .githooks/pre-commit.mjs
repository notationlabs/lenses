#!/usr/bin/env node
/**
 * A commit that changes the extension's code must move its version: the broker
 * gates capabilities (http-fetch and the like) on the version the extension
 * reports in its hello, so shipping changed behaviour under an old number
 * makes that gate lie. Doc-only changes are exempt.
 */
import { execFileSync } from "node:child_process";

const EXTENSION_DIR = "extensions/chrome/";
const MANIFEST = "extensions/chrome/manifest.json";
const PACKAGE = "extensions/chrome/package.json";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function versionAt(ref, path) {
  try {
    return JSON.parse(git("show", `${ref}:${path}`)).version;
  } catch {
    return undefined; // file absent at that ref
  }
}

const staged = git("diff", "--cached", "--name-only").trim().split("\n").filter(Boolean);
const extensionChanges = staged.filter(
  (file) => file.startsWith(EXTENSION_DIR) && !file.endsWith(".md")
);
if (extensionChanges.length === 0) process.exit(0);

const stagedManifest = versionAt("", MANIFEST);
const stagedPackage = versionAt("", PACKAGE);
const headManifest = versionAt("HEAD", MANIFEST);

const problems = [];
if (stagedManifest !== undefined && stagedManifest === headManifest) {
  problems.push(
    `this commit changes the extension but ${MANIFEST} still declares ${headManifest}; bump the version`
  );
}
if (stagedManifest !== stagedPackage) {
  problems.push(
    `${MANIFEST} declares ${stagedManifest} but ${PACKAGE} declares ${stagedPackage}; keep them equal`
  );
}
if (problems.length === 0) process.exit(0);

console.error("pre-commit: extension version check failed");
for (const problem of problems) console.error(`  - ${problem}`);
console.error(`  changed: ${extensionChanges.join(", ")}`);
process.exit(1);
