import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "The pitch — why lenses, who they're for (lens-pitch.md)",
  run: async (r) => {
    await r.exec("cat lens-pitch.md");
  },
});
