# Notation Lenses

Notation Lenses turns a webpage, or the API behind it, into a typed function. Calls run in your own signed-in Chrome session, so you do not export cookies or manage scraping infrastructure.

You can call Lenses from TypeScript, from the `lens` CLI, over GraphQL, or from an MCP server.

## Example lens

This lens reads stories from Hacker News and defines fallback tiers from DOM extraction down to an agent snapshot:

```jsonc
{
  "name": "@djgrant/hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": { "page": { "type": "integer", "default": 1 } },
  "returns": {
    "type": "object",
    "fields": {
      "stories": { "type": "array", "items": { "title": "string", "url": "string" } },
      "next_page": { "$lens": "@djgrant/hn/top", "params": { "page": "$params.page + 1" } }
    }
  },
  "effects": { "reads": ["news.ycombinator.com"], "writes": [], "cache": 60 },
  "resolve": [
    {
      "kind": "dom",
      "item": "tr.athing",
      "fields": {
        "title": { "selector": ".titleline > a" },
        "url": { "selector": ".titleline > a", "attr": "href" }
      }
    },
    { "kind": "llm", "prompt": "Return stories from this Hacker News page." }
  ]
}
```

`returns` declares the output type. `resolve` lists strategies in order from cheapest to most expensive, stopping as soon as all declared fields are satisfied:

| Resolver | What it does |
| --- | --- |
| `http` | Sends requests directly, optionally carrying browser cookies with `credentials: true` |
| `intercept` | Reads JSON responses the page fetches while loading or performing steps |
| `dom` | Extracts fields from rendered markup using CSS selectors |
| `llm` | Returns a text snapshot and prompt to the caller's own model |

## Setup

Lenses requires Node.js 22.12 or later and Google Chrome with [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm).

Install the CLI globally or add it to a Node.js project:

```sh
npm install -g @notation/lenses
```

Set `PLAYWRIGHT_MCP_EXTENSION_TOKEN` or save `playwrightExtensionToken` in `~/.config/lenses/config.json` to skip repeated connection prompts. Calls route through a local broker listening on `127.0.0.1` port `4319`.

## TypeScript

Install `@notation/lenses` in your project and generate a typed client from any local or `git:` catalog:

```sh
npm install @notation/lenses
lens gen ts-sdk git:github.com/notationlabs/lenses#main/examples -o src/lenses.gen.ts
```

Call lenses with `value()` to unwrap results or `call()` to inspect `value`, `outcome`, and `error` discriminants:

```ts
import { createLensClient } from "./lenses.gen.js";

await using lenses = createLensClient({
  catalog: ["git:github.com/notationlabs/lenses#main/examples"],
});

const usage = await lenses.value({ lens: "claude/usage" });
usage.plan; // string
```

Re-run `lens gen ts-sdk` whenever lens contracts change.

## CLI

Most catalog commands inspect JSON output on stdout:

```sh
CATALOG=git:github.com/notationlabs/lenses#main/examples
lens list -c $CATALOG
lens call hn/top -c $CATALOG
lens call chatgpt/send -c $CATALOG --params '{"message":"hello"}' --allow-writes
lens schema hn/top -c $CATALOG
lens observe https://github.com/notifications --html
lens graphql playground -c $CATALOG
```

Write lenses require `--allow-writes`, file lenses write into `--out-dir`, and `lens update` refreshes cached git catalogs.

Run `lens <command> --help` for full options, or `lens skill` to print the agent authoring guide.

## MCP and GraphQL

The `lens-mcp` binary exposes `lens_list`, `lens_call`, and `lens_observe` over stdio:

```json
{
  "mcpServers": {
    "lenses": {
      "command": "lens-mcp",
      "env": { "LENS_CATALOG": "git:github.com/notationlabs/lenses#main/examples" }
    }
  }
}
```

Use `lens graphql playground` or `@notation/lenses/graphql` to query a catalog with nested `$lens` links enforced by a per-query call budget.

## Documentation

Read the full guides in [docs/core/introduction.md](docs/core/introduction.md) and schemas in [docs/reference/lens-document.md](docs/reference/lens-document.md), or configure browser profiles and defaults in `~/.config/lenses/config.json`.
