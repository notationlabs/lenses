# GraphQL

`lens graphql` serves your catalog as a GraphQL schema. One query can read the Hacker News front page and the comments on each story; the server follows the `item_url` links and makes the calls for you.

## Starting the playground

Start GraphiQL, an in-browser GraphQL editor:

```sh
lens graphql playground -c ./examples
# graphql playground at http://localhost:4381 (budget: 25 calls/query)
```

If port 4381 is in use, the server takes the next free port. `--listen` sets the port. For programs, `lens graphql serve` serves `POST /graphql` without GraphiQL.

## Running a query

Read the front page and open the first three stories:

```graphql
{
  hn {
    top(page: 1) {
      stories(first: 3) {
        title
        score
        item {                      # <- one hn/item call per story
          story { title url }
          comments(first: 2) { author text }
        }
      }
    }
  }
}
```

This makes four lens calls in your browser: one to `hn/top` and one to `hn/item` per story. The response's `extensions.lenses` array records each call's lens name, `params`, `cached` flag and `durationMs`.

## How the catalog becomes a schema

Lenses are grouped by site, with the scope dropped: `@djgrant/hn/top` becomes `hn { top }` on the root `Query` type.

Parameters become arguments, so `hn/top` gets `top(page: Int = 1)`. The schema requires no arguments, but leaving out one the lens needs, such as the `id` of `hn/item`, makes the lens call fail with an error in the response. The fields in `returns` become GraphQL types.

A follow-up call becomes a field holding the other lens's result. `item_url`, a `$lens` reference to `hn/item`, becomes `item`, typed as the `hn/item` result; the `_url` suffix goes because the field holds the item, not a pointer. **The server calls `hn/item` only when your query selects fields inside `item`.** Selecting only `stories { title }` makes one call.

Every array field takes `first`, which keeps the first few elements. On `stories`, `first: 3` limits the query to three `hn/item` calls. On `comments`, `first: 2` saves no calls: the comments arrive inside the `hn/item` value.

## The call budget

Each `item` opens a real page, so without `first` the query above would open all 30 stories. The server limits each query to 25 lens calls, counting cached ones; `--max-calls` changes the limit. Past the budget, each field that needs a call returns `null` with:

```json
{
  "message": "lens call budget exhausted before calling @djgrant/hn/item; select fewer ref fields, lower `first`, or raise the budget",
  "path": ["hn", "top", "stories", 24, "item"],
  "extensions": { "lens": "@djgrant/hn/item", "code": "LENS_BUDGET_EXHAUSTED" }
}
```

The first 24 stories still have their `item`.

## Sign-in outcomes

An [outcome](./calling.md), such as `needs_auth` when you are signed out, has no place in GraphQL `data`, so the server reports it as an error on that field. Query `{ claude { usage { … } } }` while signed out of claude.ai:

```json
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

The field becomes `null` and the rest of the query runs. Lens errors appear the same way.

The server never consents to writes: `chatgpt/send` is in the schema, but its calls fail with `writes_not_allowed`. [Write and File Lenses](./write-lenses.md) explains write consent.

## Why the server only listens locally

A query drives your browser, which is signed in to your accounts, so anything that can reach the server can read them. The server listens on `127.0.0.1` only and refuses web pages on other origins with `cross-origin requests are not allowed`. GraphiQL, `curl` and scripts work, because they come from the server's own origin or send no `Origin` header.

## Using the schema from code

`@djgrant/lenses/graphql` exports the schema the CLI serves. It needs `graphql` 17:

```sh
npm install @djgrant/lenses graphql@17
```

Run a query from a script:

```ts
import { createLensClient, LensStore } from "@djgrant/lenses";
import { buildLensSchema, createContext } from "@djgrant/lenses/graphql";
import { graphql } from "graphql";

const client = createLensClient({ catalog: "./examples" });
const schema = buildLensSchema(await new LensStore("./examples").load());

const context = createContext(client, 25); // <- call budget for this query
const result = await graphql({
  schema,
  source: "{ hn { top { stories(first: 3) { title } } } }",
  contextValue: context,
});
```

A context holds one query's budget and calls, so create one per query. Afterwards, `context.calls` holds the records the CLI puts in `extensions.lenses`. The [Client API](../api/client.md) page lists the types.
