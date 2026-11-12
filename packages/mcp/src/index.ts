#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLensClient, errorMessage, parsePort } from "@notation/lenses-client";
import { createLensMcpServer } from "./server.js";

async function main(): Promise<void> {
  const rawPort = process.env.LENS_BROKER_PORT;
  const port = rawPort === undefined ? undefined : parsePort(rawPort, "LENS_BROKER_PORT");
  const catalog = (process.env.LENS_CATALOG ?? "")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  if (catalog.length === 0) {
    process.stderr.write(
      "[lens-mcp] LENS_CATALOG unset; lens_list will only show file lenses and lens_call needs a path or URL\n"
    );
  }
  const client = createLensClient({ catalog: catalog.length > 0 ? catalog : undefined, port });
  const server = createLensMcpServer(client);
  const transport = new StdioServerTransport();
  process.stdin.once("end", () => {
    void Promise.all([server.close(), client.close()]);
  });
  await server.connect(transport);
  // The server is already connected: a broker that cannot start now is reported
  // per call instead of ending the process.
  client.status().then(
    ({ port }) => process.stderr.write(`[lens-mcp] stdio; persistent browser broker on ws://127.0.0.1:${port}\n`),
    (error) => process.stderr.write(`[lens-mcp] stdio; browser broker not started: ${errorMessage(error)}\n`)
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : errorMessage(error)}\n`);
  process.exit(1);
});
