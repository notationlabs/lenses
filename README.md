# Lenses

A lens is a one-file declarative document that turns a webpage into a typed function.
The call runs in your own browser through a Chrome extension, so it can use your
existing signed-in session without exporting cookies or running scraping infrastructure.

Applications use the TypeScript client directly. A CLI and an MCP server expose the
same client without reimplementing lens loading, caching, validation, or browser transport.

Here is `claude/usage`, trimmed:

```jsonc
{
  "lens": "claude/usage",
  "accepts": ["https://claude.ai/settings/usage*"],
  "returns": {
    "type": "object",
    "fields": { "plan": "string", "limits": { "type": "array", "items": { "name": "string", "percent": "string" } } }
  },
  "outcomes": { "needs_auth": { "$lens": "claude/login@v1" } },
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

The extension discovers clients by probing local ports 4319–4329.

## TypeScript client

`@djgrant/lens-client` is the primary API:

```ts
import { createLensClient } from "@djgrant/lens-client";

await using lenses = await createLensClient({ directory: "./lenses" });

const available = await lenses.list();
const result = await lenses.call({
  lens: "claude/usage",
  target: "https://claude.ai/settings/usage",
});
```

The client owns lens discovery, reference resolution, URL checks, TTL caching, and the
local extension bridge. `call` returns a `value`, a structured `outcome`, or an `error`.
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
bridge and call diagnostics to stderr without contaminating the JSON output. Every
command has focused help, for example `lens call --help`.

```sh
lens list --directory ./lenses
lens call hn/top
lens call claude/usage
lens call hn/item 'https://news.ycombinator.com/item?id=42' --args '{"p":2,"limit":10}' --verbose
lens observe https://github.com/notifications --wait-ms 4000
lens status --wait-ms 5000
```

Call args are a JSON object whose keys become JSONata variables such as `$limit`.
Variables captured from target URL holes are supplied automatically, and explicit args
with the same name take precedence.

A lens may declare a `defaultTarget`. Callers can omit the target for those lenses;
parameterized lenses such as `hn/item` still require a concrete URL.

Each command starts a client for the duration of that invocation and then closes its
extension bridge. A cold call may wait for the Chrome extension's discovery alarm;
verbose output distinguishes that wait from page loading and resolver execution.

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

It exposes `lens_list`, `lens_call`, `lens_observe`, and `bridge_status`. The adapter
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

- `lens` — namespaced name such as `site/operation`.
- `version` — positive integer, bumped when the result contract breaks.
- `accepts` — target URL patterns. Named holes become JSONata variables:

  ```jsonc
  "accepts": ["https://x.com/{handle}/status/{id}"]
  ```

- `returns` — result shape. A field can contain a callable lens reference:

  ```jsonc
  "next_page": { "$lens": "hn/top@v1" }
  ```

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
| `packages/client` | `@djgrant/lens-client` | Lens orchestration and extension bridge |
| `packages/cli` | `@djgrant/lens-cli` | JSON command-line adapter |
| `packages/mcp` | `@djgrant/lens-mcp` | stdio MCP adapter |
| `extensions/chrome` | private | Browser interception and extraction |
| `lenses` | — | Bundled lens documents |

Planned work lives in [ROADMAP.md](./ROADMAP.md).
