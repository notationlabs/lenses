import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Identifies the page-functions module a running instance holds by hashing
 * the canonical TypeScript source.
 *
 * Hashing source rather than emitted JavaScript is deliberate: different
 * build tools format JavaScript differently. The public bundle ships that
 * source as a stamp asset; workspace builds read it directly from `src/`.
 */
let cached: string | undefined;

export function pageFunctionsStamp(): string {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const packaged = join(here, "page-functions.ts");
  const workspace = join(here, "../src/page-functions.ts");
  const file = existsSync(packaged) ? packaged : workspace;
  cached = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  return cached;
}
