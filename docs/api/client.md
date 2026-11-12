# TypeScript Client

`@notation/lenses` calls lenses from Node.js.

The package is ESM only and needs Node.js 22.12.0 or later:

```sh
npm install @notation/lenses
```

Print the Hacker News front page:

```ts
import { createLensClient } from "@notation/lenses";

await using lenses = createLensClient({ catalog: "./examples" });

const result = await lenses.call({ lens: "hn/top" });

if (result.kind === "value") {
  console.log(result.value);
} else {
  console.error(result.kind, result.kind === "error" ? result.message : result.hint);
}
```

`await using` closes the client when the block ends. `./examples` is the `examples` directory of the lenses repository.

## createLensClient

```ts
function createLensClient(options: LensClientOptions): LensClient;
```

The function is synchronous. The client connects to the broker on the first call that needs the browser.

```ts
interface LensClientOptions {
  catalog?: string | string[];
  port?: number;
  transport?: LensTransport;
  log?: (message: string) => void;
  browserProfile?: string;
  playwrightExtensionToken?: string;
  parameterDefaults?: Record<string, Record<string, string | number | boolean>>;
}
```

`catalog` is one source or a list of sources, searched in order. A source is a directory path, such as `./examples`, or a git reference, such as `git:github.com/owner/repo#ref/subdir`. [Catalogs](../manual/catalogs.md) explains sources.

`port` is the local broker's port, `4319` by default. Each port has its own broker. `transport` replaces the local broker with your own `LensTransport`, so you cannot pass both.

The client runs each lens through the transport's `call` method. It passes the resolved spec, the resolved parameters, and an options object:

```ts
call(
  spec: LensSpec,
  params: Record<string, unknown>,
  options?: LensTransportCallOptions
): Promise<LensTransportResult>;

type LensTransportCallOptions = {
  timeoutMs?: number;
  authLeaseMs?: number;
  allowWrites?: boolean;
  noCache?: boolean;
  outDir?: string;
  recording?: { path: string; callId: string; lens: string };
  tab?: string;
};
```

The options carry the matching [`LensCall`](#the-lenscall-object) fields, except that `outDir` is an absolute path. `recording` is set only while a [recording](#record) is active.

`log` receives progress messages. By default the client logs nothing.

`browserProfile` picks a Chrome profile, such as `"Profile 4"`. `playwrightExtensionToken` is the token the broker uses to connect to Chrome through the Playwright Extension. Both apply only when this client starts the broker; a running broker keeps its own settings.

`parameterDefaults` sets default parameters per lens, keyed by lens-name glob:

```ts
createLensClient({
  catalog: "./examples",
  parameterDefaults: { "@djgrant/hn/*": { page: 1 } },
});
```

These override the `params` defaults in the [config file](./configuration.md). Parameters passed to a call override both.

## Naming a lens

A `lens` string is usually a name the client looks up in your catalogs: the scoped name `"@djgrant/hn/top"` or the shortname `"hn/top"`. It can also be a path ending in `.json`, or an `https://` URL to a lens file.

## Calling lenses

### call

```ts
call(input: LensCall): Promise<LensCallResult>
```

The result's `kind` is `"value"`, `"outcome"` or `"error"`; [Calling Lenses](../manual/calling.md) explains each. Bad parameters and failed reads come back as error results, but **an unknown lens name throws**. Use `call` to handle outcomes, such as a signed-out page, or to read error details.

### value

```ts
value(input: LensCall): Promise<unknown>
```

`value` returns only the data. It throws `LensOutcomeError` for an outcome and `LensResultError` for an error, so anything other than data stops your program.

Ask for the second page:

```ts
const top = await lenses.value({ lens: "hn/top", params: { page: 2 } });
```

### The LensCall object

```ts
interface LensCall {
  lens: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  // time to wait for a person to sign in after needs_auth; 0 turns waiting off
  authLeaseMs?: number;
  // consent to run a lens that changes things, such as chatgpt/send
  allowWrites?: boolean;
  noCache?: boolean;
  // directory a file lens writes into; required for file lenses
  outDir?: string;
  // false turns shape mismatches into warnings; default true
  strict?: boolean;
  // tab id from an earlier result, to run in the same tab
  tab?: string;
}
```

Each field matches a `lens call` flag: `allowWrites: true` is `--allow-writes`, and `strict: false` is `--lax`. [Calling Lenses](../manual/calling.md) explains them.

### The result

```ts
type LensCallResult = LensResult & {
  cached?: boolean;
  warnings?: ValidationIssue[];
  lens?: string;
  callId?: string;
};

type LensResult =
  | { kind: "value"; value: unknown; resolver: string; partial?: boolean;
      observed?: string; performed?: true; tab?: string }
  | { kind: "outcome"; name: string; value: unknown; hint?: string;
      resolver: string; performed?: true; tab?: string }
  | { kind: "error"; message: string; issues?: ValidationIssue[]; code?: string;
      step?: number; performed?: true; mutation?: MutationState; tab?: string };

interface ValidationIssue {
  path: string; // JSON pointer, such as "/stories/3/score"
  message: string;
  missing?: boolean;
}
```

`warnings` lists shape mismatches when you call with `strict: false`.

## Error classes

```ts
class LensOutcomeError extends Error {
  readonly outcome: string; // outcome name, such as "needs_auth"
  readonly value: unknown;
  readonly hint?: string;
}

class LensResultError extends Error {
  readonly issues?: ValidationIssue[];
  readonly lens?: string;
  readonly callId?: string;
}
```

Catch a signed-out page:

```ts
import { LensOutcomeError } from "@notation/lenses";

try {
  await lenses.value({ lens: "claude/usage" });
} catch (error) {
  if (error instanceof LensOutcomeError && error.outcome === "needs_auth") {
    console.log(error.hint);
  }
}
```

`LensResultError` does not carry the error's `code` or `mutation`. Use `call` when you need them.

## Reading catalogs

These methods read lens files and never connect to the broker.

```ts
list(): Promise<LensSummary[]>
```

`list` returns a summary of each lens. `exceptions` holds the outcome names the lens can return:

```ts
interface LensSummary {
  name: string;      // "@djgrant/hn/top"
  shortname: string; // "hn/top"
  url: string;
  description?: string;
  params: LensSpec["params"];
  effects: LensSpec["effects"];
  exceptions: string[];
  warnings?: string[];
}
```

```ts
schema(lens: string): Promise<Record<string, unknown>>
```

`schema` returns a JSON Schema for the lens's data, the same one `lens schema` prints.

```ts
update(): Promise<{ source: string; lenses: number }[]>
```

`update` fetches the latest commits for git sources, reloads every source, and returns the lens count of each. It does not change directory sources.

## Debugging

### record

```ts
record(options?: true | { path: string }): RecordingHandle
```

`record` saves screenshots of this client's calls until you stop it, in a run directory under `./screenshots` or under `path`:

```ts
const recording = lenses.record({ path: "./artifacts" });
await lenses.call({ lens: "hn/top" });
recording.stop();
```

`recording.path` is the run directory's absolute path.

### observe

```ts
observe(input: LensObservation): Promise<LensResult>
```

`observe` loads a page and returns a text snapshot and the page's network requests. Lens authors use it, through `lens observe`, to find what to read:

```ts
interface LensObservation {
  target?: string; // URL to load
  tab?: string;    // or an open tab
  waitMs?: number;
  timeoutMs?: number;
  html?: boolean;
  request?: number | string; // request index or URL substring
}
```

## Controlling the broker

`call` starts and connects to the broker as needed, so most programs do not need these.

```ts
status(): Promise<{ connected: boolean; lease: "held" | "released" | "disconnected"; port: number; /* … */ }>
waitForConnection(timeoutMs?: number): Promise<boolean>
broker(action: "release" | "acquire" | "status", timeoutMs?: number): Promise<{ connected: boolean; lease: string }>
shutdownBroker(timeoutMs?: number): Promise<{ shuttingDown: boolean }>
```

`status` reports whether the broker is connected to Chrome. `waitForConnection` waits up to `timeoutMs` (default 5000) for it.

`broker` controls the lease, the broker's hold on Chrome's debugging connection. `"release"` frees it for other tools, and `"acquire"` takes it back. `shutdownBroker` asks the broker to finish its current calls and exit, so the next client starts a fresh one.

`close(): Promise<void>` closes this client's connection but does not stop the broker. `await using` calls it.

## Subpath exports

- `@notation/lenses/core` works on lens files without a browser. It includes `validateSpec`, which checks a lens file, and `generateTsSdk`, which writes the typed SDK below.
- `@notation/lenses/graphql` exports `buildLensSchema(specs)`, which builds a GraphQL schema from lens files, and `createContext(client, maxCalls)`. See [GraphQL](../manual/graphql.md).
- `@notation/lenses/mcp` exports `createLensMcpServer(client)`, an MCP server that offers the client's lenses as tools. See [Agents](../manual/agents.md).
- `@notation/lenses/page-stamp` exports `pageFunctionsStamp()`, a hash of the code the broker runs inside pages.

## Generated SDK

The base client types every `value` as `unknown`. Generate a typed SDK from your catalogs with the [CLI](./cli.md):

```sh
lens gen ts-sdk ./examples -o src/lenses.gen.ts
```

Its `createLensClient` returns the same client, with `call` and `value` typed from each lens file's parameters and return shape:

```ts
import { createLensClient } from "./lenses.gen.js";

await using lenses = createLensClient({ catalog: "./examples" });

const top = await lenses.value({ lens: "hn/top" });
top.stories[0].title; // string
```

TypeScript rejects an unknown lens name or a wrong parameter type. The module also exports `Lenses`, which maps each lens name to `{ params; result }`.

**The typed `call` and `value` do not accept `allowWrites` or `tab`.** To call a lens that changes things, such as `chatgpt/send`, cast to the base `LensClient`. The object is the same, so the cast is safe:

```ts
import type { LensClient } from "@notation/lenses";

await (lenses as unknown as LensClient).call({
  lens: "chatgpt/send",
  params: { message: "Hello" },
  allowWrites: true,
});
```
