---
name: lenses
description: Read live web pages as typed function calls through the lens CLI. Use when a task needs data from a website the user is signed into, or when authoring a new lens for an unmapped page.
---

# Notation Lenses

Notation Lenses turns a webpage into a typed function. Calls run through the user's own browser using Microsoft's Playwright Extension over a tab-group CDP relay, so signed-in sessions work.

## CLI Behaviour

Catalog and execution commands (`list`, `call`, `schema`, `observe`, `update`, `broker`) print JSON to stdout and exit non-zero on errors. Utility commands (`skill`, `gen ts-sdk`, `eval`, `graphql`) output text, generated code, JSON results, or start a local HTTP server.

Pass a catalog directory with `--catalog <path>` for `list`, `call`, `schema`, `update`, and `graphql` (or ask the user where their lens catalog lives). Settings and catalog parameter defaults live in `~/.config/lenses/config.json`.

## Calling a lens

```sh
lens list --catalog ./examples    # discover lenses, their params and exceptions
lens call hn/item --params '{"id":"42"}' --catalog ./examples
```

`call` and `observe` automatically start or reconnect the local broker and configured browser when needed. Treat the operation's result as authoritative; ask the user to act in the browser only when its error or structured outcome requires it.

A call result is one of three shapes:

- `{"kind": "value", "value": ...}` – the typed result. Fields may contain `$lens` references carrying ready-made follow-up calls. Call them next instead of guessing URLs.
- `{"kind": "outcome", "name": ...}` – a declared non-happy path such as `needs_auth`, optionally carrying the lens that resolves it. An `agent_extract` outcome returns a page snapshot and prompt so you can extract the `returns` shape directly.
- `{"kind": "error", "message": ..., "issues": [...]}` – failure details. `issues` lists failing JSON pointers on schema mismatch; retry with `--lax` to return the value with warnings instead.

### File lenses when calling

A lens whose `returns` is `{"type": "file"}` writes a saved file instead of inline content. Pass `--out-dir` with an absolute path:

```sh
lens call bank/statement-pdf --params '{"id":"2026-01"}' --out-dir ~/Statements
```

The returned value is `{"path", "name", "mimeType", "bytes"}` with an absolute `path`. Missing `--out-dir` fails immediately with `code: "out_dir_required"`, invalid or relative paths fail with `code: "out_dir_invalid"`, and existing files with the same name are replaced.

### Tab targeting and broker control

A result whose tab stays open carries `"tab": "t1"`, the broker ID for that tab. Pass it back with `lens call <lens> --tab t1` or `lens observe --tab t1` to read or route the open tab without opening a new one. Calling a closed tab fails with `code: "tab_closed"`.

Use `lens broker release`, `lens broker acquire`, and `lens broker shutdown` to manage browser ownership, `lens update` to refresh cached `git:` catalogs, and `lens graphql playground` to explore catalogs over GraphQL. Over MCP, `lens-mcp` exposes `lens_list`, `lens_call`, and `lens_observe` over stdio.

## Write lenses

A lens with a `perform` block acts on the page (`fill`, `click`, `submit`, `press`, `drop`, `wait`, `navigate`), then runs its `resolve` tiers in the same call. A lens is treated as a write when `effects.writes` is non-empty, whether it acts through `perform` steps or a mutating HTTP method.

Read-only `perform` steps such as clicking a pagination link declare `"writes": []`. Calling any write lens requires `--allow-writes`; otherwise the broker refuses it with `code: "writes_not_allowed"`. Check `effects.idempotent` before retrying, because a non-idempotent write repeats on retry.

`performed: true` on the result means every `perform` step completed even if extraction later errored. Failure during a step returns `code: "perform_failed"` with the failing zero-based `step` index.

```sh
lens call chatgpt/send --params '{"message":"hello"}' --allow-writes   # fills, clicks, waits, returns the transcript
lens call chatgpt/clear --allow-writes                                  # navigate "fresh" discards the anonymous chat
lens call chatgpt/chat                                                  # plain read; no flag needed
```

### Authoring rules for writes

A mutating HTTP method (anything other than `GET`, `HEAD`, or `OPTIONS`) requires non-empty `effects.writes`, and any write lens must omit `effects.cache` or set it to `0`. Set `idempotent: true` only when repeating the steps is safe.

Keep readback in its own lens when useful and give each write lens the same resolve tiers so callers receive verified post-action state.

| Step feature | Rule |
| --- | --- |
| Click and wait text matcher | Matches first visible element whose collapsed text contains the template, picking innermost match |
| Shadow root selector | Traverses shadow roots with `a >>> b` inside web components for `click` and `wait` |
| File drop step | Names `"$params.<name>"` pointing to a declared non-default string param holding an absolute file path |
| Native form submit step | Writes literal named controls from `form` expressions over `$params` before calling `requestSubmit()` |
| HTTP request body | Supports `json`, `text`, `form`, or `search`, reading `$params` and earlier `$sources` |

## File lenses

`"returns": { "type": "file" }` covers the entire result and cannot be nested. The winning resolver returns a file payload that the broker validates and writes into `--out-dir`:

```jsonc
"map": {
  "content": "$res.body.content",
  "encoding": "'base64'",
  "mimeType": "'application/pdf'",
  "name": "'Statement-' & $params.id & '.pdf'"
}
```

| Field | Value |
| --- | --- |
| `content` | File payload encoded as a string |
| `encoding` | `"base64"` decoded to bytes or `"utf8"` written as text |
| `mimeType` | Valid media type string such as `application/pdf` |
| `name` | Optional filename without `/`, `\`, or leading `.`, defaulting to `<lens>-<sha256_12>.<ext>` |

Missing fields, invalid base64, or unsafe names fail with `code: "file_invalid"`. File lenses allow `intercept` and `http` response bodies up to 32 MiB instead of the default 512 KiB. While a file lens runs and for 5 seconds after, `<a download>` saves are suppressed so the browser does not create a duplicate copy in Downloads. `effects.cache` still applies and writes cached bytes again on a hit.

## Authoring a lens for an unmapped page

1. Observe the page:

   ```sh
   lens observe https://example.com/page --wait-ms 4000 --html
   ```

   This returns the JSON requests the page fired, a text snapshot, and stripped body markup when `--html` is passed.

2. Test JSONata expressions offline against a saved capture. Stdin or `--input` binds as `$res.body` by default, `--as value` binds `$value` to test `dom.post`, and `--as item` tests a per-row `map`:

   ```sh
   lens eval '[$res.body.stories.{ "t": title }]' --input sample.json
   ```

3. Write a JSON lens document into the catalog. `name`, `url`, `effects`, and `resolve` are always required. Resolver tiers run in order and merge missing fields until `returns` is satisfied:

   - `http` – direct requests via node/browser transport with no page needed when public or cookie-authenticated APIs exist. `credentials: true` sends browser cookies; `credentials: "same-origin-page"` runs inside an open matching-origin tab. Chained `sources` bind `$sources.name` for later `url`, `headers`, `body`, and `map` expressions (`{sources.orgs.body.0.uuid}`).
   - `intercept` – reads matching JSON responses captured by the open page using a `{method, url}` `*`-glob pattern with `{params.name}` holes.
   - `dom` – extracts text or attributes via CSS selectors and an optional repeating `item` selector.
   - `llm` – last resort returning the snapshot text and prompt to the caller as an `agent_extract` outcome.

   ```jsonc
   {
     "name": "@scope/site/thing",
     "url": "https://site.com/{params.id}",
     "params": { "id": "string" },
     "returns": { "type": "object", "fields": { "title": "string" } },
     "exceptions": { "needs_auth": { "matches": "$res.status = 401", "$lens": "@scope/site/login" } },
     "effects": { "reads": ["site.com"], "writes": [], "idempotent": true },
     "resolve": [
       { "kind": "intercept",
         "request": { "method": "GET", "url": "https://site.com/api/thing/{params.id}" },
         "map": { "title": "$res.body.data.title" } }
     ]
   }
   ```

   For a list, `returns` uses `{"type": "array", "items": {...}}` where `items` is a bare field map straight from field names to types, not a `{ "type": "object", "fields": ... }` wrapper:

   ```jsonc
   "returns": {
     "type": "array",
     "items": { "title": "string", "score": { "type": "integer", "nullable": true } }
   }
   ```

   For a recursive shape such as a comment tree, define it under `$defs` and link via `{"$ref": "<name>"}`:

   ```jsonc
   "$defs": {
     "comments": { "type": "object", "fields": {
       "author": "string", "text": "string",
       "replies": { "type": "array", "items": { "$ref": "comments" } } } }
   },
   "returns": { "type": "object", "fields": {
     "comments": { "type": "array", "items": { "$ref": "comments" } } } }
   ```

   A `dom` tier accepts `fields` and optional `post` (`map` belongs to `http` and `intercept` only). With a repeating `item` selector, `dom` extracts one object per matched element:

   ```jsonc
   { "kind": "dom",
     "item": "tr.athing",
     "fields": {
       "title": { "selector": ".titleline > a" },
       "url": { "selector": ".titleline > a", "attr": "href" },
       "score": { "selector": ".score", "scope": "+" } },
     "post": "$value[[0..$params.limit - 1]]" }
   ```

   Each field sets `selector` (using `":self"` for the scoped element), optional `attr` (`href` and `src` resolve to absolute URLs), and optional `scope`. Missing selectors yield `null`; declare them `nullable` in `returns` or coerce to `null` in `map` / `post`.

   Use `"scope": "+"` or `"+ sel"` to step to the next element sibling in split-row tables or `<dt>`/`<dd>` lists (prefer `"scope": "+"` over deprecated `sibling: true`). Any other `scope` string runs `closest()` to reach enclosing context:

   ```jsonc
   "fields": { "year": { "selector": ".year-heading", "scope": ".tab-panel" } }
   ```

   Without `attr`, rendered text separates `<br>` sides, collapses whitespace runs including `&nbsp;`, and trims the result. Present blank elements return `""`, while unmatched selectors return `null`.

   Tiers merge missing keys into the accumulated object without overwriting existing values. Name an `item` array in `post` to combine it alongside another tier:

   ```jsonc
   "returns": { "type": "object", "fields": {
     "total": "number",
     "rows": { "type": "array", "items": { "period": "string" } } } },
   "resolve": [
     { "kind": "dom", "fields": { "total": { "selector": ".total" } },
       "post": "{ 'total': $number($value.total) }" },
     { "kind": "dom", "item": ".row", "fields": { "period": { "selector": ".period" } },
       "post": "{ 'rows': $value }" }
   ]
   ```

   Declare shared exceptions in `catalog.json` `scopes` matched by `*`-only URL globs:

   ```jsonc
   { "scopes": [{ "url": "https://*.site.com/*", "exceptions": {
     "needs_auth": {
       "matches": "$contains($page.url, '/sign-in') or $res.status = 401",
       "hint": "Sign in, then retry."
     }
   } }] }
   ```

   Page checks populate `$page` and response checks populate `$res`; check both when sign-in redirects happen on either. A document can extend inherited entries, disable only an inherited predicate with `matches: null`, or set the key to `null` to suppress it completely. Tier `exceptions` run before inherited rules. Legacy `detect` and `outcomes` keys are rejected.

   A `returns` field with `{ "$lens": ..., "params": ... }` builds follow-up calls automatically from sibling fields bound as `$item`:

   ```jsonc
   "returns": { "type": "array", "items": {
     "period": "string",
     "detail": { "$lens": "@scope/site/detail", "params": { "period": "$item.period" } } } }
   ```

   Rows whose ref `params` do not bind settle to `null`. Returning explicit `null` suppresses the reference on that row, while a `{ "$lens", "params" }` object emitted by `post` or `map` is kept as written.

   Add a `limit` param to keep large lists bounded:

   ```jsonc
   "params": { "limit": { "type": "integer", "default": 5 } }
   ```

   A parameter `default` can also pull a scalar from another lens (`{ "$lens", "field", "params"? }`) where `field` evaluates over `$value`. It must resolve to a non-nullable primitive matching the param type:

   ```jsonc
   "params": { "vrn": { "type": "string",
     "default": { "$lens": "@scope/site/summary", "field": "$value.vrn" } } }
   ```

   Note `field` belongs strictly to parameter defaults, not `returns` links.

   DOM selectors and `ready` accept `{params.name}` holes substituted verbatim without percent-encoding, so type numeric IDs as `integer` when possible:

   ```jsonc
   "params": { "year": "integer" }
   ```

   Shared pure transformations belong in `helpers` on a lens or `catalog.json`, bound as `$name` across expressions. A helper sees only its own arguments and cannot name parameters after reserved variables (`res`, `item`, `sources`, `params`, `value`, `page`).

   For stateful apps that lose session state on reload, set `tab: "reuse"` and `navigate: "in-page"` on the lens or `catalog.json` scope, and add a `ready` selector so `dom` tiers wait for rendering rather than landing on transient shells.

   When Playwright Extension disconnects or the broker restarts, open tabs leave the extension tab group; drag the signed-in tab back into the group to reuse it, or inspect `~/.cache/lenses/broker.log` when debugging tab or attach behavior.

4. Call your document directly to verify: `lens call ./my-lens.json --catalog .`

## Expressions and templates

`items`, `map`, `post`, `matches`, helpers, and request bodies run sandboxed JSONata with **no implicit root input**. Top-level paths must start from a bound variable (`$var`) or built-in; relative field names work only inside filter predicates or steps after a rooted expression.

```jsonc
"$value[$has(date)].{ 'date': date, 'amount': $money(amount) }"  // ok: date, amount are relative to each row
"$map($res.body.rows, function($r) { $r.id })"                   // ok: lambda arguments are variables
"date"                                                            // error: path "date" must start at a variable
"$[0]"                                                            // error: "$" has no input to refer to here
"$id"                                                             // error: read the call parameter as $params.id
```

### Variables in scope at each site

| Site | Variables |
| --- | --- |
| Single `items` | `$res`, `$params` |
| Single `map` with `items` | `$item`, `$res`, `$params` |
| Single `map` without `items` | `$res`, `$params` |
| HTTP source `items` | `$res`, `$sources`, `$params` |
| Intercept source `items` | `$res`, `$params` |
| Multi-source `map` | `$sources`, `$params` |
| HTTP source `body` | `$sources`, `$params` |
| Single HTTP `body` | `$params` |
| DOM `post` | `$value`, `$params` |
| Perform `fill` / `submit` values | `$params` |
| Document and scope exceptions | `$page`, `$res`, `$params` |
| DOM tier exceptions | `$page`, `$value`, `$params` |
| Single HTTP / intercept tier exceptions | `$res`, `$params` |
| Multi-source tier exceptions | `$sources`, `$params` |
| Return `$lens` reference `params` | `$item`, `$params` |
| Parameter default `field` | `$value` |
| Helpers | Lambda arguments only |

Every `$res` and `$sources.<name>` reply is `{status, url, body}`. Source bodies reflect post-`items` extraction in later sources, `body`, and `map`, whereas tier `exceptions` run against the raw reply before `items`.

### Maps

A `map` is either one JSONata expression or a nested object of expressions. String constants inside expressions need inner single quotes (`"'base64'"`), and fields evaluating to `undefined` are omitted.

```jsonc
"items": "$res.body.statement",
"map": {
  "date": "$item.date",
  "posted": "$item.postedFlag = 'Y'",
  "encoding": "'base64'",
  "balance": { "value": "$item.runningBalance.value", "currency": "$item.runningBalance.currency" }
}
```

### Templates

`url`, `ready`, selectors, HTTP headers, and intercept URLs use `{root.path}` templates rather than JSONata expressions.

| Template | Allowed holes |
| --- | --- |
| Document `url`, `ready`, selectors, single HTTP URL/headers, intercept URL | `{params.name}` |
| Chained HTTP source URL and headers | `{params.name}`, `{sources.name.body.path}` for earlier sources |

URL templates percent-encode values (`intercept` patterns also escape `*` as `%2A`), while selectors and headers substitute verbatim.

## Result types and SDKs

Run `lens schema <lens> -c <catalog>` to emit a Draft 2020-12 JSON Schema, and `lens gen ts-sdk <catalog> -o src/lenses.gen.ts` to generate a typed TypeScript client with `LensRef`, `Lenses`, and `createLensClient`. Run `lens <command> --help` for full flags.
