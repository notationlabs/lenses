# Lenses

A lens is a one-file declarative document that turns a webpage into a typed function.
The call runs in your own browser through a Chrome extension, so it can use your
existing signed-in session without exporting cookies or running scraping infrastructure.

Applications use the TypeScript client directly. A CLI and an MCP server expose the
same client without reimplementing lens loading, caching, validation, or browser transport.

Here is `@djgrant/claude/usage`, trimmed:

```jsonc
{
  "name": "@djgrant/claude/usage",
  "url": "https://claude.ai/settings/usage",
  "returns": {
    "type": "object",
    "fields": { "plan": "string", "limits": { "type": "array", "items": { "name": "string", "percent": "string" } } }
  },
  "outcomes": { "needs_auth": { "$lens": "@djgrant/claude/login" } },
  "resolve": [
    { "kind": "intercept",
      "request": "GET https://claude.ai/api/organizations/*/usage*",
      "detect": { "needs_auth": "status = 401 or status = 403" },
      "map": { "limits": "[limits.{ 'name': kind, 'percent': $string(percent) & '%' }]" } },
    { "kind": "dom", "post": "…" },
    { "kind": "llm", "prompt": "Return {plan, limits} from this usage settings page…" }
  ]
}
```

## Setup

```sh
pnpm install
pnpm build
```

Load the browser extension by opening `chrome://extensions`, enabling **Developer
mode**, choosing **Load unpacked**, and selecting `extensions/chrome/dist`.

The extension connects to the persistent local broker on port 4319. The first client
starts the broker automatically; CLI, MCP, and library clients then share the same
extension connection.

## TypeScript client

`@djgrant/lens-client` is the primary API:

```ts
import { createLensClient } from "@djgrant/lens-client";

await using lenses = await createLensClient({ directory: "./lenses" });

const available = await lenses.list();
const result = await lenses.call({
  lens: "claude/usage",
});
```

The client owns lens discovery, reference resolution, parameter validation, TTL caching, and the
local broker connection. `call` returns a `value`, a structured `outcome`, or an `error`.
An `agent_extract` outcome contains the page snapshot and lens prompt for the consumer's
own model; the client does not select or call an LLM provider.

Use `observe` to inspect the JSON requests and text snapshot needed to author a lens:

```ts
const observation = await lenses.observe({
  target: "https://github.com/notifications",
  waitMs: 4_000,
});
```

## CLI

`@djgrant/lens-cli` installs the `lens` command. It prints JSON to stdout and uses a
non-zero exit status for command and lens errors. Pass `--verbose` to write timestamped
broker and call diagnostics to stderr without contaminating the JSON output. Every
command has focused help, for example `lens call --help`.

```sh
lens list --directory ./lenses
lens call hn/top
lens call claude/usage
lens call hn/item --params '{"id":"42","p":2,"limit":10}' --verbose
lens observe https://github.com/notifications --wait-ms 4000
lens status --wait-ms 5000
```

Call parameters are validated against the lens document. Each parameter becomes a
JSONata variable such as `$limit`. URL templates and resolver expressions use the same
parameter set.

Each command connects to the persistent broker and disconnects when it finishes. The
broker stays connected to Chrome between commands and shares successful cached results
for each lens's declared TTL. Calls fail immediately when the browser extension is not
connected. Use `lens status --wait-ms <number>` when a script should wait for it.

For repository development, Bun resolves the workspace packages directly to their
TypeScript source, so the CLI does not need a build first:

```sh
bun packages/cli/src/index.ts call hn/top
```

## MCP

`@djgrant/lens-mcp` is a thin stdio adapter over `@djgrant/lens-client`. Configure it
with the lens directory and built entry point:

```json
{
  "mcpServers": {
    "lenses": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": { "LENS_DIR": "/absolute/path/to/lenses" }
    }
  }
}
```

It exposes `lens_list`, `lens_call`, `lens_observe`, and `broker_status`. The adapter
only validates tool inputs and formats tool results; all behavior lives in the client.

## Resolution

The engine walks resolver tiers in order. Each tier produces a result, contributes
fields, detects a named outcome, or misses and falls through.

- **intercept** reads JSON responses already fetched by the page.
- **dom** extracts fields from the rendered document with CSS selectors.
- **llm** returns a page snapshot and extraction prompt to the caller.

When `returns` is an object, fields accumulate across tiers. The engine stops when all
declared fields are present, so each tier only needs to supply its part of the result.

Lens `map` and `detect` bodies are JSONata expressions. They cannot reach the network or
DOM. Lenses observe what a page already does and cannot fire requests or act on the page.

## Architecture

```text
application ─┐
lens CLI ────┼─► @djgrant/lens-client ── WebSocket ──► Chrome extension
lens MCP ────┘           │                                    │
                         └──── @djgrant/lens resolver engine ◄─┘
```

The extension background code separates transport, tab lifecycle, intercepted response
state, and browser operations. The service worker only assembles those modules.

## Lens spec reference

A lens is a JSON file in `lenses/` or at an HTTP URL.

- `name` — globally scoped name such as `@djgrant/hn/item`. The local catalogue also
  resolves the shortname `hn/item`.
- `url` — canonical page URL. Named holes are filled from declared parameters:

  ```jsonc
  "url": "https://x.com/{handle}/status/{id}"
  ```

- `params` — inputs available to URL expansion and every resolver expression. A bare
  type is required; an object may provide a default:

  ```jsonc
  "params": {
    "handle": "string",
    "page": { "type": "integer", "default": 1 }
  }
  ```

- `returns` — result shape. A field can contain a callable lens reference:

  ```jsonc
  "next_page": {
    "$lens": "@djgrant/hn/top",
    "params": { "p": "$number($substringAfter(next_page, 'p='))" }
  }
  ```

  The parameter values are JSONata expressions evaluated against the containing result.
  Materialised results carry the lens name and evaluated parameters needed for a follow-up
  call.

- `outcomes` — named non-happy paths, optionally carrying the lens that resolves them.
- `effects` — `{ "reads": [...], "writes": [...], "idempotent": true, "cache": 60 }`.
- `loadTimeoutMs` — optional page-load timeout; the default is 30 seconds.
- `resolve` — ordered intercept, DOM, and LLM resolver definitions.

An intercept resolver can capture one request or declare named `sources` that join several
responses. A DOM resolver declares an optional repeating `item` selector and named fields.
An LLM resolver declares the extraction prompt and optional snapshot limit.

Run `pok lens validate` to validate every document under `lenses/`.

## Packages

| path | package | responsibility |
|---|---|---|
| `packages/lens` | `@djgrant/lens` | Specs, validation, JSONata, resolver engine |
| `packages/client` | `@djgrant/lens-client` | Lens orchestration and persistent browser broker |
| `packages/cli` | `@djgrant/lens-cli` | JSON command-line adapter |
| `packages/mcp` | `@djgrant/lens-mcp` | stdio MCP adapter |
| `extensions/chrome` | private | Browser interception and extraction |
| `lenses` | — | Bundled lens documents |

Planned work lives in [ROADMAP.md](./ROADMAP.md).
