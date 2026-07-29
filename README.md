# Lenses

A lens is a one-file declarative document that turns a webpage into a typed function.
The call runs in your own browser over Chrome's remote-debugging protocol, so it can use your existing signed-in session without exporting cookies or running scraping infrastructure.

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

Lenses requires Node.js 22.12 or later and Chrome.

```sh
pnpm install
pnpm build
```

For the streamlined path, run `pnpm --filter @djgrant/lens-extension-chrome build`, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extensions/chrome/dist`. Calls run through a persistent local broker on port 4319; the first client starts it automatically, and CLI, MCP, and library clients share the extension connection.

If Chrome is not running when a call arrives, the broker starts it in the background with the `Default` profile (a bare launch would stall on Chrome's profile picker). Set a different profile in `~/.config/lenses/config.json` with `{ "browser": { "profile": "Profile 2" } }`, or set `LENS_BROKER_AUTO_LAUNCH=0` to never launch Chrome. The configured profile must be the one holding the lens extension.

Chrome 144+ remote debugging is always available as the fallback. Enable it at `chrome://inspect/#remote-debugging`; if no compatible extension is connected, the next call uses CDP and Chrome asks for permission with an **Allow** dialog.

## TypeScript client

`@djgrant/lens-client` is the primary API:

```ts
import { createLensClient } from "@djgrant/lens-client";

await using lenses = await createLensClient({
  catalog: [
    "./examples", // file:./examples — a local directory, read live
    "git:github.com/notationlabs/lenses#main/examples", // shallow clone, cached under ~/.cache/lenses
    "https://lenses.example.com/catalog.json", // HTTP index of documents, ETag-cached
  ],
});

const available = await lenses.list();
const result = await lenses.call({
  lens: "claude/usage",
});
```

Catalog sources are tried in order. A source is a directory path (`file:` optional), a
`git:host/owner/repo[#ref][/subdir]` reference (`git:/abs/path` clones a local
repository), or the URL of an HTTP catalog index —
`{ "lenses": ["hn.top.json", …] }` — whose entries are document URLs resolved against it
(whole documents may also be inlined). Scoped lens names must be unique across all
sources; a contested shortname resolves to the earliest source. Git clones and HTTP
indexes load from `~/.cache/lenses` once fetched; `lens update` (or `client.update()`)
refreshes them from their origins.

The client owns lens discovery, reference resolution, parameter validation, TTL caching, and the
local broker connection. `call` returns a `value`, a structured `outcome`, or an `error`.
An `agent_extract` outcome contains the page snapshot and lens prompt for the consumer's
own model; the client does not select or call an LLM provider.

Use `observe` to inspect the JSON requests and text snapshot needed to author a lens:

```ts
const observation = await lenses.observe({
  target: "https://github.com/notifications",
  waitMs: 4_000,
  html: true, // include body markup (scripts/styles stripped) for writing DOM selectors
});
```

## CLI

`@djgrant/lens-cli` installs the `lens` command. It prints JSON to stdout and uses a
non-zero exit status for command and lens errors. Pass `--verbose` to write timestamped
broker and call diagnostics to stderr without contaminating the JSON output. Every
command has focused help, for example `lens call --help`.

```sh
lens list --catalog ./examples --catalog git:github.com/notationlabs/lenses#main/examples
lens update -c git:github.com/notationlabs/lenses#main/examples
lens call hn/top
lens call claude/usage
lens call hn/item --params '{"id":"42","p":2,"limit":10}' --verbose
lens observe https://github.com/notifications --wait-ms 4000 --html
lens schema hn/top
lens gen ts-sdk -o src/lenses.gen.ts
lens eval '[stories.{ "t": title }]' --input sample.json
lens status --wait-ms 5000
lens skill > .claude/skills/lenses/SKILL.md
```

`lens skill` prints an agent skill — a SKILL.md document (frontmatter included)
teaching an agent to call lenses, branch on outcomes, and author new lens documents
with `observe` and `eval`. It needs no catalog or browser, so it can be piped
straight into an agent's skills directory.

`lens schema <lens>` emits a standard JSON Schema (draft 2020-12) derived from the lens
document's `returns` declaration — the input for external codegen or validation. `$lens`
fields reference the shared `$defs/lensRef` object schema (or null).

`lens gen ts-sdk [<catalog> ...]` generates a TypeScript SDK from one or more lens
catalogs: a `Lenses` map of params and result types per lens (keyed by scoped
name and shortname), and a `createLensClient` whose `call()` is narrowed against it —
typed params (defaulted parameters optional), a `value` branch matching the declared
`returns` shape, and `$lens` fields as nullable `LensRef<"target">` references.

```ts
import { createLensClient, LensOutcomeError } from "./lenses.gen.js";

const client = createLensClient(); // sync; binds the broker on first call

// Default path: value() returns the typed value, or throws.
const top = await client.value({ lens: "hn/top", params: { p: 2 } });
top.stories[0].title; // string

// Branching path: call() returns the full result union.
const result = await client.call({ lens: "github/notifications" });
if (result.kind === "outcome") result.name; // e.g. "needs_auth"
```

`value()` throws `LensOutcomeError` (`{outcome, value, hint}` — `hint` carries the
remediation text declared in the lens document's `outcomes`) for outcome results, and
`LensResultError` (`{message, issues}`) for error results. Both classes are exported
from `@djgrant/lens-client` and from the generated SDK, so callers can catch and
branch on `error.outcome`.

Resolved values are validated against the same derived schema. A violation is an
`error` result naming each failing JSON pointer in `issues` (`{path, message}`).
`lens call --lax` (or `call({ strict: false })` in the client) demotes violations
to `warnings` attached to the value result instead.

Call parameters are validated against the lens document. Each parameter becomes a
JSONata variable such as `$limit`. URL templates and resolver expressions use the same
parameter set.

Each command connects to the persistent broker and disconnects when it finishes. The
broker stays connected to Chrome between commands and shares successful cached results
for each lens's declared TTL. Calls fail immediately when Chrome's remote-debugging
endpoint is unavailable. Use `lens status --wait-ms <number>` when a script should wait
for it.

For repository development, Bun resolves the workspace packages directly to their
TypeScript source, so the CLI does not need a build first:

```sh
bun packages/cli/src/index.ts call hn/top
```

## MCP

`@djgrant/lens-mcp` is a thin stdio adapter over `@djgrant/lens-client`. Configure it
with the lens catalog and built entry point:

```json
{
  "mcpServers": {
    "lenses": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": { "LENS_CATALOG": "/absolute/path/to/examples,git:github.com/notationlabs/lenses#main/examples" }
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
`lens eval` runs the same sandboxed evaluator against a JSON file or stdin, so an
expression can be iterated on offline before it goes into a lens document.

## Architecture

```text
application ─┐                                              ┌─ extension ─► Chrome
lens CLI ────┼─► @djgrant/lens-client ── WebSocket ──► broker ┤
lens MCP ────┘                                │             └─ CDP fallback
                                  @djgrant/lens resolver engine
```

The broker hosts the resolver engine, caching, retry policy, and page-retention policy once. It pins each call to one session backend: the extension is preferred when its protocol and capabilities are compatible, while the CDP backend supplies the same page lifecycle, network capture, and in-page extraction primitives as a fallback.

### Broker lifecycle

The first client to need the broker spawns it as a detached process on port 4319 and every later client shares it. Because it outlives the command that started it, the daemon stamps itself at startup with a content hash of its own module directory and reports that stamp in its status frame. A client whose own stamp differs — the normal state after a rebuild or a pull — asks the broker to shut down and reconnects to a freshly spawned one, so nobody keeps talking to yesterday's code. Concurrent clients coordinate through a lock file, so exactly one restarts the broker while the rest wait and reconnect; a stamp that never converges fails the bind after three attempts rather than looping. A retiring broker stops listening first — freeing the port for the replacement — then drains in-flight calls (bounded at 10s) so a call already running still receives its result, then releases the CDP lease under a 5s bound and exits. The replacement binds the port while the old process is still draining.

The broker also retires itself when nobody needs it. Two windows govern this, and any connected client, attached extension or in-flight call restarts both:

- **No browser reachable** — `LENS_BROKER_NO_BROWSER_EXIT_MS`, default 10s. A broker with nowhere to run a lens can only occupy memory (~56MB), and respawning one costs ~200ms, so it goes almost immediately. Chrome leaves its `DevToolsActivePort` file behind when it quits, so the check is an HTTP probe of the endpoint rather than the file's presence.
- **Browser present but unused** — `LENS_BROKER_IDLE_EXIT_MS`, default 15m (`0` disables both). Longer, because exiting here throws away a working CDP lease: consent is session-scoped, so reacquiring is silent while Chrome keeps running but costs an **Allow** dialog once Chrome restarts.

The extension guard matters: exiting while the extension is attached would drop its socket and push it back through broker rediscovery (~7s, longer on a port it has not seen), which costs more than the resident process saves. In practice that means a broker stays up while you have Chrome open with the extension, and is reclaimed shortly after you quit Chrome. `lens broker shutdown` retires it immediately.

## Lens spec reference

A lens is a JSON file in a catalog source — a local directory such as `examples/`, a git
repository, or an HTTP catalog index — or at a direct HTTP URL.

- `name` — globally scoped name such as `@djgrant/hn/item`. The local catalog also
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

  A field declaring a `$lens` reference materialises from the row's other fields;
  no resolver needs to emit the key. A row whose parameters do not bind gets
  `null`, and an explicit `null` from a resolver suppresses the reference.

- `outcomes` — named non-happy paths, optionally carrying the lens that resolves them.
  `hint` is the only key read from a declaration; it is the remediation text the
  caller is shown.
- `detect` — outcome detection shared by every tier, each evaluating it against
  its own context (`{url, title}` for DOM, `{status, url, body}` for intercept).
  A resolver's own `detect` overrides it for that outcome.
- `helpers` — named JSONata lambdas bound as `$name` in every expression the
  document evaluates:

  ```jsonc
  "helpers": { "money": "function($s) { $number($replace($s, /[^0-9.]/, \"\")) }" }
  ```

  A `catalog.json` beside the documents may declare the same block for all of
  them, so fixing a helper is one edit rather than one per document. A
  document's own entry overrides the catalogue's, and a declared param of the
  same name shadows both.

- `effects` — `{ "reads": [...], "writes": [...], "idempotent": true, "cache": 60 }`.
- `loadTimeoutMs` — optional page-load timeout; the default is 30 seconds.
- `resolve` — ordered intercept, DOM, and LLM resolver definitions.

An intercept resolver can capture one request or declare named `sources` that join several
responses. An LLM resolver declares the extraction prompt and optional snapshot limit.

### DOM resolver

A DOM resolver declares an optional repeating `item` selector and named `fields`. With
`item`, the tier yields one object per matching element and each field selector is scoped
to that element; without it, fields are resolved once against the whole document.

```jsonc
{
  "kind": "dom",
  "item": "tr.athing",
  "fields": {
    "title": { "selector": ".titleline > a" },
    "url": { "selector": ".titleline > a", "attr": "href" },
    "score": { "selector": ".score", "scope": "+" }
  },
  "post": "[$.{ 'title': title, 'points': $number($substringBefore(score, ' ')) }]"
}
```

Each field spec supports:

- `selector` — a CSS selector; the **first** matching element wins. The special
  selector `":self"` reads the item element itself rather than a descendant.
- `attr` — read this attribute instead of the element's trimmed `textContent`.
  `href` and `src` values are resolved to absolute URLs against the page.
- `scope` — move the element the selector runs from, for context the item
  itself does not contain. `"+"` (or `"+ sel"`, which also requires the sibling
  to match) searches `item.nextElementSibling`, handling split-row layouts:
  HN's story/subtext table rows, or definition lists, where `"item": "dt"` zips
  each `dt` with its `dd`. Any other value is an ancestor selector resolved with
  `closest()`, so a row can read a heading on the panel enclosing it:
  `{ "selector": ".year-heading", "scope": ".tab-panel" }`. `sibling: true` is
  the older spelling of `"scope": "+"` and still works.

`url` and every selector — `item`, a field's `selector`, and its `scope` —
expand `{name}` holes from declared params.

A field that matches nothing is `null`. A tier that extracts nothing (or an empty
item list) misses and falls through to the next tier. `detect` sees `{url, title}`,
and `post` is a JSONata expression applied to the extracted value.

Run `pok lens validate` to validate every document under `examples/`.

## Packages

| path | package | responsibility |
|---|---|---|
| `packages/lens` | `@djgrant/lens` | Specs, validation, JSONata, resolver engine |
| `packages/client` | `@djgrant/lens-client` | Lens orchestration and persistent browser broker |
| `packages/cli` | `@djgrant/lens-cli` | JSON command-line adapter |
| `packages/mcp` | `@djgrant/lens-mcp` | stdio MCP adapter |
| `extensions/chrome` | `@djgrant/lens-extension-chrome` | Preferred Chrome session backend |
| `examples` | — | Example lens catalog |

Planned work lives in [ROADMAP.md](./ROADMAP.md).
