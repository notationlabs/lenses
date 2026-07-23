import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Agent skill for the lens CLI, printed by `lens skill` in SKILL.md format.
 * The canonical source is `skill/SKILL.md` at the repo root (kept there so it is
 * discoverable on GitHub). `build` copies it to this package's root so the
 * published tarball is self-contained; the repo-root path is the fallback for
 * running from source (bun) before a build has run. Both `src/` and `dist/` sit
 * one level under the package, so the packaged copy resolves the same from each.
 */
function loadSkill(): string {
  const packaged = new URL("../SKILL.md", import.meta.url);
  try {
    return readFileSync(fileURLToPath(packaged), "utf8");
  } catch {
    return readFileSync(
      fileURLToPath(new URL("../../../skill/SKILL.md", import.meta.url)),
      "utf8"
    );
  }
}

export const skillMarkdown = loadSkill();
