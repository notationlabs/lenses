import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { scanLensFiles, type LensClient } from "@djgrant/lenses-client";

export function createLensMcpServer(client: LensClient): McpServer {
  const server = new McpServer({ name: "lens-mcp", version: "0.1.0" });

  server.registerTool(
    "lens_list",
    {
      description:
        "List the lenses available to call in the user's browser: catalog lenses " +
        "(callable by name) and loose lens documents found in the working directory " +
        "(callable by file path).",
    },
    async () => {
      const files = await scanLensFiles(process.cwd()).catch(() => []);
      return ok({
        lenses: await client.list(),
        ...(files.length > 0
          ? {
              fileLensesNote: "call a file lens by passing its path as lens_call's lens argument",
              fileLenses: files.map(({ path, spec }) => ({
                path,
                name: spec.name,
                description: spec.description,
                params: spec.params,
              })),
            }
          : {}),
      });
    }
  );

  server.registerTool(
    "lens_call",
    {
      description: [
        "Call a lens in the user's browser.",
        "Returns a value, a structured outcome, or an error.",
        "For agent_extract, use the returned prompt and page text to complete the extraction.",
        "A lens with perform steps or mutating HTTP methods declares writes — treat it as destructive:",
        "it runs only with allowWrites true and is refused with code writes_not_allowed otherwise.",
      ].join(" "),
      inputSchema: z.object({
        lens: z.string().describe("Lens name, file path, or URL"),
        params: z.record(z.string(), z.unknown()).optional(),
        allowWrites: z
          .boolean()
          .optional()
          .describe(
            "Permit page actions or mutating HTTP requests; required for write lenses (default false)"
          ),
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
        "Load a page and return its text snapshot plus an index of captured JSON " +
        "requests (method, url, status, body size, short preview) with bodies elided. " +
        "To read a request's body, call again with request set to an index from the " +
        "listing or a URL substring (first 5 matches). " +
        "Set html to also get the body markup for writing DOM-tier selectors.",
      inputSchema: z.object({
        target: z.string().url(),
        waitMs: z.number().nonnegative().optional(),
        html: z.boolean().optional(),
        request: z
          .union([z.number().int().nonnegative(), z.string()])
          .optional()
          .describe("Captured-request selector: an index or a URL substring"),
      }),
    },
    async (input) => {
      const result = await client.observe(input);
      return result.kind === "error" ? failure(result.message) : ok(result);
    }
  );

  server.registerTool(
    "broker_status",
    { description: "Report whether the browser is reachable through the extension or CDP fallback." },
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
