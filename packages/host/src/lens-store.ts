import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateSpec, type LensSpec } from "@djgrant/lens";

/**
 * Resolves a lens reference to a validated spec. A reference is:
 *   - a name from the local lens directory: "hn/top" or "hn/top@v1"
 *   - a filesystem path to a .json spec
 *   - an http(s) URL to a .json spec (the published-as-a-gist story)
 */
export class LensStore {
  private byName = new Map<string, LensSpec>();

  constructor(private dir: string) {}

  async loadLocal(): Promise<LensSpec[]> {
    const loaded = new Map<string, LensSpec>();
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      // No lens dir yet is normal; anything else (perms, not-a-dir) should surface.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.byName = loaded;
        return [];
      }
      throw err;
    }
    for (const file of entries.filter((e) => e.endsWith(".json"))) {
      const spec = validateSpec(JSON.parse(await readFile(join(this.dir, file), "utf8")));
      loaded.set(`${spec.lens}@v${spec.version}`, spec);
      // unversioned name points at the highest version
      const existing = loaded.get(spec.lens);
      if (!existing || existing.version < spec.version) loaded.set(spec.lens, spec);
    }
    this.byName = loaded;
    return this.list();
  }

  list(): LensSpec[] {
    const seen = new Set<string>();
    const out: LensSpec[] = [];
    for (const spec of this.byName.values()) {
      const key = `${spec.lens}@v${spec.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(spec);
      }
    }
    return out;
  }

  async resolveRef(ref: string): Promise<LensSpec> {
    if (ref.startsWith("http://") || ref.startsWith("https://")) {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`fetching lens ${ref}: HTTP ${res.status}`);
      return validateSpec(await res.json());
    }
    if (ref.endsWith(".json")) {
      return validateSpec(JSON.parse(await readFile(resolve(ref), "utf8")));
    }
    // reload the local dir so newly authored lenses appear without a restart
    await this.loadLocal();
    const local = this.byName.get(ref);
    if (local) return local;
    throw new Error(
      `unknown lens "${ref}" — use lens_list to see available lenses, or pass a path/URL to a lens JSON spec`
    );
  }
}
