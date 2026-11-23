# Lens Document

A lens document is a JSON file that declares one webpage function for Notation Lenses, including its target URL, inputs, return schema, side effects, and resolution tiers. Lenses validates every document strictly when loading it.

Every schema object in a lens document rejects unknown keys. Legacy top-level or resolver `detect` and `outcomes` keys fail validation with migration errors pointing to `exceptions`.

## Top-level fields

The root object requires `name`, `url`, `effects`, and `resolve`.

| Field | Description |
| :--- | :--- |
| `name` | Scoped lens identifier required on every document |
| `description` | Human and agent summary shown in listings and MCP tools |
| `url` | Required absolute URL template navigated before browser tiers run |
| `params` | Declared caller input parameters |
| `returns` | Output shape contract validated against every resolved result |
| `$defs` | Reusable named object schemas referenced from `returns` |
| `effects` | Required host read, write, idempotency, and cache declaration |
| `resolve` | Required non-empty array of fallback resolver tiers |
| `exceptions` | Named page or response predicates that return outcomes |
| `perform` | Non-empty array of browser steps run before `resolve` tiers |
| `helpers` | Named JSONata lambda functions available in expressions |
| `tab` | Set to `"reuse"` to keep and reuse one tab per origin |
| `navigate` | Set to `"in-page"` to route via `history.pushState` without reloading |
| `ready` | Non-empty CSS selector template awaited after navigation |
| `loadTimeoutMs` | Positive integer timeout in milliseconds for load and `ready` |

When `loadTimeoutMs` is omitted, Lenses uses `30000` milliseconds. See [Resolvers & Perform](./resolvers.md) for `perform` steps and `resolve` tiers.

## `name` and `url`

`name` must match the scoped three-segment pattern `/^@[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/`, naming owner, site, and lens. Catalog loaders also expose the short `site/lens` name.

`url` must parse as an absolute URL after replacing `{...}` template holes with placeholder text. Holes in `url` use `{params.<name>}` syntax and are percent-encoded before navigation.

```json [hn.top.json]
{
  "name": "@djgrant/hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}"
}
```

## `params`

Each entry in `params` maps a parameter name to a primitive type string or an object declaration. Parameters without `default` are required from callers.

| Key | Description |
| :--- | :--- |
| `type` | Required primitive type `"string" \| "number" \| "integer" \| "boolean"` |
| `default` | Literal matching `type`, or a lens-backed default object |
| `enum` | Non-empty array of allowed strings |

The `enum` field is valid only when `type` is `"string"`. A literal `default` must appear in the enum list when one is declared.

A lens-backed `default` calls `$lens` and evaluates `field` over `$value`. Any parameters passed to the default lens must be literal strings, numbers, or booleans.

```json [params-example.json]
{
  "params": {
    "id": "string",
    "page": { "type": "integer", "default": 1 },
    "org": {
      "type": "string",
      "default": {
        "$lens": "@acme/app/account",
        "field": "$value.org_id",
        "params": { "env": "prod" }
      }
    }
  }
}
```

## `returns` and `$defs`

`returns` defines the schema checked against every resolved value. All declared object fields are required unless marked nullable, while undeclared keys on objects pass through validation.

| Schema node | Meaning |
| :--- | :--- |
| `"string" \| "number" \| "integer" \| "boolean" \| "null"` | Primitive JSON value |
| `{ "type": "<primitive>", "nullable": true }` | Primitive value or `null` |
| `{ "$lens": "<name>", "params"?: {...} }` | Lazy follow-up lens reference |
| `{ "$ref": "<name>" }` | Reference to an entry in `$defs` |
| `{ "type": "object", "fields"?: {...} }` | Object with required field map |
| `{ "type": "array", "items"?: <field map> \| { "$ref": "<name>" } }` | Array of mapped objects or referenced items |
| `{ "type": "file" }` | Top-level file download result |

`{ "type": "file" }` is valid only as the root `returns` value and cannot appear nested inside objects, arrays, or `$defs`. File lenses save bytes to disk and resolve to `{ path, name, mimeType, bytes }` on the client.

Array `items` expects a bare field map directly inside `items` rather than a nested object wrapper, unless `items` is a `$ref` node.

Omitting `fields` on an object or `items` on an array allows arbitrary values of that container type.

A `$lens` node evaluates its parameter expressions against `$item` and `$params`. Lenses materialises the reference automatically, or settles it to `null` when required sibling values are missing.

Top-level `$defs` holds named object schemas for recursive structures such as nested comment trees. Every `$ref` target must name an existing key in that map.

```json [hn.comment.json]
{
  "$defs": {
    "comment": {
      "type": "object",
      "fields": {
        "id": "string",
        "text": "string",
        "replies": {
          "type": "array",
          "items": { "$ref": "comment" }
        }
      }
    }
  },
  "returns": { "$ref": "comment" }
}
```

## `effects`

`effects` declares what hosts and sites a lens reads or modifies so runtimes can enforce write consent and response caching.

| Field | Description |
| :--- | :--- |
| `reads` | Required array of domain or resource strings read by the lens |
| `writes` | Required array of mutation targets, or `[]` for read-only lenses |
| `idempotent` | Optional boolean indicating safe retries |
| `cache` | Optional non-negative cache lifetime in seconds |

By default, `idempotent` is false and `cache` is 0.

Any lens with non-empty `writes` counts as a write, requiring `--allow-writes` at runtime and forbidding a positive `cache` value.

## `exceptions`

`exceptions` maps outcome names to match rules or `null`. When a predicate evaluates to true, Lenses stops resolution and returns an `outcome` result instead of a value.

| Field | Description |
| :--- | :--- |
| `matches` | JSONata predicate string, or `null` to clear an inherited match |
| `hint` | Instruction string returned to the caller or agent |
| `$lens` | Target lens name returned as the outcome value |
| `params` | Map of JSONata expressions building parameters for `$lens` |

Setting an exception entry to `null` disables an inherited rule from `catalog.json`. Exception names starting with `needs_` keep the browser tab open so a user can complete sign-in or approval steps.

## `helpers`

`helpers` maps function names to JSONata lambda strings bound as `$name` in every expression across the document. Helper lambdas receive only their own arguments and cannot use any reserved variable name listed in [Expressions & Templates](./expressions.md).

```json [helpers-example.json]
{
  "helpers": {
    "money": "function($s) { $number($replace($s, /[^0-9.]/, \"\")) }"
  }
}
```

## `catalog.json`

A `catalog.json` file placed beside lens documents shares configuration across that directory without acting as a lens itself.

| Field | Description |
| :--- | :--- |
| `helpers` | Shared helper lambdas inherited by every document |
| `params` | Shared parameter declarations inherited by every document |
| `scopes` | Ordered list of URL-matched settings applied to matching documents |

Each entry in `scopes` requires a `*`-only `url` glob and optional tab, navigation, or exception overrides. Document parameters, helpers, tab settings, and navigation rules replace catalog entries by name, while `exceptions` merge field by field across matching scopes and the document.

See [Catalogs](../core/catalogs.md) for catalog discovery and [Navigation & Auth](../authoring/navigation-and-auth.md) for sign-in flows.
