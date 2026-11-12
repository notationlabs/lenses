import { homedir } from "node:os";
import { join } from "node:path";

/** Where the broker log, tab handover, and git catalog clones live. */
export function cacheDir(): string {
  return process.env.LENS_CACHE_DIR ?? join(homedir(), ".cache", "lenses");
}
