import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Identifies the page-functions module a running instance holds.
 *
 * The content script bundles these functions at build time, so Chrome keeps
 * extracting with the copy it loaded until the extension is reloaded — and from
 * outside, a stale extension is indistinguishable from a fix that was never
 * shipped. Both sides compute this over the same module file: the extension
 * build bakes the result into its bundle, so the stamp travels with the running
 * instance, and the broker computes it live from its own copy.
 *
 * Comparing the artefacts on disk instead would not work. When this last bit,
 * both `packages/lens/dist/page-functions.js` and `extensions/chrome/dist/content.js`
 * were current and only Chrome's in-memory copy was stale, so any build-side or
 * mtime check would have reported a confident all-clear. The manifest version
 * cannot serve either, since a local rebuild never moves it.
 *
 * Hashing the module file rather than `Function.prototype.toString` is
 * deliberate: esbuild reformats what it bundles, so the two sides would never
 * agree on the text of the function itself.
 */
let cached: string | undefined;

export function pageFunctionsStamp(): string {
  if (cached) return cached;
  // dist/ for a built package, src/ under bun.
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "page-functions.js");
  const file = existsSync(built) ? built : join(here, "page-functions.ts");
  cached = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
  return cached;
}
