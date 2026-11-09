# Expressions and Templates

A **template** is a string with holes, such as `{params.id}`, each filled with one value. An **expression** is a [JSONata](https://jsonata.org) program that reshapes data, such as a JSON reply, into the value the lens returns. Most examples come from `hn/item`, which takes a story `id`.

## Templates

Build the story page's address from the `id` parameter:

```json
"url": "https://news.ycombinator.com/item?id={params.id}"
```

A hole names its root, `{params.id}` and not `{id}`, and the parameter must be declared. A hole inserts one value as text, so it cannot compute `page + 1`; that needs an expression.

Templates also appear in request URLs, http `headers`, `ready`, dom selectors and perform steps. In a URL, the engine percent-encodes the value; elsewhere it inserts it as written. It does not escape CSS, so a parameter used in a selector is safest declared as an `integer`.

In an http tier with `sources`, a source's `request.url` and `headers` can read an earlier source's reply. Put the organisation id from `claude/usage`'s first reply into its next URL:

```json
"url": "https://claude.ai/api/organizations/{sources.orgs.body.0.uuid}/usage"
```

## Expressions

Wrap the title, URL and score that `hn/item`'s dom tier read into `$value`:

```json
"post": "{ 'story': $value }"
```

Build the next-page link, a follow-up call to the same lens, with an expression for each parameter:

```json
"next_page": {
  "$lens": "@djgrant/hn/item",
  "params": { "id": "$params.id", "page": "$params.page + 1", "limit": "$params.limit" }
}
```

## Expressions have no input

In plain JSONata, a bare path such as `title` reads a field of the input document. **In a lens, there is no input document.** Data comes only from named variables, such as `$res` for an http reply or `$params` for the call parameters. The validator rejects a bare `title` or `$.title` at the top of an expression, because it would read nothing.

After a path starts at a variable, later steps work as in normal JSONata:

```jsonc
"$res.body.hits.{ 'id': objectID, 'title': title }"  // ok: each field reads one hit
"title"                                               // error: must start at a variable
"$map($value, function($v) { $v.text })"              // ok: $v is the lambda argument
```

A lambda body counts as the top of an expression, so inside `function($v) { … }` you write `$v.text` and not `text`.

An expression can call JSONata built-ins, such as `$count`, and the document's helpers. It cannot reach the network or the page.

## Parameters are read as `$params.name`

`hn/item` reads its `limit` parameter as `$params.limit`. Writing `$limit` fails:

```text
resolve[0].items: variable "$limit" is not defined; read the call parameter as $params.limit
```

The validator also rejects `$params.x` when the document declares no parameter `x`.

## Variables at each site

Each site binds a fixed set of variables, and the validator rejects any other. `hn/item`'s http tier reads the Algolia reply as `$res`; its dom tier has no reply, so its `post` reads `$value`.

| Site | Variables |
| --- | --- |
| http or intercept tier `items` and exceptions; intercept source `items` | `$res`, `$params` |
| `map` in a tier with `items` | `$item`, `$res`, `$params` |
| `map` in a tier without `items` | `$res`, `$params` |
| `map` in a tier with `sources` | `$sources`, `$params` |
| http source `items` | `$res`, `$sources` (earlier sources only), `$params` |
| http source `body` values | `$sources` (earlier sources only), `$params` |
| dom `post` | `$value`, `$params` |
| dom tier exceptions | `$page`, `$value`, `$params` |
| http tier `body`; perform `value`; submit `form` values | `$params` |
| document and catalog exceptions | `$page`, `$res`, `$params` |
| sources tier exceptions | `$sources`, `$params` |
| `$lens` reference `params` | `$item`, `$params` |
| parameter default `field` | `$value` |
| `helpers` | the lambda's own arguments |

In `$lens` params, `$item` is the object that holds the reference. `$page` is an object with the page's `url` and `title`.

A reply, in `$res` or `$sources`, has `status`, `url` and `body`. The engine parses `body` as JSON when it can, and otherwise leaves it as text. So `hn/item` reads the title as `$res.body.title`, and its `not_found` exception checks `$res.status = 404`.

If `items`, `map` or `post` produces `undefined` or `null`, the tier misses and the engine tries the next one ([Resolvers](./resolvers.md)).

## Maps

A `map` shapes the value that `items` selected. Shape each comment from the Algolia reply:

```jsonc
"items": "$res.body.children",
"map": {
  "id": "$string($item.id)",
  "author": "$item.author",
  "source": "'algolia'"   // a constant string needs JSONata quotes
}
```

When `items` yields an array, `map` runs once per element, bound as `$item`, and returns an array. A single value runs `map` once as `$item`. A tier without `items` runs `map` once, with only `$res`.

In this object form, a field that yields nothing is left out, and one field cannot refer to another. When the value needs logic across fields, write `map` as one expression string instead.

## Helpers

A helper is a named function that any expression in the document can call as `$name`:

```jsonc
"helpers": { "money": "function($s) { $number($replace($s, /[^0-9.]/, '')) }" },
"post": "{ 'amount': $money($value.raw) }"
```

A helper body reads only its own arguments, so `function($x) { x }` is an error. A helper cannot use a reserved name: `res`, `item`, `sources`, `params`, `value` or `page`. A `catalog.json` can declare helpers for every document in its directory, as [Catalogs](../manual/catalogs.md) explains.

## Validation errors

The validator checks every expression and template when it loads a document, before any call runs. Each message starts with the field's location.

A bare path lists the variables in scope:

```text
resolve[0].items: path "title" must start at a variable ($res, $params); expressions have no implicit input
```

A variable the site does not bind lists the ones it does:

```text
resolve[1].post: $res is not available here; in scope: $value, $params
```

A template hole without its root suggests the fix:

```text
url: hole "{id}" must name its root; write "{params.id}"
```

## Testing with `lens eval`

Run an expression in the lens sandbox against a reply, with no browser or catalog:

```sh
curl -s https://hn.algolia.com/api/v1/items/1 | lens eval '$res.body.title'
```

`lens eval` binds the input as `$res.body` by default. `--as value` tests a dom `post`, `--as item` a per-row `map`, and `--params` binds `$params`.

It does not run the validator or load helpers, so a bare `title` prints `null` instead of an error. The [CLI reference](./cli.md) lists every option.
