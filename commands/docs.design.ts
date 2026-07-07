import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "The design doc — lens format, resolver tiers, security model (lens-design.md)",
  run: async (r) => {
    await r.exec("cat lens-design.md");
  },
});
