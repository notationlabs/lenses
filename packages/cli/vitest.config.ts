import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// lens update and gen load catalogs through LensStore, which caches git
// sources under LENS_CACHE_DIR; keep it out of the user's real cache.
export default defineConfig({
  test: {
    env: { LENS_CACHE_DIR: mkdtempSync(join(tmpdir(), "lenses-test-cache-")) },
  },
});
