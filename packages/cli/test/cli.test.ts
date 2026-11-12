import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { LensClient, LensClientOptions } from "@notation/lenses-client";
import type { GraphQLServeOptions } from "../src/graphql-server.js";
import { run, type CliDeps } from "../src/index.js";
import { skillMarkdown } from "../src/skill.js";

const examples = fileURLToPath(new URL("../../../examples", import.meta.url));

function fakeClient() {
  return {
    list: vi.fn(async () => [{ name: "@x/site/lens" }]),
    call: vi.fn(async (_call: Record<string, unknown>): Promise<unknown> => ({ kind: "value", value: 1 })),
    schema: vi.fn(async (_lens: string) => ({ type: "object" })),
    observe: vi.fn(async (_options: Record<string, unknown>) => ({ text: "page" })),
    broker: vi.fn(async (_action: string, _timeoutMs?: number) => ({ ok: true })),
    shutdownBroker: vi.fn(async (_timeoutMs?: number) => ({ ok: true, shutdown: true })),
    close: vi.fn(async () => {}),
  };
}

interface Harness {
  stdin?: string;
  tty?: boolean;
}

async function cli(argv: string[], harness: Harness = {}) {
  let stdout = "";
  let stderr = "";
  const client = fakeClient();
  const clientOptions: LensClientOptions[] = [];
  const graphql: GraphQLServeOptions[] = [];
  const stdin = Object.assign(Readable.from(harness.stdin === undefined ? [] : [harness.stdin]), {
    isTTY: harness.tty ?? false,
  });
  const deps: CliDeps = {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    stdin,
    createLensClient: (options) => {
      clientOptions.push(options);
      return client as unknown as LensClient;
    },
    serveGraphql: async (options) => {
      graphql.push(options);
    },
  };
  const code = await run(argv, deps);
  return {
    code,
    stdout,
    get stderr() {
      return stderr;
    },
    client,
    clientOptions,
    graphql,
    json: () => JSON.parse(stdout),
  };
}

const commands = ["list", "call", "schema", "gen", "eval", "observe", "broker", "update", "graphql", "skill"];

describe("help", () => {
  it("prints the global help with no arguments", async () => {
    const result = await cli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage:\n  lens list/);
    expect(result.stdout).toContain("Run lens <command> --help");
    expect(result.clientOptions).toEqual([]);
  });

  it.each(["--help", "-h"])("prints the global help for %s", async (flag) => {
    const result = await cli([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage:\n/);
  });

  it.each(commands)("prints the help for %s", async (command) => {
    for (const flag of ["--help", "-h"]) {
      const result = await cli([command, flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(new RegExp(`^Usage: lens ${command}\\b`));
      expect(result.stderr).toBe("");
      expect(result.clientOptions).toEqual([]);
    }
  });

  it("prints command help before validating operands or options", async () => {
    const result = await cli(["call", "--help", "--port", "nope"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: lens call/);
  });

  it("falls back to the global help for an unknown command with --help", async () => {
    const result = await cli(["nope", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage:\n/);
  });
});

describe("argument errors", () => {
  it("rejects an unknown command", async () => {
    const result = await cli(["nope"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe('unknown command "nope"\n');
  });

  it("rejects an unknown option", async () => {
    const result = await cli(["list", "--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--bogus/);
    expect(result.clientOptions).toEqual([]);
  });

  it("rejects a string option given without a value", async () => {
    const result = await cli(["list", "-c"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/-c/);
  });

  it.each([
    [["call", "-c", "x"], "call requires <lens>\n"],
    [["call", "a", "b", "-c", "x"], "call accepts one <lens> operand\n"],
    [["schema", "-c", "x"], "schema requires one <lens>\n"],
    [["schema", "a", "b", "-c", "x"], "schema requires one <lens>\n"],
    [["observe"], "observe requires <target>, --tab <id>, or both\n"],
    [["eval"], "eval requires one <expression>\n"],
    [["eval", "1", "2"], "eval requires one <expression>\n"],
    [["gen", "-c", "x"], 'gen requires a target; supported targets: "ts-sdk"\n'],
    [["gen", "py-sdk", "-c", "x"], 'gen requires a target; supported targets: "ts-sdk"\n'],
    [["broker", "status"], 'broker requires an action: "release", "acquire", or "shutdown"\n'],
    [["broker"], 'broker requires an action: "release", "acquire", or "shutdown"\n'],
    [["graphql", "-c", "x"], 'graphql requires an action: "playground" or "serve"\n'],
    [["graphql", "query", "-c", "x"], 'graphql requires an action: "playground" or "serve"\n'],
  ])("%j fails with a usage error", async (argv, message) => {
    const result = await cli(argv);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(message);
  });

  it.each([
    ["list"],
    ["call", "hn/top"],
    ["schema", "hn/top"],
    ["gen", "ts-sdk"],
    ["update"],
    ["graphql", "serve"],
  ])("%s requires a catalog", async (...argv) => {
    const result = await cli(argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("a lens catalog is required; pass --catalog <source>\n");
    expect(result.clientOptions).toEqual([]);
  });

  it.each([
    [["--port", "abc"], "port must be an integer between 1 and 65535\n"],
    [["--port", "1.5"], "port must be an integer between 1 and 65535\n"],
    [["--port=-1"], "port must be an integer between 1 and 65535\n"],
    [["--port", "0"], "port must be an integer between 1 and 65535\n"],
    [["--port", "65536"], "port must be an integer between 1 and 65535\n"],
    [["--timeout-ms", "soon"], "timeout-ms must be a non-negative integer\n"],
    [["--wait-ms=-5"], "wait-ms must be a non-negative integer\n"],
    [["--auth-lease-ms", "x"], "auth-lease-ms must be a non-negative integer\n"],
  ])("rejects numeric option %j", async (option, message) => {
    const result = await cli(["call", "hn/top", "-c", "./lenses", ...option]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(message);
  });

  it("reads a negative number after a space as an ambiguous option", async () => {
    const result = await cli(["call", "hn/top", "-c", "./lenses", "--timeout-ms", "-1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ambiguous/);
  });

  it.each([
    [["--listen", "x"], "listen must be a non-negative integer\n"],
    [["--max-calls=-1"], "max-calls must be a non-negative integer\n"],
  ])("rejects graphql numeric option %j", async (option, message) => {
    const result = await cli(["graphql", "serve", "-c", "./lenses", ...option]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(message);
    expect(result.graphql).toEqual([]);
  });
});

describe("lens skill", () => {
  it("prints the skill markdown", async () => {
    const result = await cli(["skill"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(skillMarkdown);
    expect(result.stdout).toMatch(/^---\n/);
  });
});

describe("lens list", () => {
  it("prints the lenses as JSON and closes the client", async () => {
    const result = await cli(["list", "-c", "./a", "--catalog", "git:github.com/o/r"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify({ lenses: [{ name: "@x/site/lens" }] }, null, 2)}\n`);
    expect(result.clientOptions).toHaveLength(1);
    expect(result.clientOptions[0]).toMatchObject({ catalog: ["./a", "git:github.com/o/r"] });
    expect(result.client.close).toHaveBeenCalledOnce();
  });

  it("passes broker options to the client", async () => {
    const result = await cli([
      "list",
      "-c",
      "./a",
      "-p",
      "4400",
      "--profile",
      "Profile 4",
      "--playwright-extension-token",
      "tok",
    ]);
    expect(result.code).toBe(0);
    expect(result.clientOptions[0]).toMatchObject({
      port: 4400,
      browserProfile: "Profile 4",
      playwrightExtensionToken: "tok",
      log: undefined,
    });
  });

  it("writes timestamped diagnostics to stderr with --verbose", async () => {
    const result = await cli(["list", "-c", "./a", "-v"]);
    result.clientOptions[0].log?.("hello");
    expect(result.stderr).toMatch(/^\[lens \+\d+ms\] hello\n$/);
  });

  it("reports a client failure on stderr and still closes the client", async () => {
    let stderr = "";
    const client = fakeClient();
    client.list.mockRejectedValueOnce(new Error("broker unreachable"));
    const code = await run(["list", "-c", "./a"], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => (stderr += chunk) },
      createLensClient: () => client as unknown as LensClient,
    });
    expect(code).toBe(1);
    expect(stderr).toBe("broker unreachable\n");
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("lens call", () => {
  it("calls the lens with defaults and prints the result", async () => {
    const result = await cli(["call", "hn/top", "-c", "./a"]);
    expect(result.code).toBe(0);
    expect(result.json()).toEqual({ kind: "value", value: 1 });
    expect(result.client.call).toHaveBeenCalledWith({
      lens: "hn/top",
      params: undefined,
      timeoutMs: undefined,
      authLeaseMs: 0,
      strict: true,
      allowWrites: undefined,
      noCache: undefined,
    });
    expect(result.client.close).toHaveBeenCalledOnce();
  });

  it("parses --params as a JSON object", async () => {
    const result = await cli(["call", "hn/item", "-c", "./a", "--params", '{"id":"42","page":2}']);
    expect(result.code).toBe(0);
    expect(result.client.call.mock.calls[0][0]).toMatchObject({ params: { id: "42", page: 2 } });
  });

  it.each(["[1]", "null", '"text"', "3"])("rejects --params %s", async (params) => {
    const result = await cli(["call", "hn/item", "-c", "./a", "--params", params]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("params must be a JSON object\n");
    expect(result.client.call).not.toHaveBeenCalled();
    expect(result.client.close).toHaveBeenCalledOnce();
  });

  it("rejects --params that is not JSON", async () => {
    const result = await cli(["call", "hn/item", "-c", "./a", "--params", "{id:1}"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/JSON/);
    expect(result.client.call).not.toHaveBeenCalled();
  });

  it("passes every call option through", async () => {
    const result = await cli([
      "call",
      "chatgpt/send",
      "-c",
      "./a",
      "--timeout-ms",
      "5000",
      "--auth-lease-ms",
      "30000",
      "--lax",
      "--allow-writes",
      "--no-cache",
      "--out-dir",
      "/tmp/out",
      "--tab",
      "t1",
    ]);
    expect(result.code).toBe(0);
    expect(result.client.call).toHaveBeenCalledWith({
      lens: "chatgpt/send",
      params: undefined,
      timeoutMs: 5000,
      authLeaseMs: 30000,
      strict: false,
      allowWrites: true,
      noCache: true,
      outDir: "/tmp/out",
      tab: "t1",
    });
  });

  it("waits two minutes for sign-in when stdin is a TTY", async () => {
    const result = await cli(["call", "hn/top", "-c", "./a"], { tty: true });
    expect(result.client.call.mock.calls[0][0]).toMatchObject({ authLeaseMs: 120_000 });
  });

  it("accepts an explicit zero sign-in wait on a TTY", async () => {
    const result = await cli(["call", "hn/top", "-c", "./a", "--auth-lease-ms", "0"], { tty: true });
    expect(result.client.call.mock.calls[0][0]).toMatchObject({ authLeaseMs: 0 });
  });

  it("prints an error outcome on stdout and exits 1", async () => {
    let stdout = "";
    const client = fakeClient();
    client.call.mockResolvedValueOnce({ kind: "error", code: "tab_closed", message: "gone" });
    const code = await run(["call", "hn/top", "-c", "./a"], {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: () => true },
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      createLensClient: () => client as unknown as LensClient,
    });
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ kind: "error", code: "tab_closed", message: "gone" });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([{ kind: "needs_auth" }, { kind: "value", value: null }])(
    "exits 0 for a %j outcome",
    async (outcome) => {
      const client = fakeClient();
      client.call.mockResolvedValueOnce(outcome);
      const code = await run(["call", "hn/top", "-c", "./a"], {
        stdout: { write: () => true },
        stdin: Object.assign(Readable.from([]), { isTTY: false }),
        createLensClient: () => client as unknown as LensClient,
      });
      expect(code).toBe(0);
    }
  );
});

describe("lens schema", () => {
  it("prints the client's schema for the lens", async () => {
    const result = await cli(["schema", "hn/top", "-c", "./a"]);
    expect(result.code).toBe(0);
    expect(result.client.schema).toHaveBeenCalledWith("hn/top");
    expect(result.json()).toEqual({ type: "object" });
  });
});

describe("lens observe", () => {
  it("observes a target without a catalog", async () => {
    const result = await cli(["observe", "https://example.com", "--wait-ms", "100", "--timeout-ms", "2000", "--html"]);
    expect(result.code).toBe(0);
    expect(result.clientOptions[0].catalog).toBeUndefined();
    expect(result.client.observe).toHaveBeenCalledWith({
      target: "https://example.com",
      tab: undefined,
      waitMs: 100,
      timeoutMs: 2000,
      html: true,
      request: undefined,
    });
    expect(result.json()).toEqual({ text: "page" });
  });

  it("observes a tab without a target", async () => {
    const result = await cli(["observe", "--tab", "t1"]);
    expect(result.code).toBe(0);
    expect(result.client.observe.mock.calls[0][0]).toMatchObject({ target: undefined, tab: "t1" });
  });

  it("passes the catalog through when one is given", async () => {
    const result = await cli(["observe", "https://example.com", "-c", "./a"]);
    expect(result.clientOptions[0].catalog).toEqual(["./a"]);
  });

  it.each([
    ["3", 3],
    ["api/v2/items", "api/v2/items"],
    ["3a", "3a"],
  ])("reads --request %s as %j", async (request, expected) => {
    const result = await cli(["observe", "https://example.com", "--request", request]);
    expect(result.client.observe.mock.calls[0][0]).toMatchObject({ request: expected });
  });
});

describe("lens broker", () => {
  it.each(["release", "acquire"] as const)("sends %s to the broker", async (action) => {
    const result = await cli(["broker", action, "--timeout-ms", "1000"]);
    expect(result.code).toBe(0);
    expect(result.clientOptions[0].catalog).toBeUndefined();
    expect(result.client.broker).toHaveBeenCalledWith(action, 1000);
    expect(result.json()).toEqual({ ok: true });
  });

  it("shuts the broker down", async () => {
    const result = await cli(["broker", "shutdown"]);
    expect(result.code).toBe(0);
    expect(result.client.shutdownBroker).toHaveBeenCalledWith(undefined);
    expect(result.json()).toEqual({ ok: true, shutdown: true });
  });
});

describe("lens graphql", () => {
  it("serves the playground with default options and prints nothing", async () => {
    const result = await cli(["graphql", "playground", "-c", "./a"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.graphql).toHaveLength(1);
    expect(result.graphql[0]).toMatchObject({
      catalogs: ["./a"],
      listen: undefined,
      maxCalls: 25,
      playground: true,
    });
    expect(result.graphql[0].client).toBe(result.client);
    expect(result.client.close).toHaveBeenCalledOnce();
  });

  it("serves the endpoint with --listen and --max-calls", async () => {
    const result = await cli(["graphql", "serve", "-c", "./a", "--listen", "4400", "--max-calls", "50"]);
    expect(result.graphql[0]).toMatchObject({ listen: 4400, maxCalls: 50, playground: false });
  });
});

describe("lens eval", () => {
  async function inputFile(contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lens-cli-test-"));
    const path = join(dir, "input.json");
    await writeFile(path, contents, "utf8");
    return path;
  }

  it("binds --input as $res.body", async () => {
    const path = await inputFile('{"items":[{"t":"a"},{"t":"b"}]}');
    const result = await cli(["eval", "$res.body.items.t", "--input", path]);
    expect(result.code).toBe(0);
    expect(result.json()).toEqual(["a", "b"]);
    expect(result.clientOptions).toEqual([]);
  });

  it("binds piped stdin as $res.body", async () => {
    const result = await cli(["eval", "$res.body.n + 1"], { stdin: '{"n":41}' });
    expect(result.json()).toBe(42);
  });

  it("binds the JSON to the variable named by --as", async () => {
    const result = await cli(["eval", "--as", "value", "$value.n * 2"], { stdin: '{"n":21}' });
    expect(result.json()).toBe(42);
  });

  it("binds --params as $params", async () => {
    const result = await cli(["eval", "$params.id", "--params", '{"id":"7"}']);
    expect(result.code).toBe(0);
    expect(result.json()).toBe("7");
  });

  it("does not read stdin when it is a TTY", async () => {
    const result = await cli(["eval", "$exists($res.body)"], { stdin: '{"n":1}', tty: true });
    expect(result.json()).toBe(false);
  });

  it("treats empty input as no input", async () => {
    const result = await cli(["eval", "$exists($res.body)"], { stdin: "  \n" });
    expect(result.json()).toBe(false);
  });

  it("prints null and a stderr note when the expression has no result", async () => {
    const result = await cli(["eval", "$res.body.missing"], { stdin: "{}" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("null\n");
    expect(result.stderr).toBe("expression produced no result\n");
  });

  it.each(["params", "1x", "a-b"])("rejects --as %s", async (name) => {
    const result = await cli(["eval", "1", "--as", name]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('--as must name a variable other than params, e.g. "value" or "item"\n');
  });

  it("rejects --params that is not an object", async () => {
    const result = await cli(["eval", "1", "--params", "[]"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("params must be a JSON object\n");
  });

  it("rejects input that is not JSON", async () => {
    const result = await cli(["eval", "1"], { stdin: "not json" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/JSON/);
  });

  it("reports an expression error", async () => {
    const result = await cli(["eval", "$res.body.("], { stdin: "{}" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("reports a missing --input file", async () => {
    const result = await cli(["eval", "1", "--input", join(tmpdir(), "lens-cli-missing.json")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ENOENT/);
  });
});

describe("lens gen", () => {
  it("writes a TypeScript SDK for catalog operands to stdout", async () => {
    const result = await cli(["gen", "ts-sdk", examples]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"@djgrant/hn/top"');
    expect(result.stdout).toContain("createLensClient");
    expect(result.clientOptions).toEqual([]);
  });

  it("falls back to --catalog and writes to --out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lens-cli-test-"));
    const out = join(dir, "lenses.gen.ts");
    const result = await cli(["gen", "ts-sdk", "-c", examples, "-o", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const source = await readFile(out, "utf8");
    expect(source).toContain('"@djgrant/hn/top"');
    expect(source).toBe((await cli(["gen", "ts-sdk", examples])).stdout);
  });
});

describe("lens update", () => {
  it("reports the lens count per source", async () => {
    const result = await cli(["update", "-c", examples]);
    expect(result.code).toBe(0);
    const { sources } = result.json();
    expect(sources).toHaveLength(1);
    expect(sources[0].lenses).toBeGreaterThan(0);
  });
});
