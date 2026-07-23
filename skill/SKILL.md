---
name: lenses
description: Read live web pages as typed function calls through the lens CLI. Use when a task needs data from a website the user is signed into, or when authoring a new lens for an unmapped page.
---

# Lenses

A lens turns a webpage into a typed function. Calls run through the user's own
browser over Chrome's remote-debugging protocol, so signed-in sessions work
without exporting cookies. Lenses observe what a page already does — they cannot click, type,
navigate sequences, or fire requests.

Every command prints JSON to stdout and exits non-zero on errors. Pass a catalog
directory with `--catalog <path>` (or ask the user where their lens catalog is).

## Calling a lens

```sh
lens status --wait-ms 5000        # check the browser is reachable
lens list --catalog ./examples    # discover lenses, their params and outcomes
lens call hn/item --params '{"id":"42"}' --catalog ./examples
```

If `status` reports the browser is unreachable, Chrome is probably not running,
or remote debugging is off. Launch Chrome — on macOS
`open -na "Google Chrome" --args --profile-directory=Default`, or the equivalent
on other operating systems — and ask the user to enable
`chrome://inspect/#remote-debugging` if it still fails, then retry `status`.
The first call may show a permission dialog in Chrome; the user must click
Allow.

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
   except `params` and `outcomes`; `effects` in particular is mandatory.
   Resolver tiers run in order and accumulate fields until `returns` is
   satisfied:
   - `intercept` — map a JSON response the page already fetched (preferred).
   - `dom` — CSS selectors, optionally a repeating `item` selector.
   - `llm` — last resort; returns the snapshot and prompt to you.

   ```jsonc
   {
     "name": "@scope/site/thing",
     "url": "https://site.com/{id}",
     "params": { "id": "string" },
     "returns": { "type": "object", "fields": { "title": "string" } },
     "outcomes": { "needs_auth": { "$lens": "@scope/site/login" } },
     "effects": { "reads": ["site.com"], "writes": [], "idempotent": true },
     "resolve": [
       { "kind": "intercept",
         "request": "GET https://site.com/api/thing/*",
         "detect": { "needs_auth": "status = 401" },
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
       "score": { "selector": ".score", "sibling": true } },
     "post": "$[[0..$limit - 1]]" }
   ```

   Field specs: `selector` (first match wins; `":self"` reads the item
   element itself), `attr` (read an attribute instead of text; `href`/`src`
   are absolutised), `sibling: true` (search `item.nextElementSibling`, for
   split-row layouts). A field matching nothing is `null`; declare it
   `nullable` in `returns` or coerce to `null` in `map`, since `undefined`
   fails a non-nullable field.

   Return only what the caller needs — a lens that emits every row bloats every
   call. Declare a `limit` param and slice in `post` (or `map`), since params
   are JSONata variables:

   ```jsonc
   "params": { "limit": { "type": "integer", "default": 5 } },
   // in a resolver: "post": "$[[0..$limit - 1]]"
   ```

4. Call it by file path to test: `lens call ./my-lens.json --catalog .`

`map`, `post`, and `detect` are sandboxed JSONata: no network or DOM
access. Declared params are available as variables (`$id`) in URL templates
and every expression.

## Result types

Run `lens schema <lens>` to get a JSON Schema (draft 2020-12) of a lens's
result. Use it to validate stored results, wire a lens into schema-driven
tooling, or check the exact result shape without making a call.

## Generated SDK

Run `lens gen ts-sdk -o src/lenses.gen.ts` to generate a typed TypeScript
client for the catalog. Use it to call lenses from application code with
typed params and results. Re-run after editing a lens.

Run `lens <command> --help` for full options.
