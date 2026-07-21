import { readdir, readFile } from "node:fs/promises";
import { defineCommand } from "@pokit/core";
import { validateSpec } from "@djgrant/lens";

export const command = defineCommand({
  label: "Validate every lens spec in examples/ against the engine's validator",
  run: async (r) => {
    const files = (await readdir("examples")).filter((f) => f.endsWith(".json"));
    let failed = 0;
    for (const f of files) {
      try {
        const spec = validateSpec(JSON.parse(await readFile(`examples/${f}`, "utf8")));
        r.reporter.success(`${f} → ${spec.name} ok`);
      } catch (err) {
        failed++;
        r.reporter.error(`${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed > 0) throw new Error(`${failed}/${files.length} lens spec(s) invalid`);
    r.reporter.success(`${files.length} lens spec(s) valid`);
  },
});
