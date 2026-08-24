#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage, evaluate, generateTsSdk, type LensSpec } from "@djgrant/lenses-core";
import { createLensClient, LensStore } from "@djgrant/lenses-client";
import { serveGraphql } from "./graphql-server.js";
import { skillMarkdown } from "./skill.js";

const globalHelp = `Usage:
  lens list [--catalog <source>] [--port <number>]
  lens call <lens> [--params <json>] [--timeout-ms <number>] [--lax] [--allow-writes]
  lens schema <lens>
  lens gen ts-sdk [<catalog> ...] [--out <file>]
  lens eval <expression> [--input <file>] [--params <json>]
  lens observe <target> [--request <index|pattern>] [--wait-ms <number>] [--timeout-ms <number>] [--html]
  lens status [--wait-ms <number>]
  lens broker <status|release|acquire|shutdown>
  lens update [--catalog <source>]
  lens graphql <playground|serve> [--catalog <source>] [--listen <port>] [--max-calls <number>]
  lens skill

Run lens <command> --help for command-specific help.

Global options:
  --catalog, -c    Lens catalog source; repeatable, tried in order (required
                   except for status, observe, eval, and skill).
                   A directory path (./examples or file:./examples), a git
                   reference (git:github.com/owner/repo#ref/subdir), or an
                   HTTP catalog index URL (https://…/catalog.json)
  --port, -p       Persistent browser broker port (default: 4319)
  --verbose, -v    Write timestamped diagnostics to stderr
  --help, -h       Show this help
`;

const commandHelp: Record<string, string> = {
  list: `Usage: lens list [options]

List validated lenses from the configured catalog.

Options:
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
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
  --allow-writes          Permit page actions and mutating HTTP requests.
                          Without it a write lens is refused with
                          code "writes_not_allowed"; read lenses never need it.
  --lax                   Attach result schema violations to the value result
                          as warnings instead of failing; by default a value
                          that violates the lens's declared result schema is
                          a structured error naming the failing paths
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Bundled lens parameters:
  hn/item                 id: story id; p: comment page (default 1),
                          limit: comments per page (default 30)

Example:
  lens call claude/usage

  lens call hn/item --params '{"id":"42","p":2,"limit":10}'

  lens call chatgpt/send --params '{"message":"hello"}' --allow-writes
`,
  schema: `Usage: lens schema <lens> [options]

Emit a standard JSON Schema (draft 2020-12) for a lens's resolved value,
derived from the lens document's "returns" declaration.

Arguments:
  lens                    Scoped name such as @djgrant/hn/top, shortname such as
                          hn/top, JSON file path, or HTTP URL to a lens document

Options:
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  gen: `Usage: lens gen <target> [<catalog> ...] [options]

Generate an SDK for every lens document in the given catalogs.

Targets:
  ts-sdk                  TypeScript: a Lenses map of params and result types
                          per lens, and a createLensClient whose call() is
                          typed against it. Writes to stdout unless --out is
                          given.

Arguments:
  catalog                 One or more lens catalog sources (defaults to
                          --catalog when omitted). Names must be unique across
                          all catalogs.

Options:
  --out, -o <file>        Write generated source to this file
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Example:
  lens gen ts-sdk -o src/lenses.gen.ts
`,
  eval: `Usage: lens eval <expression> [options]

Evaluate a JSONata expression against local JSON, in the same sandbox a lens's
map, post, and detect bodies run in. No browser or catalog needed — the offline
way to iterate on an expression before putting it in a lens document.

Arguments:
  expression              A JSONata expression

Options:
  --input <file>          JSON file to evaluate against; reads stdin when piped
  --params <json>         Lens parameters, bound as JSONata variables ($name)
  --help, -h              Show this help

An expression that produces no result prints null and a stderr note.

Example:
  lens call hn/top | jq .value | lens eval '[stories.{ "t": title }]'
`,
  observe: `Usage: lens observe <target> [options]

Load a page and return its text snapshot and an index of captured JSON requests
(method, url, status, body size, short preview). Request bodies are elided; drill
into one with --request. No catalog needed.

Options:
  --request <sel>         Return the body of captured requests matching <sel>:
                          a request index from a prior observation, or a URL
                          substring (first 5 matches)
  --html                  Also return the page's body HTML with scripts, styles,
                          and comments stripped — the input for writing DOM-tier
                          selectors
  --wait-ms <number>      Time to collect requests after loading (default: 4000)
  --timeout-ms <number>   Whole observation timeout (default: 60000)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Example:
  lens observe https://example.com
  lens observe https://example.com --request api/v2/items
`,
  status: `Usage: lens status [options]

Report the local broker port, connected backends and capabilities, Chrome vs
extension reachability, active/queued call state, recent backend errors and CDP
reconnect attempts. The CDP lease is "held", "released", or "disconnected".
Browser calls use one serial broker queue. No catalog needed.

Options:
  --wait-ms <number>      Wait this long for the browser before reporting
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  broker: `Usage: lens broker <action> [options]

Control the broker's CDP lease on Chrome's single consented debugging slot.
No catalog needed.

Actions:
  status                  Report the lease without side effects
  release                 Drop the CDP connection so other CDP tools (e.g.
                          chrome-devtools-mcp) can connect to Chrome. The
                          broker keeps running and reacquires on the next
                          lens call or "acquire".
  acquire                 Reconnect to Chrome. Consent is session-scoped, so
                          no new Allow dialog appears; bare lens calls also
                          reacquire silently. Release frees Chrome's single
                          debugging slot for other tools — it is not a hard
                          stop. Set LENS_BROKER_IDLE_RELEASE_MS in the
                          broker's environment to opt in to idle auto-release.
  shutdown                Retire the broker: it drains in-flight work,
                          releases the lease and exits. The next lens call
                          spawns a fresh one. Brokers also exit on their own
                          with no clients, no extension attached and nothing
                          in flight: after LENS_BROKER_NO_BROWSER_EXIT_MS
                          (default 10s) when no browser is reachable, or
                          LENS_BROKER_IDLE_EXIT_MS (default 15m, 0 disables)
                          when one is there but unused.

Options:
  --timeout-ms <number>   Whole control-call timeout (default: 60000)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  update: `Usage: lens update [options]

Refresh cached catalog sources — git clones and HTTP indexes — from their
origins, then report the lens count per source. File sources are read live
and have nothing to refresh.

Options:
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help
`,
  graphql: `Usage: lens graphql <action> [options]

Serve the catalog compiled to a GraphQL schema, on loopback only — queries
drive real lens calls through the signed-in browser, so the port is never
exposed beyond this machine and cross-origin requests are refused.

Actions:
  playground              Serve the /graphql endpoint with GraphiQL at /
  serve                   Serve the /graphql endpoint only

Each lens is a Query field grouped by site, its params the field args. Each
$lens ref in a returns contract is an object field resolved by calling the
target lens — only when selected, with \`first\` on arrays to bound how many
rows resolve onward. Outcomes surface as GraphQL errors carrying the
document's hint; response extensions list the lens calls each operation made
(resolver tier, cache state, ttl, landed URL, duration).

Options:
  --listen <number>       HTTP port to serve on (default: the first free port
                          from 4381 upward, so servers for several catalogs
                          can run side by side)
  --max-calls <number>    Lens call budget per operation (default: 25);
                          exhaustion is a GraphQL error naming the lens
  --catalog, -c <source>  Lens catalog source; repeatable, tried in order (required)
  --port, -p <number>     Persistent browser broker port
  --verbose, -v           Write timestamped diagnostics to stderr
  --help, -h              Show this help

Example:
  lens graphql playground -c ./lenses
  lens graphql serve -c ./lenses --listen 4400 --max-calls 50
`,
  skill: `Usage: lens skill

Print an agent skill (SKILL.md with frontmatter) that teaches an agent how to
call lenses, handle outcomes, and author new lens documents with observe and
eval. No catalog or browser needed.

Example:
  mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md

Options:
  --help, -h              Show this help
`,
};

function requireCatalogs(catalogs: string[] | undefined): string[] {
  if (!catalogs || catalogs.length === 0) {
    throw new Error("a lens catalog is required; pass --catalog <source>");
  }
  return catalogs;
}

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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      params: { type: "string" },
      catalog: { type: "string", short: "c", multiple: true },
      help: { type: "boolean", short: "h" },
      port: { type: "string", short: "p" },
      request: { type: "string" },
      html: { type: "boolean" },
      lax: { type: "boolean" },
      "allow-writes": { type: "boolean" },
      input: { type: "string" },
      out: { type: "string", short: "o" },
      listen: { type: "string" },
      "max-calls": { type: "string" },
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

  if (command === "skill") {
    process.stdout.write(skillMarkdown);
    return;
  }

  if (command === "eval") {
    if (operands.length !== 1) throw new Error("eval requires one <expression>");
    const params = values.params === undefined ? {} : JSON.parse(values.params);
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new Error("params must be a JSON object");
    }
    const source = values.input
      ? await readFile(values.input, "utf8")
      : process.stdin.isTTY
        ? undefined
        : await readStdin();
    const data = source === undefined || source.trim() === "" ? undefined : JSON.parse(source);
    const result = await evaluate(operands[0], data, params);
    if (result === undefined) {
      process.stderr.write("expression produced no result\n");
    }
    process.stdout.write(`${JSON.stringify(result ?? null, null, 2)}\n`);
    return;
  }

  if (command === "gen") {
    const [target, ...catalogOperands] = operands;
    if (target !== "ts-sdk") throw new Error('gen requires a target; supported targets: "ts-sdk"');
    const catalogs = catalogOperands.length > 0 ? catalogOperands : requireCatalogs(values.catalog);
    const specs: LensSpec[] = await new LensStore(catalogs).load();
    const source = generateTsSdk(specs);
    if (values.out) await writeFile(values.out, source, "utf8");
    else process.stdout.write(source);
    return;
  }

  if (command === "update") {
    const updates = await new LensStore(requireCatalogs(values.catalog)).update();
    process.stdout.write(`${JSON.stringify({ sources: updates }, null, 2)}\n`);
    return;
  }

  const port = numberOption(values.port, "port");
  const waitMs = numberOption(values["wait-ms"], "wait-ms");
  const timeoutMs = numberOption(values["timeout-ms"], "timeout-ms");
  const startedAt = Date.now();
  const log = values.verbose
    ? (message: string) => process.stderr.write(`[lens +${Date.now() - startedAt}ms] ${message}\n`)
    : undefined;
  // status and observe are catalog-independent; the rest resolve lenses by name.
  const catalog =
    command === "status" || command === "observe" || command === "broker"
      ? values.catalog
      : requireCatalogs(values.catalog);
  const client = createLensClient({ catalog, port, log });

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
        output = await client.call({
          lens,
          params,
          timeoutMs,
          strict: !values.lax,
          allowWrites: values["allow-writes"],
        });
        break;
      }
      case "schema":
        output = await client.schema(operands[0]);
        break;
      case "observe": {
        const [target] = operands;
        const request =
          values.request === undefined
            ? undefined
            : /^\d+$/.test(values.request)
              ? Number(values.request)
              : values.request;
        output = await client.observe({ target, waitMs, timeoutMs, html: values.html, request });
        break;
      }
      case "status":
        if (waitMs !== undefined) await client.waitForConnection(waitMs);
        output = await client.status();
        break;
      case "graphql": {
        const [action] = operands;
        if (action !== "playground" && action !== "serve") {
          throw new Error('graphql requires an action: "playground" or "serve"');
        }
        await serveGraphql({
          catalogs: requireCatalogs(values.catalog),
          client,
          listen: numberOption(values.listen, "listen"),
          maxCalls: numberOption(values["max-calls"], "max-calls") ?? 25,
          playground: action === "playground",
          log: log ?? (() => {}),
        });
        return;
      }
      case "broker": {
        const [action] = operands;
        if (action === "shutdown") {
          output = await client.shutdownBroker(timeoutMs);
          break;
        }
        if (action !== "status" && action !== "release" && action !== "acquire") {
          throw new Error(
            'broker requires an action: "status", "release", "acquire", or "shutdown"'
          );
        }
        output = await client.broker(action, timeoutMs);
        break;
      }
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
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
