# Lenses

A lens is a one-file declarative document that turns a webpage — or the API behind it — into a typed function.
The call runs at the cheapest context that can answer it: a direct HTTP request from the local broker (no browser at all), a cookie-carrying fetch inside your own browser, or a bound page as the fallback. Either way it uses your existing signed-in session without exporting cookies or running scraping infrastructure.

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
    { "kind": "http",
      "credentials": true,
      "sources": {
        "orgs": { "request": "GET https://claude.ai/api/organizations" },
        "usage": { "request": "GET https://claude.ai/api/organizations/{orgs.0.uuid}/usage" }
      },
      "detect": { "needs_auth": "$orgs.status = 401 or $orgs.status = 403" },
      "map": { "plan": "$orgs[0].rate_limit_tier", "limits": "[$usage.limits.{ 'name': kind, 'percent': $string(percent) & '%' }]" } },
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

Lenses requires Node.js 22.12 or later, and Chrome for the cookie-carrying and page tiers (a lens whose tiers are all credential-free `http` runs without any browser).

```sh
pnpm install
pnpm build
```

For the streamlined path, run `pnpm --filter @djgrant/lenses-extension-chrome build`, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extensions/chrome/dist`. Calls run through a persistent local broker on port 4319; the first client starts it automatically, and CLI, MCP, and library clients share the extension connection.

If Chrome is not running when a call arrives, the broker starts it in the background with the `Default` profile (a bare launch would stall on Chrome's profile picker). Set a different profile in `~/.config/lenses/config.json` with `{ "browser": { "profile": "Profile 2" } }`, or set `LENS_BROKER_AUTO_LAUNCH=0` to never launch Chrome. The configured profile must be the one holding the lens extension.

Chrome 144+ remote debugging is always available as the fallback. Enable it at `chrome://inspect/#remote-debugging`; if no compatible extension is connected, the next call uses CDP and Chrome asks for permission with an **Allow** dialog.

## TypeScript client

`@djgrant/lenses` is the single public package. Its root export is the primary client API:

```sh
npm install @djgrant/lenses
```

```ts
import { createLensClient } from "@djgrant/lenses";

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

### Record browser calls

Start one recorder on a client to save the stable page states reached by its browser-backed calls:

```ts
const recording = lenses.record(); // same as record(true); root defaults to ./screenshots
// Or: const recording = lenses.record({ path: "./artifacts" });

await lenses.call({ lens: "claude/usage" });
recording.stop();
console.log(recording.path); // absolute lenses-recording-<UTC timestamp> run path
```

A run contains `index.json` and numbered full-page PNGs. It records the stable state after binding,
after settled top-level document or SPA URL transitions, and at call completion. HTTP-only
calls and tabs unrelated to the bound call are not captured. Identical PNG bytes are stored
once while every ordered checkpoint remains in the index. PNG names use the event sequence,
host/path, and hash prefix (never query or fragment); `index.json` retains the full URL, title,
timestamp, lens, call ID, and SHA-256. Calling `stop()` affects new calls; a call started while
the handle was active remains part of that run.

The Chrome extension uses Chrome's `debugger` permission for screenshots. Chrome only lets
`captureVisibleTab` capture the active tab, so using it would either miss background lens tabs
or briefly expose and risk capturing an unrelated tab. The debugger API captures the bound
background tab without activating it; Chrome may show its standard debugging indicator, and
a tab already attached to DevTools or another debugger cannot be recorded. The CDP fallback
uses its existing debugging connection.

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

`@djgrant/lenses` also installs the `lens` command. It prints JSON to stdout and uses a
non-zero exit status for command and lens errors. Pass `--verbose` to write timestamped
broker and call diagnostics to stderr without contaminating the JSON output. Every
command has focused help, for example `lens call --help`.

```sh
lens list --catalog ./examples --catalog git:github.com/notationlabs/lenses#main/examples
lens update -c git:github.com/notationlabs/lenses#main/examples
lens call hn/top
lens call claude/usage
lens call hn/item --params '{"id":"42","p":2,"limit":10}' --verbose
lens call chatgpt/send --params '{"message":"hello"}' --allow-writes
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
`LensResultError` (`{message, issues, lens, callId}`) for error results. Broker timeout messages also include the recording call ID (when recording) and last reported progress. A non-idempotent perform timeout additionally carries `mutation`: `performStarted`, `lastAcknowledgedStep`, `submissionMayHaveHappened`, and `performed` (`"no"`, `"yes"`, or `"unknown"`). Treat `performed: "unknown"` as unsafe to retry without checking the target application. Both classes are exported
from `@djgrant/lenses` and from the generated SDK, so callers can catch and
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
for each lens's declared TTL. A call that needs a page fails immediately when no browser
backend is reachable; a call served entirely by credential-free `http` tiers needs no
browser. Use `lens status --wait-ms <number>` when a script should wait for a backend.

For repository development, Bun resolves the workspace packages directly to their
TypeScript source, so the CLI does not need a build first:

```sh
bun packages/cli/src/index.ts call hn/top
```

## MCP

The `lens-mcp` binary in `@djgrant/lenses` is a thin stdio adapter over the client. After installing
the package globally, configure it with the lens catalog:

```json
{
  "mcpServers": {
    "lenses": {
      "command": "lens-mcp",
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

- **http** makes its declared requests directly, without binding a page. Credential-free requests run in the broker's own process (no browser at all); `credentials: true` sends the browser's cookies — via the extension's service worker, or an already-open same-origin tab on the CDP fallback. `sources` chains requests, threading one response's values into the next request's URL.
- **intercept** reads JSON responses already fetched by the page.
- **dom** extracts fields from the rendered document with CSS selectors.
- **llm** returns a page snapshot and extraction prompt to the caller.

When `returns` is an object, fields accumulate across tiers. The engine stops when all
declared fields are present, so each tier only needs to supply its part of the result.

Lens `map` and `detect` bodies are JSONata expressions. They cannot reach the network or DOM. Beyond an `http` tier's declared requests, lenses observe what a page already does; page actions and mutating HTTP methods run only when the caller opts in with `--allow-writes` (CLI) or `allowWrites` (client and MCP).
`lens eval` runs the same sandboxed evaluator against a JSON file or stdin, so an
expression can be iterated on offline before it goes into a lens document.

## Architecture

```text
application ─┐                                              ┌─ extension ─► Chrome
lens CLI ────┼─► @djgrant/lenses ── WebSocket ──► broker ┤
lens MCP ────┘                           │             └─ CDP fallback
                              core resolver engine
```

The broker hosts the resolver engine, caching, retry policy, and page-retention policy once. Credential-free `http` tiers run in the broker process itself; everything else pins the call to one session backend: the extension is preferred when its protocol and capabilities are compatible, while the CDP backend supplies the same page lifecycle, network capture, and in-page extraction primitives as a fallback. The page is bound lazily — a call an `http` tier satisfies never launches or touches the browser.

Browser calls use one explicit **serial queue** across clients; there is never concurrent mutation of the shared browser session. Queue time counts against each request deadline, and an expired queued request is rejected before browser work begins. If backend work outlives its caller timeout, subsequent calls receive `code: "broker_busy"` until that work settles rather than overlapping it. `lens status` / `broker_status` reports the policy, active call, queue depth, each backend's version and capabilities, last backend error, CDP reconnect attempts, and separate Chrome/extension reachability (unknown Chrome reachability is omitted until probed).

### Broker lifecycle

The first client to need the broker spawns it as a detached process on port 4319 and every later client shares it. Because it outlives the command that started it, the daemon stamps itself at startup with a content hash of its own module directory and reports that stamp in its status frame. A client whose own stamp differs — the normal state after a rebuild or a pull — asks the broker to shut down and reconnects to a freshly spawned one, so nobody keeps talking to yesterday's code. Concurrent clients coordinate through a lock file, so exactly one restarts the broker while the rest wait and reconnect; a stamp that never converges fails the bind after three attempts rather than looping. A retiring broker stops listening first — freeing the port for the replacement — then drains in-flight calls (bounded at 10s) so a call already running still receives its result, then releases the CDP lease under a 5s bound and exits. The replacement binds the port while the old process is still draining.

The broker also retires itself when nobody needs it. Two windows govern this, and any connected client, attached extension or in-flight call restarts both:

- **No browser reachable** — `LENS_BROKER_NO_BROWSER_EXIT_MS`, default 10s. A browserless broker can still serve credential-free `http` tiers, but only for a connected client — and a connected client holds the broker open anyway, so an idle one only occupies memory (~56MB), and respawning costs ~200ms; it goes almost immediately. Chrome leaves its `DevToolsActivePort` file behind when it quits, so the check is an HTTP probe of the endpoint rather than the file's presence.
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
- `perform` — an ordered list of write steps run once against the bound page, before the resolve tiers read the result back:

  ```jsonc
  "perform": [
    { "fill": "#prompt-textarea", "value": "$message" },   // insertText, never value=
    { "click": "[data-testid='send-button']" },
    { "press": "Enter" },
    { "wait": { "increases": "section[data-turn]", "timeoutMs": 30000 } },
    { "navigate": "fresh" }                                 // reload the bound target
  ]
  ```

  `wait` takes exactly one of `appears` (≥1 match), `gone` (0 matches, immediately true when already satisfied), or `increases` (match count exceeds the baseline sampled at step entry — place it right after the step that triggers the change), plus `timeoutMs` (default 10000). `navigate` accepts only `"fresh"`.

  Consent is declared and enforced: `perform` requires non-empty `effects.writes`, `effects.cache` absent or 0, and `idempotent: true` only when every step is a navigate. The caller must pass `--allow-writes`/`allowWrites` or the call is refused with `code: "writes_not_allowed"`; a step failure is `code: "perform_failed"` with the 0-based `step`, and no tier runs after it. Results are never cached, and any result from a call whose steps all ran carries `performed: true` — the write happened, even if reading the result back failed. With `--verbose`, each step reports started/completed; selectors are bounded and likely secret-bearing attribute values are redacted, and fill values are never logged. Steps are not retried after a lost acknowledgement.

- `loadTimeoutMs` — optional page-load timeout; the default is 30 seconds.
- `resolve` — ordered http, intercept, DOM, and LLM resolver definitions.

An intercept resolver can capture one request or declare named `sources` that join several
responses. An LLM resolver declares the extraction prompt and optional snapshot limit.

### HTTP resolver

An HTTP resolver fires its own requests instead of reading a page's. `request` is
`"METHOD url-template"` (omitted, the tier GETs the lens `url`); `items` and `map`
shape the parsed body exactly as in an intercept tier, and `detect` sees
`{status, url, body}`. `headers` adds request headers, with the same `{param}` holes
as URLs. `body` supports JSON, plain text, multipart form data, and URL-encoded
search parameters; its values are JSONata expressions over the declared params
and any earlier source bindings:

```jsonc
{
  "kind": "http",
  "request": "POST https://example.com/api/messages",
  "credentials": true,
  "body": { "json": "{ 'message': $message }" }
}

// Other encodings:
{ "body": { "text": "$message" } }
{ "body": { "form": { "message": "$message", "tag": "['a', 'b']" } } }
{ "body": { "search": { "message": "$message" } } }
```

A body may be declared on a single request or on each entry in `sources`.
`form` and `search` fields accept a scalar or an array of scalars; arrays emit
repeated fields.

```jsonc
{
  "kind": "http",
  "credentials": true,
  "sources": {
    "orgs":  { "request": "GET https://claude.ai/api/organizations" },
    "usage": { "request": "GET https://claude.ai/api/organizations/{orgs.0.uuid}/usage" }
  },
  "detect": { "needs_auth": "$orgs.status = 401 or $orgs.status = 403" },
  "map": { "plan": "$orgs[0].rate_limit_tier", "limits": "[$usage.limits]" }
}
```

- POST, PUT, PATCH, DELETE, and any method other than GET/HEAD/OPTIONS are writes.
  They require non-empty `effects.writes`, cannot be cached, and are refused unless
  the caller passes `--allow-writes`/`allowWrites`. Consent is checked before any
  request or browser bind.
- `credentials: true` sends the browser's cookies. The extension serves this from
  its service worker with no tab; the CDP fallback evaluates the fetch inside an
  already-open same-origin tab, and misses when none is open. Without a
  browser-backed host the tier misses into the page tiers.
- `sources` chains requests in declaration order. Each binds its body as `$name`
  for `map` and `detect`, and later request templates address earlier bodies with
  dotted holes — `{orgs.0.uuid}` — which is how an id only another response knows
  reaches a URL. A detected outcome or non-2xx status stops the chain.
- A network failure, an unexpandable hole, or an unsupported request is a miss,
  never a call error: the page tiers reach the same site through the browser and
  may still succeed.

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
| `packages/lenses` | `@djgrant/lenses` | Bundled public package: client, core, CLI, and MCP |
| `packages/core` | private workspace | Specs, validation, JSONata, resolver engine |
| `packages/client` | private workspace | Lens orchestration and persistent browser broker |
| `packages/cli` | private workspace | JSON command-line adapter |
| `packages/mcp` | private workspace | stdio MCP adapter |
| `extensions/chrome` | private workspace | Preferred Chrome session backend |
| `examples` | — | Example lens catalog |

Planned work lives in [ROADMAP.md](./ROADMAP.md).
