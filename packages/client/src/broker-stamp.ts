import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A build stamp identifies the code a broker daemon is running. It hashes the
 * daemon's module directory rather than the package version, because the stale
 * broker we care about is the one left behind by a local rebuild or a pull —
 * neither of which moves package.json.
 */
export function computeBuildStamp(dir: string): string {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).sort()) {
    if (!isModule(name)) continue;
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest("hex").slice(0, 16);
}

function isModule(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return name.endsWith(".js") || name.endsWith(".ts");
}

let cached: string | undefined;

/**
 * The stamp of the module directory this file was loaded from — `dist/` for a
 * built client, `src/` under bun. Memoised on purpose: a running daemon must
 * keep reporting the code it started with, not the code now on disk.
 */
export function brokerBuildStamp(): string {
  cached ??= computeBuildStamp(dirname(fileURLToPath(import.meta.url)));
  return cached;
}
