#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createLensClient } from "@djgrant/lens-client";

const help = `Usage:
  lens list [--directory <path>] [--port <number>]
  lens call <lens> <target> [--args <json>] [--timeout-ms <number>]
  lens observe <target> [--wait-ms <number>] [--timeout-ms <number>]
  lens status [--wait-ms <number>]

Options:
  --directory, -d  Lens document directory (default: ./lenses)
  --port, -p       Extension bridge port (default: first free port from 4319–4329)
  --help, -h       Show this help
`;

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  if (name === "port" && (parsed < 1 || parsed > 65_535)) {
    throw new Error("port must be between 1 and 65535");
  }
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      args: { type: "string" },
      directory: { type: "string", short: "d" },
      help: { type: "boolean", short: "h" },
      port: { type: "string", short: "p" },
      "timeout-ms": { type: "string" },
      "wait-ms": { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(help);
    return;
  }

  const [command, ...operands] = positionals;
  const port = numberOption(values.port, "port");
  const waitMs = numberOption(values["wait-ms"], "wait-ms");
  const timeoutMs = numberOption(values["timeout-ms"], "timeout-ms");
  const client = await createLensClient({ directory: values.directory, port });

  try {
    let output: unknown;
    switch (command) {
      case "list":
        output = { status: client.status(), lenses: await client.list() };
        break;
      case "call": {
        const [lens, target] = operands;
        if (!lens || !target) throw new Error("call requires <lens> and <target>");
        const args = values.args === undefined ? undefined : JSON.parse(values.args);
        if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
          throw new Error("args must be a JSON object");
        }
        output = await client.call({ lens, target, args, timeoutMs });
        break;
      }
      case "observe": {
        const [target] = operands;
        if (!target) throw new Error("observe requires <target>");
        output = await client.observe({ target, waitMs, timeoutMs });
        break;
      }
      case "status":
        if (waitMs !== undefined) await client.waitForConnection(waitMs);
        output = client.status();
        break;
      default:
        throw new Error(`unknown command "${command}"`);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (
      typeof output === "object" &&
      output !== null &&
      "kind" in output &&
      output.kind === "error"
    ) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
