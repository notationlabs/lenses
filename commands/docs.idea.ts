import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "The original idea — every webpage is a function (actors.md)",
  run: async (r) => {
    await r.exec("cat actors.md");
  },
});
