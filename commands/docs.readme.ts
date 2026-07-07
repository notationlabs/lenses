import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "README — topology, setup, lens format, package map",
  run: async (r) => {
    await r.exec("cat README.md");
  },
});
