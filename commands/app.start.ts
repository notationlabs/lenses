import { z } from "zod";
import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Build and run the app, with its broker on a port",
  context: {
    port: {
      from: "flag",
      schema: z.coerce.number().int().min(1).max(65_535).default(4319),
      description: "Broker port; another port runs beside an existing broker",
    },
  },
  run: async (r, ctx) => {
    await r.exec("pnpm --filter @djgrant/lenses-core --filter @djgrant/lenses-client --filter @djgrant/lenses-app build");
    r.reporter.info(`Broker on ws://127.0.0.1:${ctx.context.port}. Try: lens call hn/top --catalog ./examples --port ${ctx.context.port}`);
    // Some shells (and Electron-based editors) set ELECTRON_RUN_AS_NODE, which runs Electron as plain Node.
    await r.exec(`cd app && env -u ELECTRON_RUN_AS_NODE LENS_BROKER_PORT=${ctx.context.port} npx electron .`);
  },
});
