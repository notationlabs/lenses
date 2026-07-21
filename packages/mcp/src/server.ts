import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { LensClient } from "@djgrant/lens-client";

export function createLensMcpServer(client: LensClient): McpServer {
  const server = new McpServer({ name: "lens-mcp", version: "0.1.0" });

  server.registerTool(
    "lens_list",
    { description: "List the lenses available to call in the user's browser." },
    async () => ok({ lenses: await client.list() })
  );

  server.registerTool(
    "lens_call",
    {
      description: [
        "Call a lens in the user's browser.",
        "Returns a value, a structured outcome, or an error.",
        "For agent_extract, use the returned prompt and page text to complete the extraction.",
      ].join(" "),
      inputSchema: z.object({
        lens: z.string().describe("Lens name, file path, or URL"),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (input) => {
      const result = await client.call(input);
      return result.kind === "error" ? failure(result.message) : ok(result);
    }
  );

  server.registerTool(
    "lens_observe",
    {
      description:
        "Load a page and return its captured JSON requests and text snapshot. " +
        "Set html to also get the body markup for writing DOM-tier selectors.",
      inputSchema: z.object({
        target: z.string().url(),
        waitMs: z.number().nonnegative().optional(),
        html: z.boolean().optional(),
      }),
    },
    async (input) => {
      const result = await client.observe(input);
      return result.kind === "error" ? failure(result.message) : ok(result);
    }
  );

  server.registerTool(
    "broker_status",
    { description: "Report whether the browser extension is connected." },
    async () => ok(await client.status())
  );

  return server;
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
