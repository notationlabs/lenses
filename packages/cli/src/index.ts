#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createLensClient } from "@djgrant/lens-client";

const globalHelp = `Usage:
  lens list [--directory <path>] [--port <number>]
  lens call <lens> <target> [--args <json>] [--timeout-ms <number>]
  lens observe <target> [--wait-ms <number>] [--timeout-ms <number>]
  lens status [--wait-ms <number>]

Run lens <command> --help for command-specific help.

Global options:
  --directory, -d  Lens document directory (default: ./lenses)
  --port, -p       Extension bridge port (default: first free port from 4319–4329)
  --verbose, -v    Write timestamped diagnostics to stderr
  --help, -h       Show this help
`;

const commandHelp: Record<string, string> = {
  list: `Usage: lens list [options]

List validated lenses from the configured directory.

Options:
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Extension bridge port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  call: `Usage: lens call <lens> <target> [options]

Call a lens against a concrete webpage URL.

Arguments:
  lens                    Name such as hn/item, exact version such as hn/item@v1,
                          JSON file path, or HTTP URL to a lens document
  target                  Webpage URL matched against the lens's accepts patterns

Options:
  --args <json>           JSON object exposed to expressions as $<key>. Explicit
                          args override variables captured from target URL holes.
  --timeout-ms <number>   Whole browser-call timeout (default: 90000)
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Extension bridge port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Bundled lens arguments:
  hn/item                 p: page number (default 1), limit: comments per page
                          (default 30)

Example:
  lens call hn/item 'https://news.ycombinator.com/item?id=42' \\
    --args '{"p":2,"limit":10}'
`,
  observe: `Usage: lens observe <target> [options]

Load a page and return its text snapshot and captured JSON requests.

Options:
  --wait-ms <number>      Time to collect requests after loading (default: 4000)
  --timeout-ms <number>   Whole observation timeout (default: 60000)
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Extension bridge port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  status: `Usage: lens status [options]

Report the local bridge port and browser-extension connection state.

Options:
  --wait-ms <number>      Wait this long for the extension before reporting
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Extension bridge port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
};

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
      verbose: { type: "boolean", short: "v" },
      "wait-ms": { type: "string" },
    },
  });

  const [command, ...operands] = positionals;
  if (values.help || !command) {
    process.stdout.write((command && commandHelp[command]) || globalHelp);
    return;
  }

  if (!(command in commandHelp)) throw new Error(`unknown command "${command}"`);

  if (command === "call" && operands.length < 2) throw new Error("call requires <lens> and <target>");
  if (command === "observe" && operands.length < 1) throw new Error("observe requires <target>");

  const port = numberOption(values.port, "port");
  const waitMs = numberOption(values["wait-ms"], "wait-ms");
  const timeoutMs = numberOption(values["timeout-ms"], "timeout-ms");
  const startedAt = Date.now();
  const log = values.verbose
    ? (message: string) => process.stderr.write(`[lens +${Date.now() - startedAt}ms] ${message}\n`)
    : undefined;
  const client = await createLensClient({ directory: values.directory, port, log });

  try {
    let output: unknown;
    switch (command) {
      case "list":
        output = { status: client.status(), lenses: await client.list() };
        break;
      case "call": {
        const [lens, target] = operands;
        const args = values.args === undefined ? undefined : JSON.parse(values.args);
        if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
          throw new Error("args must be a JSON object");
        }
        output = await client.call({ lens, target, args, timeoutMs });
        break;
      }
      case "observe": {
        const [target] = operands;
        output = await client.observe({ target, waitMs, timeoutMs });
        break;
      }
      case "status":
        if (waitMs !== undefined) await client.waitForConnection(waitMs);
        output = client.status();
        break;
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
