# Lenses

A lens is a JSON document that turns a webpage, or the API behind it, into a typed function. A call to a lens runs with your existing signed-in browser session. You do not export cookies or run scraping infrastructure.

You can call lenses from TypeScript, from the `lens` CLI, or from an MCP server.

## Example lens

This simplified lens returns plan details and usage limits from claude.ai:

```jsonc
{
  "name": "@djgrant/claude/usage",
  "url": "https://claude.ai/settings/usage",
  "returns": {
    "type": "object",
    "fields": { "plan": "string", "limits": { "type": "array", "items": { "name": "string", "percent": "string" } } }
  },
  "resolve": [
    { "kind": "http", "credentials": true, "sources": { "orgs": "…", "usage": "…" }, "map": "…" },
    { "kind": "intercept", "request": { "url": "https://claude.ai/api/organizations/*/usage*" }, "map": "…" },
    { "kind": "dom", "fields": "…" },
    { "kind": "llm", "prompt": "Return {plan, limits} from this usage settings page…" }
  ]
}
```

`returns` declares the result type. `resolve` lists ways to get the result, from cheapest to most expensive. The engine tries each one in order until the declared fields are filled:

| Resolver | What it does |
|---|---|
| `http` | Sends requests directly. With `credentials: true` the requests carry your browser cookies. |
| `intercept` | Reads JSON responses that the page fetches when it loads. |
| `dom` | Reads fields from the rendered page with CSS selectors. |
| `llm` | Returns a page snapshot and a prompt for the caller's own model. |

## Setup

Lenses needs Node.js 22.12 and a Chrome browser with the Playwright extension.

```sh
npm install @notation/lenses
```

Lenses controls Chrome in one of two ways:

1. Through [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm). This is the preferred option. Set `PLAYWRIGHT_MCP_EXTENSION_TOKEN` to skip repeated approval.
2. Through Chrome remote debugging, as a fallback. Enable it at `chrome://inspect/#remote-debugging`.

Calls go through a local broker process on port 4319.

## TypeScript

```ts
import { createLensClient } from "@notation/lenses";

await using lenses = await createLensClient({
  catalog: ["git:github.com/notationlabs/lenses#main/examples"],
});

const result = await lenses.call({ lens: "claude/usage" });
```

A catalog is a directory or git repository of lens documents. `call` returns one of three things:

- a `value` that matches the lens's `returns` type
- a named `outcome`, such as `needs_auth`
- an `error`

`lens gen ts-sdk` generates a client with typed parameters and results for each lens in a catalog.

## CLI

The CLI prints JSON to stdout.

```sh
CATALOG=git:github.com/notationlabs/lenses#main/examples
lens list -c $CATALOG
lens call hn/top -c $CATALOG
lens call chatgpt/send -c $CATALOG --params '{"message":"hello"}' --allow-writes
lens observe https://github.com/notifications --html
```

Lenses that change data, such as sending a message, run only when the caller passes `--allow-writes`. 

`lens observe` shows the requests and page text that an agent needs to write a new lens. 

Run `lens <command> --help` for each command's options.

## MCP

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

## Documentation

- [Quick start](docs/manual/quickstart.md)
- [Writing lenses](docs/manual/write-lenses.md)
- [Lens document reference](docs/api/lens-document.md)
- [Resolvers](docs/api/resolvers.md)
- [CLI reference](docs/api/cli.md)
- [Broker](docs/manual/broker.md)

