# Lenses

**The web as a typed graph of callable functions.** A lens is a one-file, declarative
document that turns a webpage into a typed, callable operation — executed in *your own
browser session* by a headless extension, and exposed to *any agent* through MCP.

No chat UI. No API keys: the LLM fallback tier is served by the calling agent's own
model via MCP sampling.

Idea docs: [`actors.md`](./actors.md) · [`lens-pitch.md`](./lens-pitch.md) · [`lens-design.md`](./lens-design.md)

## Topology

```
your agent (Claude Code / Desktop / any MCP client)
   │  stdio (MCP): lens_list · lens_call · bridge_status  +  sampling for the LLM tier
   ▼
lens-host (packages/host)            ← loads lens JSON specs from lenses/ or any URL
   │  ws://127.0.0.1:4319
   ▼
Lens Host extension (apps/extension) ← MV3 service worker runs the resolver engine
   │
   ├─ page.js  (MAIN world)  patches fetch/XHR → intercept tier (free)
   ├─ content.js             DOM extraction    → dom tier (cheap)
   └─ sampling round-trip    page snapshot     → llm tier (paid, agent's own model)
```

The resolver engine itself lives in `packages/lens` (`@actors/lens`) — pure,
environment-free, unit-tested. Lens `map`/`detect` bodies are **JSONata expressions,
never JavaScript**, so a third-party lens can be executed without trusting its author
with your session.

## Quick start with pok

The repo ships [pok](https://github.com/djgrant/pok) commands for everything. Run
bare `pok` for the interactive menu, or:

```sh
pok demo            # end-to-end smoke demo — see the whole pipeline work, no browser needed
pok test            # engine unit tests
pok build           # build all packages
pok lens list       # what lenses exist, their tiers and effects
pok lens validate   # validate lenses/ against the engine's validator
pok setup           # the two manual steps to go live (extension + MCP)
pok setup mcp       # register lens-host with Claude Code (--writes to enable write lenses)
pok docs            # explore the idea/pitch/design docs
```

## Setup

```sh
pnpm install
pnpm build
```

1. **Load the extension:** Chrome → `chrome://extensions` → Developer mode →
   *Load unpacked* → `apps/extension/dist`.
2. **Register the MCP server** with your agent. For Claude Code:

   ```sh
   claude mcp add lens-host --env LENS_DIR="$PWD/lenses" -- node "$PWD/packages/host/dist/index.js"
   ```

3. Ask your agent: *“what's on the front page of hacker news? use lens_call”* —
   it should call `hn/top` against `https://news.ycombinator.com/` and answer from
   the DOM tier in a background tab.

Write lenses are disabled unless the host is started with `LENS_ALLOW_WRITES=1`.

## Writing a lens

A lens is a JSON file in `lenses/` (or hosted at any URL — publish one as a gist and
call it by URL). See `lenses/hn.top.json`. Shape:

```jsonc
{
  "lens": "site/operation",           // namespaced name
  "version": 1,
  "accepts": ["https://x.com/{handle}/status/{id}"],   // URL patterns with holes
  "returns": { ... },                 // shape hint (also guides the LLM tier)
  "outcomes": { "needs_auth": { "$lens": "site/login@v1" } },
  "effects": { "reads": ["x.com"], "writes": [], "cache": 30 },
  "resolve": [
    { "kind": "intercept", "request": "GET https://x.com/i/api/*", "items": "<jsonata>", "map": "<jsonata>",
      "detect": { "needs_auth": "status = 401" } },
    { "kind": "dom", "item": ".selector", "fields": { "title": { "selector": "a" } } },
    { "kind": "llm", "prompt": "Extract ..." }
  ]
}
```

Resolvers run cheapest-first and fall through on a miss. URL holes and call args are
available in every JSONata expression as variables (`$handle`, `$id`, …).

## Packages

| path | what |
|---|---|
| `packages/lens` | `@actors/lens` — spec types, URL patterns, JSONata eval, resolver engine (vitest-covered) |
| `packages/host` | `@actors/host` — `lens-host` binary: MCP server (stdio) + extension bridge (WS :4319) |
| `apps/extension` | MV3 extension: interception, DOM extraction, engine host |
| `lenses/` | seed lens specs: `hn/top`, `hn/item`, `github/notifications` |

## Status / known gaps

- Multi-session: each agent session's lens-host binds the first free port in the range 4319–4329 (`LENS_BRIDGE_PORT` still pins one exact port). The extension multiplexes — it keeps a socket open to every live host in that range and replies on the socket a request arrived on — so concurrent Claude Code sessions all reach the same browser.
- Interception misses requests made by service workers or before `document_start` patching on already-open tabs (reload the tab once after installing the extension).
- Content scripts aren't injected into tabs that were open before the extension loaded.
- Lens URLs are not yet content-pinned (SRI-style hashing planned) — only load lenses you trust.
- Firefox host (native `filterResponseData`) and the record-mode lens authoring flow are future work.
