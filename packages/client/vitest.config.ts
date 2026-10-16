import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Brokers spawned by tests write their log and git clones under
// LENS_CACHE_DIR; keep all of it out of the user's real cache.
export default defineConfig({
  test: {
    env: { LENS_CACHE_DIR: mkdtempSync(join(tmpdir(), "lenses-test-cache-")) },
  },
});
