import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { scanLensFiles, type LensClient } from "@djgrant/lenses-client";

export function createLensMcpServer(client: LensClient, progressIntervalMs = 10_000): McpServer {
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
        authLeaseMs: z.number().int().min(0).max(600_000).optional()
          .describe("Milliseconds to wait for sign-in after needs_auth (default 120000 with MCP progress, 0 without)"),
        noCache: z
          .boolean()
          .optional()
          .describe("Ignore cached results and do not cache this call's result (default false)"),
        allowWrites: z
          .boolean()
          .optional()
          .describe(
            "Permit page actions or mutating HTTP requests; required for write lenses (default false)"
          ),
        tab: z
          .string()
          .optional()
          .describe("Run in the tab a previous result named in its tab field; a closed tab is error code tab_closed"),
      }),
    },
    async (input, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      const authLeaseMs = input.authLeaseMs ?? (token === undefined ? 0 : 120_000);
      const started = Date.now();
      const timer = token === undefined ? undefined : setInterval(() => {
        void ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken: token, progress: Date.now() - started, message: "Waiting for sign-in or request completion" },
        }).catch(() => {});
      }, progressIntervalMs);
      try {
        const result = await client.call({ ...input, authLeaseMs });
        return result.kind === "error" ? failure(result.message) : ok(result);
      } finally {
        if (timer) clearInterval(timer);
      }
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
        "Set html to also get the body markup for writing DOM-tier selectors. " +
        "Set tab (a previous result's tab field) to observe that tab without loading a page: " +
        "without target it is read where it is; a target is reached in-page.",
      inputSchema: z.object({
        target: z.string().url().optional(),
        tab: z.string().optional(),
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

  return server;
}

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
