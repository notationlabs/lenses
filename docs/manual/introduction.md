# Introduction

Lenses turns web pages into functions that return JSON. It runs them in your own Chrome, so a lens can read any page you are signed in to.

```sh
lens call hn/top -c git:github.com/notationlabs/lenses#main/examples
```

```json
{
  "kind": "value",
  "value": {
    "stories": [
      {
        "title": "My YC app: Dropbox - Throw away your USB drive",
        "score": "104 points",
        "item_url": { "$lens": "@djgrant/hn/item", "params": { "id": "8863" } }
      }
    ],
    "next_page": { "$lens": "@djgrant/hn/top", "params": { "page": 2 } }
  },
  "resolver": "dom"
}
```

`item_url` and `next_page` are not URLs. Each one names another lens and its parameters, so you follow links by making another call.

You can call a lens from the `lens` CLI, from TypeScript, from an AI agent over MCP, or through a GraphQL server.

## A lens is a JSON file

`examples/hn.top.json` declares the page, the parameters, the result shape and how to read the data:

```jsonc
{
  "name": "@djgrant/hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": { "page": { "type": "integer", "default": 1 } },
  "returns": { "type": "object", "fields": { "stories": { "type": "array", "items": { "title": "string", … } } } },
  "resolve": [{ "kind": "dom", "item": ".athing", "fields": { "title": { "selector": ".titleline > a" }, … } }]
}
```

The client checks every result against `returns`. If the page changes and the data no longer fits, you get an error that lists the mismatches instead of bad data.

## Signed-in pages

`claude/usage` reads your plan and usage limits from claude.ai. Lenses does not ask for your password, cookies or an API token. A background process called the [broker](./broker.md) makes the requests from inside your Chrome, so claude.ai sees your normal session. A lens file cannot read your cookies.

When you are signed out, the call returns an **outcome** instead of a value:

```json
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": { "$lens": "@djgrant/claude/login" },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
}
```

The lens author named this state in advance, so your code can handle it instead of parsing an error.

## Fallbacks when a site changes

A lens can list several ways to get its data, cheapest first. Lenses tries the next one only if the earlier ones fail. `claude/usage` has four:

```jsonc
"resolve": [
  { "kind": "http", "credentials": true, … },  // ← call claude.ai's API with your cookies; no tab opens
  { "kind": "intercept", … },                   // ← open the page and read the JSON it fetches
  { "kind": "dom", … },                         // ← read the rendered HTML with CSS selectors
  { "kind": "llm", "prompt": "…" }              // ← hand the page text to the caller's AI model
]
```

While claude.ai's API works, the call never opens a tab. If the API changes, the call still works through the page. [Resolvers](../api/resolvers.md) describes each kind.

## Next steps

- [Installation](./installation.md) connects Lenses to Chrome.
- [Quick Start](./quickstart.md) walks through your first calls.
- [Writing a Lens](./authoring.md) builds `hn/top` from scratch.
