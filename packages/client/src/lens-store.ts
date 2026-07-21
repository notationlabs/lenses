import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateSpec, type LensSpec } from "@djgrant/lens";

/** Resolve a local name, JSON file, or URL to a validated lens spec. */
export class LensStore {
  private byName = new Map<string, LensSpec>();

  constructor(private readonly catalog: string) {}

  async loadLocal(): Promise<LensSpec[]> {
    const loaded = new Map<string, LensSpec>();
    let entries: string[] = [];
    try {
      entries = await readdir(this.catalog);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.byName = loaded;
        return [];
      }
      throw error;
    }

    for (const file of entries.filter((entry) => entry.endsWith(".json"))) {
      const spec = validateSpec(JSON.parse(await readFile(join(this.catalog, file), "utf8")));
      if (loaded.has(spec.name)) throw new Error(`duplicate lens name "${spec.name}"`);
      loaded.set(spec.name, spec);
      const short = shortName(spec.name);
      if (loaded.has(short)) throw new Error(`duplicate lens shortname "${short}"`);
      loaded.set(short, spec);
    }
    this.byName = loaded;
    return this.list();
  }

  list(): LensSpec[] {
    const seen = new Set<string>();
    const specs: LensSpec[] = [];
    for (const spec of this.byName.values()) {
      const key = spec.name;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push(spec);
      }
    }
    return specs;
  }

  async resolve(ref: string): Promise<LensSpec> {
    if (ref.startsWith("http://") || ref.startsWith("https://")) {
      const response = await fetch(ref);
      if (!response.ok) throw new Error(`fetching lens ${ref}: HTTP ${response.status}`);
      return validateSpec(await response.json());
    }
    if (ref.endsWith(".json")) {
      return validateSpec(JSON.parse(await readFile(resolve(ref), "utf8")));
    }

    await this.loadLocal();
    const spec = this.byName.get(ref);
    if (spec) return spec;
    throw new Error(`unknown lens "${ref}"`);
  }
}

function shortName(name: string): string {
  return name.slice(name.indexOf("/") + 1);
}
