# Lenses

A lens is a one-file, declarative document that turns a webpage into a typed function
an agent can call.

The call runs in your own browser. A headless Chrome extension executes the lens
against a background tab, in your existing session, and returns typed data over MCP
to whichever agent asked. You are already logged in, so a lens can read what you can
read – there are no cookies to export and no scraping infrastructure to run.

A lens declares `resolve` tiers, tried cheapest first: **intercept** reads the JSON
responses the page is already fetching, **dom** extracts from the rendered page with
CSS selectors, and **llm** hands the page snapshot back to the calling agent as the
last resort. A tier that finds nothing falls through to the next.

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
      "map": { "limits": "limits.{ 'name': kind, 'percent': $string(percent) & '%' }" } },
    { "kind": "dom", "post": "…" },
    { "kind": "llm", "prompt": "Return {plan, limits} from this usage settings page…" }
  ]
}
```

With that file loaded, *"how much Claude usage do I have left?"* becomes one
`lens_call` and one typed reply: the intercept tier reads the usage API response the
page fetched anyway, the dom tier fills in `plan`, and the llm tier never runs.

## Setup

```sh
pnpm install
pnpm build   # bundles the Chrome extension — the only build step; everything else runs from source
```

1. **Load the extension:** Chrome → `chrome://extensions` → Developer mode →
   *Load unpacked* → `extensions/chrome/dist`.

2. **Register `lens-host` with your agent.** `lens-host` is a stdio MCP server – the
   client you register it with spawns it per session (under [bun](https://bun.sh),
   straight from source), so nothing runs as a daemon. For Claude Code:

   ```sh
   claude mcp add lens-host --env LENS_DIR="$PWD/lenses" -- bun "$PWD/packages/host/src/index.ts"
   ```

3. Ask your agent to try `lens_call` on the Hacker News front page. The extension
   finds running hosts by probing ports 4319–4329 on page loads.

## How a call resolves

The engine walks the tiers in order. Each tier produces the result, contributes some
of its fields, detects a named outcome (`needs_auth`), or misses and falls through.

When `returns` is an object, fields accumulate across tiers: each tier fills the
fields it can, and the engine stops as soon as every declared field is present. A
cheap tier therefore only needs to cover its share; nothing is extracted twice.

The llm tier returns an `agent_extract` outcome: the page snapshot plus the lens
author's extraction prompt, along with any fields the cheaper tiers already
gathered. The calling agent is itself a model, so it extracts the rest directly –
no nested model call, and the host holds no API key.

Lens `map` and `detect` bodies are JSONata expressions. JSONata can transform data
but cannot reach the network or the DOM, so a third-party lens can run in your
session without you auditing its author's code. Lenses are read-only: they observe
what the page already does, and cannot fire requests or act on the page.

## Architecture

```
your agent (Claude Code / Desktop / any MCP client)
   │  stdio (MCP): lens_list · lens_call · lens_observe · bridge_status
   ▼
lens-host (packages/host)              ← loads lens specs from lenses/ or any URL
   │  ws://127.0.0.1:4319
   ▼
Chrome extension (extensions/chrome)   ← MV3 service worker runs the resolver engine
   ├─ page.js     patches fetch/XHR    → intercept tier
   ├─ content.js  extracts from DOM    → dom tier
   └─ snapshot returned to the caller  → llm tier
```

The resolver engine lives in `packages/lens` – pure, environment-free, unit-tested.
The host and the extension are thin shells around it.

## Lens spec reference

A lens is a JSON file in `lenses/`, or hosted at any URL – publish one as a gist and
call it by URL.

- `lens` – namespaced name, `"site/operation"`. Referenced elsewhere as
  `site/operation@v1`.
- `version` – integer, bumped on breaking shape changes.
- `accepts` – URL patterns the lens applies to. `{holes}` bind as JSONata variables,
  as do call args:

  ```jsonc
  "accepts": ["https://x.com/{handle}/status/{id}"]   // $handle, $id in every expression
  ```

- `returns` – the result shape, which also guides the llm tier. A field may be a
  `$lens` ref, making the result callable – `next_page` typed as the lens itself is
  how pagination works:

  ```jsonc
  "next_page": { "$lens": "hn/top@v1" }   // call it again on the returned URL; null on the last page
  ```

- `outcomes` – named non-happy paths. An outcome may carry the `$lens` that resolves
  it:

  ```jsonc
  "needs_auth": { "$lens": "site/login@v1", "hint": "Ask the user to sign in, then retry." }
  ```

- `effects` – `{ "reads": [...], "writes": [...], "idempotent": true, "cache": 60 }`.
  `cache` is a TTL in seconds; partial results are never cached.
- `resolve` – the tier list. Per kind:
  - **intercept**: `request` ("METHOD url-pattern"); `detect` runs over
    `{status, url, body}`; `items`/`map` over the body. `reloadOnMiss` and
    `waitMs` control capture. Alternatively, named `sources` capture several
    responses at once, each body bound as a `$name` variable so `map` can
    join across them: `"stars_per_day": "$repo.stars / $release.age_days"`.
  - **dom**: `item` (repeating element selector) plus `fields` of
    `{ selector, attr?, sibling? }`; `post` reshapes the extraction.
  - **llm**: `prompt`.

`pok lens validate` checks every spec in `lenses/` against the engine's validator.

## Packages

| path | what |
|---|---|
| `packages/lens` | `@djgrant/lens` – spec types, URL patterns, JSONata eval, resolver engine |
| `packages/host` | `@djgrant/lens-host` – `lens-host` binary: MCP server (stdio) + extension bridge (WS :4319) |
| `extensions/chrome` | MV3 extension: interception, DOM extraction, engine host |
| `lenses/` | seed lens specs |

Planned work lives in [ROADMAP.md](./ROADMAP.md).
