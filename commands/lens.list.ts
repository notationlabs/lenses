import { readdir, readFile } from "node:fs/promises";
import { z } from "zod";
import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "List the lens specs in lenses/",
  output: z.object({
    lenses: z.array(
      z.object({
        lens: z.string(),
        description: z.string().optional(),
        accepts: z.array(z.string()),
        tiers: z.array(z.string()),
        reads: z.array(z.string()),
        writes: z.array(z.string()),
      })
    ),
    total: z.number(),
  }),
  format(data, r) {
    for (const l of data.lenses) {
      r.info(`${l.lens}  [${l.tiers.join(" → ")}]${l.writes.length ? "  ⚠ writes: " + l.writes.join(",") : ""}`);
      r.info(`    ${l.description ?? ""}`);
      r.info(`    accepts: ${l.accepts.join(", ")}`);
    }
    r.info(`${data.total} lens(es)`);
  },
  run: async () => {
    const files = (await readdir("lenses")).filter((f) => f.endsWith(".json"));
    const lenses = [];
    for (const f of files) {
      const spec = JSON.parse(await readFile(`lenses/${f}`, "utf8"));
      lenses.push({
        lens: `${spec.lens}@v${spec.version}`,
        description: spec.description,
        accepts: spec.accepts ?? [],
        tiers: (spec.resolve ?? []).map((res: { kind: string }) => res.kind),
        reads: spec.effects?.reads ?? [],
        writes: spec.effects?.writes ?? [],
      });
    }
    return { lenses, total: lenses.length };
  },
});
