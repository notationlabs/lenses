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

### Composing sources and reconciling tiers

`map` can be a single JSONata string, or a **per-field object** `{ field: "<jsonata>" }` so
each field can draw from a different binding.

The **intercept** tier can compose several responses via `sources` — a page fires many
requests, so name the ones you need and each body binds as a `$var` (its `{status, url,
body}` in `detect`, its body in `map`):

```jsonc
{ "kind": "intercept",
  "sources": {
    "usage": { "request": "GET https://x.com/api/*/usage*" },
    "sub":   { "request": "GET https://x.com/api/*/subscription*" }
  },
  "detect": { "needs_auth": "$usage.status = 401" },
  "map": { "limits": "$usage.limits", "renews_at": "$sub.next_charge_date" } }
```

A missing source is a tier miss (falls through). `sources` is intercept-only — dom and llm
each have a single input.

Tiers that return **objects reconcile**: each contributes the fields it has, later tiers
fill only the keys still absent, and the engine stops once every field in `returns` is
present (`resolver: "reconciled"`). So intercept can hand back `{limits}`, a cheap dom tier
fills the missing `plan`, and the llm tier stays the wholesale fallback — no duplicated
extraction. A tier omits fields it can't supply (absence is the signal; don't emit `""`).
Non-object results (arrays) don't reconcile — the first wins.

If the tiers exhaust without completing the declared `returns` shape, the engine still
returns what it gathered but marks it `partial: true`, and the host **won't cache a partial**
— so a one-off intercept flake that left only `plan` can't be replayed for the whole
`cache` TTL and mask the recovered cheaper tier on the next call.

### Pagination

Pagination isn't a new primitive — it's a lens field that points back at a lens. A paginated
lens returns an **object** carrying the page's items alongside a `next_page` field: the URL of
the following page, typed as a self-referential `$lens` (the same lens, since the next page is
the same shape). The cursor rides in the URL (`?p=2`), so `next_page` is just a bound lens ref
— no separate args. It's `null` on the last page.

```jsonc
"returns": {
  "type": "object",
  "fields": {
    "stories":   { "type": "array", "items": { /* … */ } },
    "next_page": { "$lens": "hn/top@v1" }          // ← the same lens, next page
  }
}
```

Walking all pages is the recursive application of one primitive: call the lens, read
`next_page`, call the lens on it, until `next_page` is null. The cursor is always a valid
`accepts` target for the same lens, which is what closes the loop. There are two ways a lens
sources its pages:

- **Follow the source's pagination** when the site paginates server-side. `hn/top` reads the
  front page's "More" link (`a.morelink`) — a second cheap `dom` tier that **reconciles** into
  `{ stories, next_page }` — so each `?p=N` fetches the next 30 stories the way the site serves
  them.
- **Window client-side** when the site serves everything in one document. A single page load
  of a Hacker News thread returns *all* comments, so a naive lens hands back a 200-comment,
  100k-char payload that overflows the caller. `hn/item` instead slices the extracted comments
  into pages in its `post` (default 30/page, override with `args:{limit}`) and emits a
  `next_page` whose `&p=N` is a pure cursor — HN ignores the param and re-serves the whole
  thread, and the lens slices the next window from it. The result stays bounded no matter how
  large the thread.

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
