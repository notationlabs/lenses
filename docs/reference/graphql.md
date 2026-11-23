# @notation/lenses/graphql

Notation Lenses exposes `@notation/lenses/graphql` to compile lens catalogs into executable GraphQL schemas. Install `graphql` v17 alongside `@notation/lenses` to build schemas and execute metered operations in TypeScript.

```sh [Terminal]
npm install @notation/lenses graphql@17
```

## Exported API

`@notation/lenses/graphql` exports two factory functions and three TypeScript interfaces for compiling and running schemas.

```ts [@notation/lenses/graphql]
export interface GraphQLLensClient {
  call(input: {
    lens: string;
    params?: Record<string, unknown>;
    strict?: boolean;
  }): Promise<LensResult & { cached?: boolean }>;
}

export interface LensCallRecord {
  lens: string;
  params: Record<string, unknown>;
  resolver?: string;
  cached: boolean;
  ttlSeconds?: number;
  observed?: string;
  durationMs: number;
}

export interface GraphQLLensContext {
  client: GraphQLLensClient;
  budget: { remaining: number };
  calls: LensCallRecord[];
}

export function buildLensSchema(specs: LensSpec[]): GraphQLSchema;
export function createContext(
  client: GraphQLLensClient,
  maxCalls: number
): GraphQLLensContext;
```

| Export | Role |
| :--- | :--- |
| `buildLensSchema` | Compiles validated `LensSpec` documents into an executable `GraphQLSchema` |
| `createContext` | Creates a fresh per-operation `budget` and `calls` log |
| `GraphQLLensClient` | Structural client contract satisfied by `LensClient` |
| `LensCallRecord` | Per-call timing, resolver, cache, and URL metadata |
| `GraphQLLensContext` | Execution context object passed to `graphql` |

```ts [src/graphql.ts]
import { createLensClient, LensStore } from "@notation/lenses";
import { buildLensSchema, createContext } from "@notation/lenses/graphql";
import { graphql } from "graphql";

await using client = createLensClient({ catalog: "./examples" });
const schema = buildLensSchema(await new LensStore("./examples").load());

const context = createContext(client, 25);
const result = await graphql({
  schema,
  source: "{ hn { top(page: 1) { stories(first: 3) { title } } } }",
  contextValue: context,
});
```

Create a new context via `createContext` for every GraphQL execution so each operation starts with its own call budget and empty `calls` array.

## Schema mapping rules

Lenses transforms each lens document's name, `params`, `returns`, and `$defs` declarations into GraphQL fields and types.

| Lens construct | GraphQL mapping |
| :--- | :--- |
| Scoped multi-segment name | Stripped scope grouped as `Query.<group>.<lens>` |
| Single-segment name | Placed directly on `Query.<lens>` |
| String scalar type | Mapped to `String` |
| Integer scalar type | Mapped to `Int` |
| Number scalar type | Mapped to `Float` |
| Boolean scalar type | Mapped to `Boolean` |
| Null or file type | Mapped to custom `JSON` scalar |
| Parameter enum list | Compiled to `GraphQLEnumType` with upper snake-case keys |
| Array returns field | Adds optional `first: Int` slicing argument |
| Lens reference field | Strips trailing `_url`, `_link`, or `_href` unless colliding |
| Named definition | Compiled to memoized type `<LensPascal><DefPascal>` |

For parameter defaults, scalar values become GraphQL argument `defaultValue` entries, while `{$lens, field}` parameter defaults stay optional in GraphQL so `LensClient` resolves them at runtime. Enum arguments preserve the original declared string values when passed to the lens despite uppercasing GraphQL enum member names.

When a `$lens` reference field ends with a URL, link, or href suffix, `buildLensSchema` strips that suffix unless a sibling field already uses the shortened name.

Reference fields resolve lazily only when selected, and `first` slices array rows before nested calls run.

Named types from `$defs` memoize per lens so self-referential structures such as nested comment threads compile without recursion errors. When two generated object or enum names collide, Lenses appends a numeric suffix starting at `2`.

## Call budget and error handling

Every top-level query field and selected `$lens` reference decrements `context.budget.remaining` by 1 before calling `context.client.call` with strict mode disabled. Cached hits still count toward the operation budget.

| Execution event | GraphQL behavior |
| :--- | :--- |
| Budget reaches `0` | Throws `GraphQLError` with `extensions.code` set to `"LENS_BUDGET_EXHAUSTED"` |
| Lens returns `outcome` | Throws `GraphQLError` carrying `lens`, `outcome`, and `hint` in `extensions` |
| Lens returns `error` | Throws `GraphQLError` carrying `lens` in `extensions` |

The failing GraphQL field resolves to `null` while unaffected sibling fields continue executing. Because GraphQL resolvers never pass `allowWrites`, calling a write lens fails with `writes_not_allowed` surfaced as a `GraphQLError`.

## CLI HTTP server behavior

`lens graphql playground` and `lens graphql serve` run a local HTTP server wrapping `buildLensSchema` and `createContext`. See [GraphQL Guide](../core/graphql.md) for query walkthroughs and [CLI Reference](./cli.md) for server flags.

| Server rule | Behavior |
| :--- | :--- |
| Bind address | Listens only on `127.0.0.1` |
| Port selection | Scans `4381` to `4400` unless `--listen` specifies a port |
| Origin check | Rejects cross-origin `POST /graphql` requests with HTTP `403` |
| Response extensions | Attaches `context.calls` under `extensions.lenses` |

Requests without an `Origin` header or originating from localhost or 127.0.0.1 on the bound port succeed. `playground` serves GraphiQL at `/`, while `serve` returns HTTP 404 for GET requests to the root path.
