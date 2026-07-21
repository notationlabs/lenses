#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createLensClient } from "@djgrant/lens-client";

const globalHelp = `Usage:
  lens list [--directory <path>] [--port <number>]
  lens call <lens> [--params <json>] [--timeout-ms <number>] [--lax]
  lens schema <lens>
  lens observe <target> [--wait-ms <number>] [--timeout-ms <number>]
  lens status [--wait-ms <number>]

Run lens <command> --help for command-specific help.

Global options:
  --directory, -d  Lens document directory (default: ./lenses)
  --port, -p       Persistent browser broker port (default: 4319)
  --verbose, -v    Write timestamped diagnostics to stderr
  --help, -h       Show this help
`;

const commandHelp: Record<string, string> = {
  list: `Usage: lens list [options]

List validated lenses from the configured directory.

Options:
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  call: `Usage: lens call <lens> [options]

Call a lens with its declared parameters.

Arguments:
  lens                    Scoped name such as @djgrant/hn/item, shortname such as
                          hn/item, JSON file path, or HTTP URL to a lens document

Options:
  --params <json>         Declared lens parameters as a JSON object. Parameters
                          are available to URL templates and resolver expressions.
  --timeout-ms <number>   Whole browser-call timeout (default: 90000)
  --lax                   Attach result schema violations to the value result
                          as warnings instead of failing; by default a value
                          that violates the lens's declared result schema is
                          a structured error naming the failing paths
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Bundled lens parameters:
  hn/item                 id: story id; p: comment page (default 1),
                          limit: comments per page (default 30)

Example:
  lens call claude/usage

  lens call hn/item --params '{"id":"42","p":2,"limit":10}'
`,
  schema: `Usage: lens schema <lens> [options]

Emit a standard JSON Schema (draft 2020-12) for a lens's resolved value,
derived from the lens document's "returns" declaration.

Arguments:
  lens                    Scoped name such as @djgrant/hn/top, shortname such as
                          hn/top, JSON file path, or HTTP URL to a lens document

Options:
  --directory, -d <path>  Lens directory (default: ./lenses)
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  observe: `Usage: lens observe <target> [options]

Load a page and return its text snapshot and captured JSON requests.

Options:
  --wait-ms <number>      Time to collect requests after loading (default: 4000)
  --timeout-ms <number>   Whole observation timeout (default: 60000)
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  status: `Usage: lens status [options]

Report the local broker port and browser-extension connection state.

Options:
  --wait-ms <number>      Wait this long for the extension before reporting
  --directory, -d <path>  Lens directory (default: ./lenses)
  --port, -p <number>     Persistent browser broker port
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
      params: { type: "string" },
      directory: { type: "string", short: "d" },
      help: { type: "boolean", short: "h" },
      port: { type: "string", short: "p" },
      lax: { type: "boolean" },
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

  if (command === "call" && operands.length < 1) throw new Error("call requires <lens>");
  if (command === "schema" && operands.length !== 1) throw new Error("schema requires one <lens>");
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
        const [lens] = operands;
        if (operands.length > 1) throw new Error("call accepts one <lens> operand");
        const params = values.params === undefined ? undefined : JSON.parse(values.params);
        if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
          throw new Error("params must be a JSON object");
        }
        output = await client.call({ lens, params, timeoutMs, strict: !values.lax });
        break;
      }
      case "schema":
        output = await client.schema(operands[0]);
        break;
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
