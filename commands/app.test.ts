import { z } from "zod";
import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Run the app's end-to-end tests in Electron",
  context: {
    visible: {
      from: "flag",
      schema: z.boolean().default(false),
      description: "Show the test windows (they otherwise stay see-through and leave your focus alone)",
    },
    trace: {
      from: "flag",
      schema: z.boolean().default(false),
      description: "Print the app's log and the broker's CDP traffic",
    },
  },
  run: async (r, ctx) => {
    await r.exec("pnpm --filter @djgrant/lenses-core --filter @djgrant/lenses-client build");
    const env = [ctx.context.visible && "HARNESS_VISIBLE=1", ctx.context.trace && "HARNESS_TRACE=1"].filter(Boolean).join(" ");
    await r.exec(`${env} pnpm --filter @djgrant/lenses-app test`.trim());
  },
});
