import { z } from "zod";
import { defineCommand } from "@pokit/core";

export const command = defineCommand({
  label: "Register lens-host with Claude Code (claude mcp add)",
  context: {
    writes: {
      from: "flag",
      schema: z.boolean().default(false),
      description: "Enable write lenses (LENS_ALLOW_WRITES=1)",
    },
  },
  run: async (r, ctx) => {
    await r.exec("pnpm -r build");
    const env = [`LENS_DIR="$PWD/lenses"`];
    if (ctx.context.writes) env.push(`LENS_ALLOW_WRITES=1`);
    const envFlags = env.map((e) => `--env ${e}`).join(" ");
    await r.exec(`claude mcp remove lens-host 2>/dev/null; claude mcp add lens-host ${envFlags} -- node "$PWD/packages/host/dist/index.js"`);
    r.reporter.success("lens-host registered. Open a NEW Claude Code session and ask it to use lens_call.");
    if (ctx.context.writes) r.reporter.warn("Write lenses are ENABLED — lenses can fire authenticated requests in your session.");
  },
});
