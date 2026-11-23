# @notation/lenses

Notation Lenses provides the `@notation/lenses` ESM package for Node.js 22.12.0 and later. Use it to load catalogs, execute lenses against the local browser broker, record screenshot runs, and inspect pages programmatically.

```sh [Terminal]
npm install @notation/lenses
```

## Client creation and lifecycle

`createLensClient(options)` constructs a `LensClient` synchronously without opening a network connection. Transport-using methods bind the broker lazily on first use, while catalog methods read files locally.

```ts [@notation/lenses]
export interface LensClientOptions {
  catalog?: string | string[];
  port?: number;
  transport?: LensTransport;
  log?: (message: string) => void;
  browserProfile?: string;
  playwrightExtensionToken?: string;
  parameterDefaults?: Record<string, Record<string, string | number | boolean>>;
}
```

| Option | Behavior |
| :--- | :--- |
| `catalog` | Single catalog source or ordered list of sources |
| `port` | Local broker WebSocket port |
| `transport` | Custom `LensTransport` implementation replacing the local broker |
| `log` | Callback receiving diagnostic log strings |
| `browserProfile` | Chrome profile directory passed when spawning a broker |
| `playwrightExtensionToken` | Playwright Extension token passed when spawning a broker |
| `parameterDefaults` | Default parameter values keyed by canonical lens-name glob |

`port` defaults to `4319` and cannot be combined with `transport`. Passing an invalid port or empty catalog string throws immediately.

```ts [src/client.ts]
import { createLensClient } from "@notation/lenses";

await using client = createLensClient({
  catalog: ["./examples"],
  parameterDefaults: { "@djgrant/hn/*": { page: 1 } },
});

const result = await client.call({ lens: "hn/top" });
```

Call `client.close()` or bind the client with `await using` to invoke `[Symbol.asyncDispose]()`. Closing disconnects the WebSocket transport without stopping the background broker, and a closed or failed transport resets so the next transport call rebinds.

## Client methods

Lenses splits `LensClient` methods between local catalog operations and broker-backed browser operations.

```ts [@notation/lenses]
export class LensClient {
  list(): Promise<LensSummary[]>;
  schema(lens: string): Promise<Record<string, unknown>>;
  update(): Promise<CatalogUpdate[]>;
  call(input: LensCall): Promise<LensCallResult>;
  value(input: LensCall): Promise<unknown>;
  record(options?: true | RecordingOptions): RecordingHandle;
  observe(input: LensObservation): Promise<LensResult>;
  status(): Promise<{
    connected: boolean;
    lease: "held" | "released" | "disconnected";
    broker: string;
    port: number;
    backend?: string;
    capabilities: string[];
    backends: BrokerBackendStatus[];
    diagnostics?: BrokerDiagnostics;
    advice?: string;
  }>;
  broker(action: BrokerControlAction, timeoutMs?: number): Promise<{
    connected: boolean;
    lease: BrokerLease;
  }>;
  shutdownBroker(timeoutMs?: number): Promise<{ shuttingDown: boolean }>;
  waitForConnection(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

| Method | Behavior |
| :--- | :--- |
| `list` | Validates and returns `LensSummary` records without starting the broker |
| `schema` | Compiles draft 2020-12 JSON Schema from `returns` without starting the broker |
| `update` | Fetches git catalog remotes and returns updated lens counts |
| `call` | Runs a lens and returns the full discriminated result |
| `value` | Runs a lens and returns its value or throws on outcomes and errors |
| `record` | Starts a deduplicated PNG screenshot run across subsequent calls |
| `observe` | Captures a page text snapshot, optional HTML, and network request index |
| `status` | Returns broker connection, lease state, active backend, and diagnostics |
| `broker` | Executes `release`, `acquire`, `status`, or `shutdown` lease actions |
| `shutdownBroker` | Drains active work and shuts down the broker daemon |
| `waitForConnection` | Waits for Chrome attachment up to `timeoutMs` |

`waitForConnection` defaults to 5000 milliseconds. `record` creates `./screenshots` runs by default, or uses `{ path }` when passed, and throws if a recording is already active on that client.

```ts [@notation/lenses]
export interface LensObservation {
  target?: string;
  tab?: string;
  waitMs?: number;
  timeoutMs?: number;
  html?: boolean;
  request?: number | string;
}
```

`LensObservation` loads `target` or attaches to an existing `tab` to inspect network traffic and DOM snapshots. Calling `observe` without either returns an error result.

## Call options and results

Every call passed to `call` or `value` accepts a `LensCall` configuration object:

```ts [@notation/lenses]
export interface LensCall {
  lens: string;
  params?: Record<string, unknown>;
  tab?: string;
  timeoutMs?: number;
  authLeaseMs?: number;
  noCache?: boolean;
  strict?: boolean;
  allowWrites?: boolean;
  outDir?: string;
}
```

| Field | Behavior |
| :--- | :--- |
| `lens` | Scoped name, shortname, `.json` path, or HTTP URL |
| `params` | Parameter object merged on top of configured defaults |
| `tab` | Existing broker tab ID to reuse for this call |
| `timeoutMs` | Total execution timeout in milliseconds |
| `authLeaseMs` | Sign-in wait window after `needs_auth` in milliseconds |
| `noCache` | Bypasses cached values and skips caching this result |
| `strict` | Validates `returns` schema and errors on mismatch |
| `allowWrites` | Permits `perform` steps and mutating HTTP methods |
| `outDir` | Destination directory required by file-returning lenses |

`strict` defaults to true and `allowWrites` defaults to false.

Setting `strict` to false moves schema mismatches into `warnings`, and `outDir` resolves relative paths against the working directory before reaching the transport.

`LensCallResult` extends `LensResult` with caching, validation, and diagnostic fields:

```ts [@notation/lenses]
export type LensCallResult = LensResult & {
  cached?: boolean;
  warnings?: ValidationIssue[];
  lens?: string;
  callId?: string;
};

export interface MutationState {
  performStarted: boolean;
  lastAcknowledgedStep?: number;
  submissionMayHaveHappened: boolean;
  performed: "no" | "yes" | "unknown";
}

export type LensResult =
  | {
      kind: "value";
      value: unknown;
      resolver: Resolver["kind"] | "reconciled";
      partial?: boolean;
      observed?: string;
      performed?: true;
      tab?: string;
    }
  | {
      kind: "outcome";
      name: string;
      value: unknown;
      hint?: string;
      resolver: Resolver["kind"];
      performed?: true;
      tab?: string;
    }
  | {
      kind: "error";
      message: string;
      issues?: ValidationIssue[];
      code?: string;
      step?: number;
      performed?: true;
      mutation?: MutationState;
      tab?: string;
    };
```

| Field | Presence |
| :--- | :--- |
| `value` | Resolved output payload on `kind: "value"` results |
| `outcome` | Named outcome string `name`, payload `value`, and optional `hint` |
| `error` | Error `message`, optional `code`, schema `issues`, and `step` |
| `mutation` | Write-progress state attached after ambiguous non-idempotent timeouts |

When `mutation` is present, its `performed` property reports whether write steps ran alongside step acknowledgement flags.

## Error classes

Calling `value` unwraps `kind: "value"` results and throws typed errors for outcomes and failures. Unknown lens names passed to either `call` or `value` throw directly instead of returning a result object.

```ts [@notation/lenses]
export class LensOutcomeError extends Error {
  readonly outcome: string;
  readonly value: unknown;
  readonly hint?: string;
}

export class LensResultError extends Error {
  readonly issues?: ValidationIssue[];
  readonly lens?: string;
  readonly callId?: string;
}
```

| Class | Thrown for |
| :--- | :--- |
| `LensOutcomeError` | `kind: "outcome"` results such as `needs_auth` or `agent_extract` |
| `LensResultError` | `kind: "error"` results from validation or execution failures |

`LensResultError` omits error codes and mutation state. Use `call` instead of `value` whenever control flow needs those fields.

## Helper exports

The root package exports catalog, parameter, and transport helpers alongside `createLensClient`:

| Export | Purpose |
| :--- | :--- |
| `LensStore` | Loads ordered catalog sources and resolves lens names, files, and URLs |
| `parseCatalogSource` | Parses directory paths, `file:` references, and `git:` catalog strings |
| `applyParameterDefaults` | Applies glob-matched defaults from least specific to most specific |
| `mergeParameterDefaults` | Merges user config parameter defaults with runtime overrides |
| `scanLensFiles` | Walks a directory tree and returns valid standalone lens documents |
| `applyCatalogSettings` | Merges `catalog.json` helpers, params, and scopes into a spec |
| `parsePort` | Validates integer TCP ports between `1` and `65535` |
| `BrowserBridge` | Default WebSocket transport connecting clients to the local broker |

## Generated SDK helpers

Running `lens gen ts-sdk` emits a standalone TypeScript module typing `call` and `value` against your catalog. See [CLI Reference](./cli.md) for command flags and [TypeScript SDK](../core/typescript.md) for usage examples.

| Generated symbol | Role |
| :--- | :--- |
| `LensRef` | Typed `{$lens, params?}` cross-lens reference object |
| `Lenses` | Interface mapping scoped names and shortnames to `params` and `result` |
| `LensName` | String literal union of all generated keys in `Lenses` |
| `createLensClient` | Wrapper returning a `LensClient` narrowed to `LensName` |

The generated module also re-exports both error classes and narrows `LensCallResult` per lens. Cast the generated client to the base `LensClient` type when invoking write lenses or passing options omitted by the typed wrapper.

## Subpath exports

`@notation/lenses` exposes five ESM subpath entry points:

| Subpath | Contents |
| :--- | :--- |
| `@notation/lenses` | Client factory, `LensClient`, errors, catalog helpers, and bridge transport |
| `@notation/lenses/core` | Spec validation, JSONata evaluation, JSON Schema derivation, and SDK generator |
| `@notation/lenses/graphql` | `buildLensSchema`, `createContext`, and GraphQL execution types |
| `@notation/lenses/mcp` | `createLensMcpServer` factory for embedding the MCP tools |
| `@notation/lenses/page-stamp` | `pageFunctionsStamp` helper hashing the injected page script source |
