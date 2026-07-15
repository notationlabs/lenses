import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineCommand } from "@pokit/core";
import { defineLens, validateSpec } from "@actors/lens";

/** Serialize to canonical JSON: 2-space indent, insertion-ordered keys, trailing newline. */
function canonical(spec: unknown): string {
  return JSON.stringify(spec, null, 2) + "\n";
}

export const command = defineCommand({
  label: "Compile every lenses/*.ts authoring module to canonical lenses/*.json",
  run: async (r) => {
    const dir = resolve("lenses");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    if (files.length === 0) {
      r.reporter.info("no lenses/*.ts modules to compile");
      return;
    }
    for (const f of files) {
      const mod = await import(pathToFileURL(resolve(dir, f)).href);
      const authored = mod.default ?? mod.lens ?? mod.spec;
      // Route through defineLens (validates) then re-validate for good measure.
      const spec = validateSpec(defineLens(authored));
      const out = f.replace(/\.ts$/, ".json");
      await writeFile(resolve(dir, out), canonical(spec), "utf8");
      r.reporter.success(`${f} → ${out}  (${spec.lens}@v${spec.version})`);
    }
    r.reporter.success(`compiled ${files.length} lens module(s)`);
  },
});
