import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A build stamp identifies the code a broker daemon is running. It hashes the
 * daemon's module directories rather than the package version, because the
 * stale broker we care about is the one left behind by a local rebuild or a
 * pull — neither of which moves package.json. Directories are walked
 * recursively (the relay lives in a subdirectory), and every directory given
 * contributes: the daemon runs core's engine as much as its own code.
 */
export function computeBuildStamp(...dirs: string[]): string {
  const hash = createHash("sha256");
  for (const dir of dirs) {
    hash.update(`${dir}\0`);
    hashDirectory(hash, dir, "");
  }
  return hash.digest("hex").slice(0, 16);
}

function hashDirectory(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") hashDirectory(hash, root, path);
      continue;
    }
    if (!isModule(entry.name)) continue;
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
  }
}

function isModule(name: string): boolean {
  if (name.endsWith(".d.ts")) return false;
  return name.endsWith(".js") || name.endsWith(".ts");
}

/**
 * The directory holding the core engine this process loads. Workspace only:
 * the published bundle inlines core beside this file, and its build defines
 * LENSES_BUNDLED so this lookup is dropped from the output.
 */
function coreModuleDir(): string | undefined {
  if (process.env.LENSES_BUNDLED === "1") return undefined;
  try {
    return dirname(fileURLToPath(import.meta.resolve("@djgrant/lenses-core")));
  } catch {
    return undefined;
  }
}

let cached: string | undefined;

/**
 * The stamp of the module directories this file and core were loaded from —
 * `dist/` when built, `src/` under bun. Memoised on purpose: a running daemon
 * must keep reporting the code it started with, not the code now on disk.
 */
export function brokerBuildStamp(): string {
  if (cached === undefined) {
    const core = coreModuleDir();
    cached = computeBuildStamp(
      dirname(fileURLToPath(import.meta.url)),
      ...(core ? [core] : [])
    );
  }
  return cached;
}
