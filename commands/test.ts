import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run workspace tests",
  run: async (r) => {
    await r.exec("pnpm -r test");
  },
});
