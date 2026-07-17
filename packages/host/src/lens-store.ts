import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateSpec, type LensSpec } from "@djgrant/lens";

/** Resolve a local name, JSON file, or URL to a validated lens spec. */
export class LensStore {
  private byName = new Map<string, LensSpec>();

  constructor(private dir: string) {}

  async loadLocal(): Promise<LensSpec[]> {
    const loaded = new Map<string, LensSpec>();
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      // A missing lens directory is valid; surface other errors.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.byName = loaded;
        return [];
      }
      throw err;
    }
    for (const file of entries.filter((e) => e.endsWith(".json"))) {
      const spec = validateSpec(JSON.parse(await readFile(join(this.dir, file), "utf8")));
      loaded.set(`${spec.lens}@v${spec.version}`, spec);
      // Point unversioned names at the latest version.
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
    // Pick up new local lenses without restarting the host.
    await this.loadLocal();
    const local = this.byName.get(ref);
    if (local) return local;
    throw new Error(
      `unknown lens "${ref}" — use lens_list to see available lenses, or pass a path/URL to a lens JSON spec`
    );
  }
}
