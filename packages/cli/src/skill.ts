import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Agent skill for the lens CLI, printed by `lens skill` in SKILL.md format.
 * The canonical source is `skill/SKILL.md` at the repo root (kept there so it is
 * discoverable on GitHub). The @notation/lenses build copies it next to `dist/`,
 * so the published tarball is self-contained. Running from source falls back
 * to the repo-root path.
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
