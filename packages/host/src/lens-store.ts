import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateSpec, type LensSpec } from "@actors/lens";

/**
 * Resolves a lens reference to a validated spec. A reference is:
 *   - a name from the local lens directory: "hn/top" or "hn/top@v1"
 *   - a filesystem path to a .json spec
 *   - an http(s) URL to a .json spec (the published-as-a-gist story)
 */
export class LensStore {
  private byName = new Map<string, LensSpec>();
  private urlCache = new Map<string, { spec: LensSpec; fetchedAt: number }>();

  constructor(private dir: string) {}

  async loadLocal(): Promise<LensSpec[]> {
    this.byName.clear();
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    // A lens authored as `<name>.ts` is compiled (via `pok lens build`) to
    // `<name>.json`, which is the canonical artifact the engine runs. Prefer
    // that compiled JSON; fall back to raw `<name>.json` for JSON-only lenses.
    const bases = new Set<string>();
    for (const e of entries) {
      if (e.endsWith(".ts")) bases.add(e.slice(0, -3));
      else if (e.endsWith(".json")) bases.add(e.slice(0, -5));
    }
    const files: string[] = [];
    for (const base of bases) {
      const json = `${base}.json`;
      if (entries.includes(json)) {
        files.push(json);
      } else if (entries.includes(`${base}.ts`)) {
        console.error(
          `[lens-host] ${base}.ts has no compiled ${json} — run \`pok lens build\``
        );
      }
    }
    for (const f of files) {
      try {
        const spec = validateSpec(JSON.parse(await readFile(join(this.dir, f), "utf8")));
        this.byName.set(`${spec.lens}@v${spec.version}`, spec);
        // unversioned name points at the highest version
        const existing = this.byName.get(spec.lens);
        if (!existing || existing.version < spec.version) this.byName.set(spec.lens, spec);
      } catch (err) {
        console.error(`[lens-host] skipping ${f}: ${err instanceof Error ? err.message : err}`);
      }
    }
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
    // reload local dir lazily so newly authored lenses appear without restart
    if (this.byName.size === 0) await this.loadLocal();
    const local = this.byName.get(ref);
    if (local) return local;

    if (ref.startsWith("http://") || ref.startsWith("https://")) {
      const cached = this.urlCache.get(ref);
      if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached.spec;
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`fetching lens ${ref}: HTTP ${res.status}`);
      const spec = validateSpec(await res.json());
      this.urlCache.set(ref, { spec, fetchedAt: Date.now() });
      return spec;
    }

    if (ref.endsWith(".json")) {
      const spec = validateSpec(JSON.parse(await readFile(resolve(ref), "utf8")));
      return spec;
    }

    // maybe the dir changed on disk — one refresh before giving up
    await this.loadLocal();
    const retry = this.byName.get(ref);
    if (retry) return retry;
    throw new Error(
      `unknown lens "${ref}" — use lens_list to see available lenses, or pass a path/URL to a lens JSON spec`
    );
  }
}
