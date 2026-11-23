# GraphQL

Notation Lenses compiles your catalog into a GraphQL schema with `lens graphql`. One GraphQL query can fetch a list page and follow nested `$lens` links into detail pages on demand.

## Starting the playground or server

Start an interactive GraphiQL editor at `/` backed by `POST /graphql`:

```sh [Terminal]
lens graphql playground -c ./examples
# graphql playground at http://localhost:4381 (budget: 25 calls/query)
```

For scripts and applications without the GraphiQL UI, run `lens graphql serve` to expose `POST /graphql` alone. Both commands bind `127.0.0.1` only and scan upward from port `4381` up to 20 ports until finding a free port.

Pass `--listen` to require a specific port instead of scanning.

## Running queries and inspecting extensions

Query Hacker News stories and follow each story's `item` field to fetch its comments:

```graphql [Query]
{
  hn {
    top(page: 1) {
      stories(first: 3) {
        title
        score
        item {
          story {
            title
            url
          }
          comments(first: 2) {
            author
            text
          }
        }
      }
    }
  }
}
```

This operation runs four lens calls: one `hn/top` call plus one `hn/item` call for each of the three stories. Every response attaches an `extensions.lenses` array recording each executed call:

| Field | Meaning |
| :--- | :--- |
| `lens` | Canonical scoped lens name called |
| `params` | Resolved parameter object sent to the lens |
| `resolver` | Resolver tier that produced the value |
| `cached` | Boolean indicating whether a cached result was served |
| `ttlSeconds` | Declared cache TTL in seconds when configured |
| `observed` | Landed page URL where data was read |
| `durationMs` | Execution duration in milliseconds |

## Mapping catalogs to the GraphQL schema

Lenses strips the scope prefix from each lens name and groups fields under `Query.<group>.<lens>`, so `@djgrant/hn/top` becomes `Query.hn.top`. Single-segment names sit directly on `Query`.

Lens `params` map to GraphQL field arguments, carrying scalar defaults as GraphQL `defaultValue` and string `enum` lists as GraphQL enum types. Return contracts under `returns` compile to GraphQL object and list types.

## Lazy links and the first argument

A `$lens` reference in `returns` compiles into a nested object field of the target lens's type, stripping trailing URL or link suffixes so `item_url` becomes `item`.

The server resolves `$lens` fields lazily and calls the target lens only when your query selects fields inside that reference. Selecting only `stories { title }` makes a single `hn/top` call.

Every array field accepts an optional `first` integer argument that slices the returned array.

Using `stories(first: 3)` caps nested `item` calls at three, while `comments(first: 2)` trims data already returned by `hn/item`.

## Call budget

Because each resolved reference opens or reads a page, queries run under a per-operation call budget defaulting to `25` calls. Cached calls still count against this budget; change the limit with `--max-calls`.

When a query exhausts its budget, remaining reference fields resolve to `null` and return a `GraphQLError` with `LENS_BUDGET_EXHAUSTED`:

```json [GraphQL error]
{
  "message": "lens call budget exhausted before calling @djgrant/hn/item; select fewer ref fields, lower `first`, or raise the budget",
  "path": ["hn", "top", "stories", 24, "item"],
  "extensions": {
    "lens": "@djgrant/hn/item",
    "code": "LENS_BUDGET_EXHAUSTED"
  }
}
```

## Sign-in outcomes and write protection

Named outcomes such as `needs_auth` and lens execution errors cannot appear inside GraphQL `data`, so Lenses surfaces them as a `GraphQLError` on the failing field:

```json [Outcome error]
{
  "message": "@djgrant/claude/usage returned outcome: needs_auth",
  "path": ["claude", "usage"],
  "extensions": {
    "lens": "@djgrant/claude/usage",
    "outcome": "needs_auth",
    "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
  }
}
```

The affected field resolves to `null` while the rest of the query continues. GraphQL execution never grants write consent, so calling any write lens fails with `writes_not_allowed`.

## Localhost binding and origin checks

GraphQL queries drive your signed-in browser session, so exposing the endpoint on a network interface or to arbitrary websites would leak account access.

The server listens only on `127.0.0.1` and checks the `Origin` header on `POST /graphql`. Same-origin localhost requests on the bound port and requests without an origin header succeed, while cross-origin browser requests fail with HTTP 403.

## Programmatic schema usage

Install `graphql` v17 alongside `@notation/lenses` to run GraphQL queries from TypeScript via `@notation/lenses/graphql`:

```sh [Terminal]
npm install @notation/lenses graphql@17
```

Build the schema with `buildLensSchema` and create a fresh `createContext` budget per operation:

```ts [src/graphql.ts]
import { createLensClient, LensStore } from "@notation/lenses";
import { buildLensSchema, createContext } from "@notation/lenses/graphql";
import { graphql } from "graphql";

const client = createLensClient({ catalog: "./examples" });
const schema = buildLensSchema(await new LensStore("./examples").load());

const context = createContext(client, 25);
const result = await graphql({
  schema,
  source: "{ hn { top { stories(first: 3) { title } } } }",
  contextValue: context,
});
```

After execution, `context.calls` holds the array of call records exposed by the CLI under `extensions.lenses`. See [GraphQL Reference](../reference/graphql.md) for exported types and schema mapping details.
