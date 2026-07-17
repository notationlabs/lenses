import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSpec, type LensSpec } from "@djgrant/lens";

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
    // A `<name>.ts` authoring module is the source of truth; import it
    // directly (bun runs TS natively). `<name>.json` is the canonical publish
    // artifact (`pok lens build`) and the fallback for runtimes that can't
    // import TS, or for JSON-only lenses.
    const bases = new Set<string>();
    for (const e of entries) {
      if (e.endsWith(".ts")) bases.add(e.slice(0, -3));
      else if (e.endsWith(".json")) bases.add(e.slice(0, -5));
    }
    for (const base of bases) {
      try {
        const spec = await this.loadFile(base, entries);
        this.byName.set(`${spec.lens}@v${spec.version}`, spec);
        // unversioned name points at the highest version
        const existing = this.byName.get(spec.lens);
        if (!existing || existing.version < spec.version) this.byName.set(spec.lens, spec);
      } catch (err) {
        console.error(`[lens-host] skipping ${base}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return this.list();
  }

  private async loadFile(base: string, entries: string[]): Promise<LensSpec> {
    if (entries.includes(`${base}.ts`)) {
      try {
        const mod = await import(pathToFileURL(join(this.dir, `${base}.ts`)).href);
        return validateSpec(mod.default ?? mod.lens ?? mod.spec);
      } catch (err) {
        if (!entries.includes(`${base}.json`)) throw err;
        // TS import failed (e.g. running under node) — use the compiled JSON.
      }
    }
    return validateSpec(JSON.parse(await readFile(join(this.dir, `${base}.json`), "utf8")));
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

    if (ref.endsWith(".ts")) {
      const mod = await import(pathToFileURL(resolve(ref)).href);
      return validateSpec(mod.default ?? mod.lens ?? mod.spec);
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
