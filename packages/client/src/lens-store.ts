import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSpec, type LensSpec } from "@djgrant/lenses-core";
import {
  applyCatalogSettings,
  catalogSettingsFor,
  parseCatalogSource,
  type CatalogSource,
} from "./catalog.js";

export interface CatalogUpdate {
  source: string;
  lenses: number;
}

/** Resolve a name, JSON file, or URL to a validated lens spec across ordered catalog sources. */
export class LensStore {
  private byName = new Map<string, LensSpec>();
  private countBySource = new Map<string, number>();
  private readonly sources: CatalogSource[];

  constructor(catalog: string | string[] | CatalogSource[]) {
    const refs = Array.isArray(catalog) ? catalog : [catalog];
    this.sources = refs.map((ref) => (typeof ref === "string" ? parseCatalogSource(ref) : ref));
  }

  /**
   * Load every source in order. Scoped names must be unique across sources;
   * a contested shortname resolves to the earliest source that declares it.
   */
  async load(): Promise<LensSpec[]> {
    const byName = new Map<string, LensSpec>();
    const owner = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const source of this.sources) {
      const specs = await source.load();
      counts.set(source.id, specs.length);
      for (const spec of specs) {
        const previous = owner.get(spec.name);
        if (previous !== undefined) {
          throw new Error(
            previous === source.id
              ? `duplicate lens name "${spec.name}" in ${source.id}`
              : `duplicate lens name "${spec.name}" in ${previous} and ${source.id}`
          );
        }
        owner.set(spec.name, source.id);
        byName.set(spec.name, spec);
        const short = shortName(spec.name);
        if (!byName.has(short)) byName.set(short, spec);
      }
    }
    this.byName = byName;
    this.countBySource = counts;
    return this.list();
  }

  /** Refresh cached sources (git clones) from their origins, then reload. */
  async update(): Promise<CatalogUpdate[]> {
    for (const source of this.sources) await source.update?.();
    await this.load();
    return this.sources.map((source) => ({
      source: source.id,
      lenses: this.countBySource.get(source.id) ?? 0,
    }));
  }

  list(): LensSpec[] {
    const seen = new Set<string>();
    const specs: LensSpec[] = [];
    for (const spec of this.byName.values()) {
      if (!seen.has(spec.name)) {
        seen.add(spec.name);
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
      const path = resolve(ref);
      // `lens call ./my-lens.json` is how SKILL.md says to test a document, so
      // it has to see the same helpers a catalogue load would give it.
      return applyCatalogSettings(
        JSON.parse(await readFile(path, "utf8")),
        await catalogSettingsFor(path)
      );
    }

    await this.load();
    const spec = this.byName.get(ref);
    if (spec) return spec;
    throw new Error(`unknown lens "${ref}"`);
  }
}

function shortName(name: string): string {
  return name.slice(name.indexOf("/") + 1);
}
