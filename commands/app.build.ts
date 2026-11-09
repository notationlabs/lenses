import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build the app and the client it runs",
  run: async (r) => {
    await r.exec("pnpm --filter @notation/lenses-core --filter @notation/lenses-client --filter @notation/lenses-app build");
    r.reporter.success("Built the app");
  },
});
