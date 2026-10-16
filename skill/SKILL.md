---
name: lenses
description: Read live web pages as typed function calls through the lens CLI. Use when a task needs data from a website the user is signed into, or when authoring a new lens for an unmapped page.
---

# Lenses

A lens turns a webpage into a typed function. Calls run through the user's own browser, preferring Microsoft's Playwright Extension (tab-group CDP relay) and falling back to Chrome's remote-debugging protocol, so signed-in sessions work.

## CLI Behaviour

Every command prints JSON to stdout and exits non-zero on errors. 

Pass a catalog directory with `--catalog <path>` (or ask the user where their lens catalog is).

## Calling a lens

```sh
lens list --catalog ./examples    # discover lenses, their params and exceptions
lens call hn/item --params '{"id":"42"}' --catalog ./examples
```

`call` and `observe` automatically start or reconnect the configured browser when needed. Treat the operation's result as authoritative; ask the user to take browser or sign-in action only when its error or structured outcome requires it.

A call result is one of:

- `{"kind": "value", "value": ...}` — the typed result. Fields may contain
  `$lens` references: a ready-made follow-up call (lens name + evaluated
  params) for things like pagination. Call it next instead of guessing URLs.
- `{"kind": "outcome", "name": ...}` — a declared non-happy path such as
  `needs_auth`, optionally carrying the lens that resolves it. An
  `agent_extract` outcome contains the page snapshot and an extraction
  prompt: extract the declared `returns` shape from the snapshot yourself.
- `{"kind": "error", "message": ..., "issues": [...]}` — `issues` names
  failing JSON pointers when the value violated the lens's schema. Retry with
  `--lax` to receive the value with warnings instead.

A result whose tab stays open carries `"tab": "t1"`, a broker id for that tab.
Pass it back to target the same tab: `lens call <lens> --tab t1`, or
`lens observe --tab t1` to read it where it is (add a URL to route it there
in-page first). A closed tab fails with `code: "tab_closed"`; nothing opens a
replacement.

## Write lenses

A lens with a `perform` block acts on the page: its steps (fill, click, native form submit, press, drop, wait, navigate) run once, then the resolve tiers read the result in the same call. Mutating HTTP methods (anything except GET, HEAD, or OPTIONS) are writes too. Calling either kind requires `--allow-writes`; otherwise it is refused with `code: "writes_not_allowed"`. Check `effects.idempotent` first — a non-idempotent write (e.g. sending a message) sends twice on a manual retry. `performed: true` specifically means every `perform` step ran and the page write happened, even if the result itself is an error; `code: "perform_failed"` with a `step` index means it did not. The pattern, on logged-out chatgpt.com:

```sh
lens call chatgpt/send --params '{"message":"hello"}' --allow-writes   # fills, clicks, waits, returns the transcript
lens call chatgpt/clear --allow-writes                                  # navigate "fresh" discards the anonymous chat
lens call chatgpt/chat                                                  # plain read; no flag needed
```

Authoring one: every write requires non-empty `effects.writes` and `cache` 0 or absent; `perform` permits `idempotent: true` only when every step is a navigate. A drop attaches a local file the way a drag from the desktop would: `{ "drop": "#editor", "file": "path" }` names a declared string param with no default, the caller passes an absolute path, and the host drops that file onto the first visible match. HTTP request bodies are declared as `{ "json": expr }`, `{ "text": expr }`, `{ "form": { field: expr } }`, or `{ "search": { field: expr } }`. A native form action is `{ "submit": "#form", "form": { "field[name]": expr } }`; its field expressions become literal named controls before `requestSubmit()`. The expressions run over params and earlier HTTP source bindings. Keep a page read as its own lens (like `chatgpt/chat`) and give a perform lens the same tiers as its readback.

## Authoring a lens for an unmapped page

1. Observe the page:

   ```sh
   lens observe https://example.com/page --wait-ms 4000 --html
   ```

   This returns the JSON requests the page fired, a text snapshot, and (with
   `--html`) stripped body markup for writing CSS selectors.

2. Iterate JSONata offline against a captured response before it goes in a
   document:

   ```sh
   lens eval '[stories.{ "t": title }]' --input sample.json
   ```

3. Write a JSON lens document into the catalog. Every field below is required
   except `params` and `exceptions`; `effects` in particular is mandatory.
   Resolver tiers run in order and accumulate fields until `returns` is
   satisfied:
   - `http` — direct requests to a JSON API, no page bound (preferred when a
     public or cookie-authenticated endpoint exists). `request` is
     `"METHOD url-template"` (defaults to `GET` of the lens `url`); `items`/`map`
     shape the body; `credentials: true` sends browser cookies through any
     capable backend, while `credentials: "same-origin-page"` requires execution
     in an already-open page matching the request origin. Sources may override
     credentials and define JSONata headers using earlier bindings. `sources`
     chains requests: each binds `$name` for `map`/`matches`, and later templates address
     earlier bodies with dotted holes — `{orgs.0.uuid}` — which is how an id
     only another response knows reaches a URL.
   - `intercept` — map a JSON response the page already fetched. The
     `request` pattern takes `{param}` holes, so a per-account lens matches
     only that account's response.
   - `dom` — CSS selectors, optionally a repeating `item` selector.
   - `llm` — last resort; returns the snapshot and prompt to you.

   ```jsonc
   {
     "name": "@scope/site/thing",
     "url": "https://site.com/{id}",
     "params": { "id": "string" },
     "returns": { "type": "object", "fields": { "title": "string" } },
     "exceptions": { "needs_auth": { "matches": "status = 401", "$lens": "@scope/site/login" } },
     "effects": { "reads": ["site.com"], "writes": [], "idempotent": true },
     "resolve": [
       { "kind": "intercept",
         "request": "GET https://site.com/api/thing/*",
         "map": { "title": "data.title" } }
     ]
   }
   ```

   For a list, `returns` is `{"type": "array", "items": {...}}` where `items`
   is a **bare field map** — field names straight to types, NOT a nested
   `{ "type": "object", "fields": ... }` object (that nesting would silently
   declare literal `type`/`fields` fields and every row fails validation):

   ```jsonc
   "returns": {
     "type": "array",
     "items": { "title": "string", "score": { "type": "integer", "nullable": true } }
   }
   ```

   For a recursive shape (a comment tree), declare the repeating object once under top-level `$defs` and point at it with `{"$ref": "<name>"}` — a def may reference itself:

   ```jsonc
   "$defs": {
     "comments": { "type": "object", "fields": {
       "author": "string", "text": "string",
       "replies": { "type": "array", "items": { "$ref": "comments" } } } }
   },
   "returns": { "type": "object", "fields": {
     "comments": { "type": "array", "items": { "$ref": "comments" } } } }
   ```

   A `dom` tier reads the rendered page. It takes `fields` (selector specs)
   and optionally `post` (JSONata over the extracted value) — there is no
   `map` key; `map` belongs to `intercept` tiers. With a repeating `item` selector it
   yields one object per match, each `fields` selector scoped to that element:

   ```jsonc
   { "kind": "dom",
     "item": "tr.athing",
     "fields": {
       "title": { "selector": ".titleline > a" },
       "url": { "selector": ".titleline > a", "attr": "href" },
       "score": { "selector": ".score", "scope": "+" } },
     "post": "$[[0..$limit - 1]]" }
   ```

   Field specs: `selector` (first match wins; `":self"` reads the item
   element itself), `attr` (read an attribute instead of text; `href`/`src`
   are absolutised), and `scope`, which moves the element the selector runs
   from. A field matching nothing is `null`; declare it `nullable` in
   `returns` or coerce to `null` in `map`, since `undefined` fails a
   non-nullable field.

   `scope` covers the two things a row cannot see. `"+"` (or `"+ sel"`, which
   also requires the sibling to match) crosses to the next element sibling, for
   split-row layouts: HN's story/subtext rows, or a definition list where
   `"item": "dt"` zips each `dt` with its `dd`. Any other value is an ancestor
   selector resolved with `closest()`, which is how a row reaches context that
   lives above it — a tax year on the tab panel wrapping the table, rather than
   recovered from row text:

   ```jsonc
   "fields": { "year": { "selector": ".year-heading", "scope": ".tab-panel" } }
   ```

   (`sibling: true` is the older spelling of `"scope": "+"` and still works.)

   A field without `attr` reads the element's **rendered text**, so a `<br>`
   separates its two sides instead of joining them. Whitespace runs — including
   the `&nbsp;` that content-managed markup is dense with — are collapsed to
   single spaces and the result is trimmed. Do not write your own normalising
   helper; it is already done. Note the two empty cases are different: `""`
   means the element is there and blank, `null` means the selector matched
   nothing.

   Tiers accumulate, so a page with a summary *and* a list is one lens, not
   two. A tier with `item` yields an array as its whole value — name it in
   `post`, and the fields-only tier merges alongside it:

   ```jsonc
   "returns": { "type": "object", "fields": {
     "total": "number",
     "rows": { "type": "array", "items": { "period": "string" } } } },
   "resolve": [
     { "kind": "dom", "fields": { "total": { "selector": ".total" } },
       "post": "{ 'total': $number(total) }" },
     { "kind": "dom", "item": ".row", "fields": { "period": { "selector": ".period" } },
       "post": "{ 'rows': $ }" }
   ]
   ```

   Declare exceptions in one place, with the predicate first and the recovery
   advice beside it. A scope in `catalog.json` shares an exception across all
   lens URL templates matching its `*`-only glob:

   ```jsonc
   { "scopes": [{ "url": "https://*.site.com/*", "exceptions": {
     "needs_auth": {
       "matches": "$contains(url, '/sign-in') or status = 401",
       "hint": "Sign in, then retry."
     }
   } }] }
   ```

   The shared matcher checks each page (`{url, title}`) and each response
   (`{status, url, body}`), even each named source before the next request.
   A lens can merge additional fields into the inherited entry or set the
   entire key to `null` to disable it. Resolver `exceptions` add tier-local
   matching over named `$source` contexts and run before inherited matchers;
   they do not replace them. `matches: null` disables only an inherited
   predicate. Legacy `detect` and `outcomes` fields are rejected.

   A `returns` field may itself declare a `$lens` reference, so a row carries a
   ready-made follow-up call. Declaring it is enough — no resolver needs to emit
   the key, because the reference is built from the row's other fields:

   ```jsonc
   "returns": { "type": "array", "items": {
     "period": "string",
     "detail": { "$lens": "@scope/site/detail", "params": { "period": "period" } } } },
   // the tier extracts `period` only; `detail` materialises from it
   ```

   A row whose `params` do not bind — `period` is null, so there is nothing to
   follow — gets `detail: null`, which is valid against the field. Emit the key
   yourself only to override that per row: an explicit `null` suppresses the
   reference, and a `{$lens, params}` object you build in `post` is kept as
   written.

   Return only what the caller needs — a lens that emits every row bloats every
   call. Declare a `limit` param and slice in `post` (or `map`), since params
   are JSONata variables:

   ```jsonc
   "params": { "limit": { "type": "integer", "default": 5 } },
   // in a resolver: "post": "$[[0..$limit - 1]]"
   ```

   A default may also come from another lens: `{"$lens": ..., "field": ...,
   "params"?: {...literals}}` calls the target when the caller omits the key and
   uses the named top-level field of its result. Use it for identity-like values
   the caller should not have to know — an account number a summary page already
   shows:

   ```jsonc
   "params": { "vrn": { "type": "string",
     "default": { "$lens": "@scope/site/summary", "field": "vrn" } } },
   ```

   The target field must be a non-nullable primitive matching the param type,
   and a target that errors or returns an outcome fails the call rather than
   guessing. Prefer a cached target (`effects.cache`) — the default costs a
   lens call whenever the caller omits the key. This form is a parameter
   default only; `field` is not valid on a `returns` reference.

   Selectors take the same `{name}` holes as `url`, so a page that keys its
   markup by a parameter needs no post-hoc recovery of that value from row text:

   ```jsonc
   "params": { "year": "integer" },
   // in a dom tier: "item": "#past-payments-{year} .row"
   ```

   The value is substituted verbatim — a selector is not a URL and must not be
   percent-encoded — so declare such a param as `integer` where the page allows
   it. An undeclared hole is rejected at validation, not at runtime.

   A repeated expression belongs in `helpers`, as a named JSONata lambda bound
   as `$name` in every expression the document evaluates:

   ```jsonc
   "helpers": { "money": "function($s) { $number($replace($s, /[^0-9.]/, \"\")) }" },
   // in a tier: "post": "{ 'amount': $money(raw) }"
   ```

   Put the same block in a `catalog.json` beside your documents and every
   document in that directory gets it. That is the point: a helper pasted into
   thirteen documents has to be fixed thirteen times and re-checked against
   thirteen live pages. A document's own `helpers` entry overrides the
   catalogue's, and a declared param of the same name shadows both.

   Some sites hold their session in the open tab rather than in cookies: any
   fresh load or reload lands on the login page. Give their scope two
   settings (a document may also set them itself):

   ```jsonc
   { "scopes": [{ "url": "https://bank.example/*",
     "tab": "reuse",          // run in the tab this origin used last; never close it
     "navigate": "in-page",   // reach the lens URL with pushState + popstate, never a load or reload
     "exceptions": { "needs_auth": { "matches": "$contains(url, '/login')" } } }] }
   ```

   The first call opens a tab, `needs_auth` holds it while the user signs in,
   and every later call routes that same tab. With the Playwright extension,
   only tabs in its tab group are reused: when the broker restarts or loses
   its connection the extension ungroups them, and the next call opens a new
   tab. Drag the signed-in tab back into the group first to keep using it.
   A tab whose current page already matches a `needs_*` exception is never
   navigated; the call reports the outcome and brings the tab to the front
   instead. Tab ids (`t` + Chrome tab id) stay valid while the tab is open
   and in the group.

   Such apps often keep rendering after `load`: a transient error screen, a
   timed redirect to sign-in. Give the document a `ready` selector unique to
   its page (`"ready": "ibank-account-card"`); after navigating, tiers wait
   until it matches or the page matches a `needs_*` exception, up to
   `loadTimeoutMs`. Without one there is no extra wait. Intercept tiers
   already wait for their response, so `ready` matters most to dom tiers.

   An app can render an error or sign-in screen at the requested URL under an
   unchanged title. A dom tier's own exceptions also see what it extracted, as
   `value`: `"exceptions": { "needs_auth": { "matches": "$contains($string(value.heading), 'unable to continue')" } }`. Author against it with
   `lens observe --tab <id>`, never a bare `lens observe <url>`, which loads a
   fresh document and signs the session out.

4. Call it by file path to test: `lens call ./my-lens.json --catalog .`

`map`, `post`, and `matches` are sandboxed JSONata: no network or DOM
access. Declared params are available as variables (`$id`) in every
expression, and as `{name}` holes in `url` and in selectors.

The broker logs to `~/.cache/lenses/broker.log` (connections, tab reuse,
debugger detaches); read it when a call behaves unexpectedly.

## Result types

```sh
lens schema <lens>
```

Prints a JSON Schema (draft 2020-12) of a lens's result.
Use it to validate stored results, wire a lens into schema-driven tooling, or check the exact result shape without making a call.

## Generated SDK

```sh
lens gen ts-sdk -o src/lenses.gen.ts
```

Generates a typed TypeScript client for the catalog.
Use it to call lenses from application code with typed params and results.
Re-run after editing a lens.

Run `lens <command> --help` for full options.
