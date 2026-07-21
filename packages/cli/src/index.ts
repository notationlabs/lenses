#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateTsSdk, type LensSpec } from "@djgrant/lens";
import { createLensClient, LensStore } from "@djgrant/lens-client";

const globalHelp = `Usage:
  lens list [--directory <path>] [--port <number>]
  lens call <lens> [--params <json>] [--timeout-ms <number>] [--lax]
  lens schema <lens>
  lens gen ts-sdk [<directory> ...] [--out <file>]
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
  gen: `Usage: lens gen <target> [<directory> ...] [options]

Generate an SDK for every lens document in the given directories.

Targets:
  ts-sdk                  TypeScript: a Lenses map of params and result types
                          per lens, and a TypedLensClient whose call() is typed
                          against it. Writes to stdout unless --out is given.

Arguments:
  directory               One or more lens directories (default: --directory,
                          falling back to ./lenses). Names must be unique
                          across all directories.

Options:
  --out, -o <file>        Write generated source to this file
  --directory, -d <path>  Lens directory (default: ./lenses)
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Example:
  lens gen ts-sdk -o src/lenses.gen.ts
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
      out: { type: "string", short: "o" },
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

  if (command === "gen") {
    const [target, ...directoryOperands] = operands;
    if (target !== "ts-sdk") throw new Error('gen requires a target; supported targets: "ts-sdk"');
    const directories =
      directoryOperands.length > 0 ? directoryOperands : [values.directory ?? "lenses"];
    const specs = new Map<string, LensSpec>();
    for (const directory of directories) {
      for (const spec of await new LensStore(resolve(directory)).loadLocal()) {
        if (specs.has(spec.name)) {
          throw new Error(`duplicate lens name "${spec.name}" in ${directory}`);
        }
        specs.set(spec.name, spec);
      }
    }
    const source = generateTsSdk([...specs.values()]);
    if (values.out) await writeFile(values.out, source, "utf8");
    else process.stdout.write(source);
    return;
  }

  const port = numberOption(values.port, "port");
  const waitMs = numberOption(values["wait-ms"], "wait-ms");
  const timeoutMs = numberOption(values["timeout-ms"], "timeout-ms");
  const startedAt = Date.now();
  const log = values.verbose
    ? (message: string) => process.stderr.write(`[lens +${Date.now() - startedAt}ms] ${message}\n`)
    : undefined;
  const client = createLensClient({ directory: values.directory, port, log });

  try {
    let output: unknown;
    switch (command) {
      case "list":
        output = { status: await client.status(), lenses: await client.list() };
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
        output = await client.status();
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
