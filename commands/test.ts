import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run the resolver engine unit and integration tests (vitest)",
  run: async (r) => {
    await r.exec("pnpm --filter @djgrant/lens test");
  },
});
