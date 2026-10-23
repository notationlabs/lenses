import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build the app and the client it runs",
  run: async (r) => {
    await r.exec("pnpm --filter @djgrant/lenses-core --filter @djgrant/lenses-client --filter @djgrant/lenses-app build");
    r.reporter.success("Built the app");
  },
});
