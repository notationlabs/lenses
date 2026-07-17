#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLensClient } from "@djgrant/lens-client";
import { createLensMcpServer } from "./server.js";

async function main(): Promise<void> {
  const port = bridgePort(process.env.LENS_BRIDGE_PORT);
  const client = await createLensClient({
    directory: process.env.LENS_DIR,
    port,
  });
  const server = createLensMcpServer(client);
  const transport = new StdioServerTransport();
  process.stdin.once("end", () => {
    void Promise.all([server.close(), client.close()]);
  });
  await server.connect(transport);
  process.stderr.write(
    `[lens-mcp] stdio; extension bridge on ws://127.0.0.1:${client.status().port}\n`
  );
}

function bridgePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LENS_BRIDGE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
