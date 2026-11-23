# Expressions & Templates

Notation Lenses uses two string syntaxes inside lens documents: JSONata **expressions** that transform extracted data and **templates** with `{...}` holes that interpolate values into URLs, headers, and selectors.

## Root variables

Every JSONata expression runs with no implicit input document, so top-level paths must start from a bound variable or helper function. Bare paths such as `title` or `$` fail static validation when the document loads.

Once a step starts at a variable, inner predicates and projections read fields relative to each row:

```json [expressions-example.json]
{
  "items": "$res.body.hits.{ 'id': objectID, 'title': title }",
  "post": "$value[text != null]"
}
```

In `$res.body.hits.{ 'id': objectID, 'title': title }`, the outer path starts at `$res` and the inner fields read relative to each hit. Inside lambda bodies such as `function($v) { $v.text }`, reference the parameter variable `$v` explicitly.

| Site | Bound variables |
| :--- | :--- |
| HTTP or intercept items | `$res`, `$params` |
| Map with items | `$item`, `$res`, `$params` |
| Map without items | `$res`, `$params` |
| Map with sources | `$sources`, `$params` |
| HTTP source items | `$res`, `$sources`, `$params` |
| HTTP source body | `$sources`, `$params` |
| HTTP body and perform values | `$params` |
| DOM post | `$value`, `$params` |
| DOM tier exceptions | `$page`, `$value`, `$params` |
| Document and catalog exceptions | `$page`, `$res`, `$params` |
| Sources tier exceptions | `$sources`, `$params` |
| Parameter default field | `$value` |

For `sources`, `$sources` includes only sources declared earlier in the chain.

For exception `matches` predicates, Lenses evaluates truthiness with JSONata `$boolean` rules, so empty arrays, empty objects, and lambdas evaluate to `false`.

## Template interpolation

URLs, HTTP headers, `ready`, and selectors use `{...}` template holes rather than JSONata expressions. Every hole must name its root, such as `{params.id}` or `{sources.orgs.body.0.uuid}`.

| Context | Interpolation behavior |
| :--- | :--- |
| Lens `url` and HTTP `request.url` | Percent-encoded with `encodeURIComponent` |
| Intercept `request.url` | Percent-encoded with `*` escaped as `%2A` |
| Selectors, `ready`, and HTTP `headers` | Substituted verbatim without escaping |

Escaping `*` as `%2A` in intercept patterns prevents a parameter value from widening the URL wildcard to capture another account's response. Because CSS selectors are inserted verbatim, declare parameters interpolated into selectors as `integer` when the markup allows it.

In chained HTTP `sources`, both `request.url` and `headers` can read earlier responses:

```json [chained-source.json]
{
  "sources": {
    "csrf": { "request": { "method": "GET", "url": "https://example.com/csrf" } },
    "profile": {
      "request": { "method": "GET", "url": "https://example.com/api/{params.org}/me" },
      "headers": { "X-CSRF-Token": "{sources.csrf.body}" }
    }
  }
}
```

## Object vs expression map

A `map` field accepts either an object of per-field expressions or a single JSONata expression string. Use the object form for plain record projections and remember that constant strings require inner JSONata quotes:

```json [object-map.json]
{
  "items": "$res.body.statement",
  "map": {
    "date": "$item.date",
    "posted": "$item.postedFlag = 'Y'",
    "encoding": "'base64'"
  }
}
```

Any object-map field whose expression evaluates to `undefined` is omitted from the resulting object, and fields cannot reference sibling keys in the same object map. Switch to a single expression string when you need local variable bindings, filtering, or cross-field logic.

## Reusable helpers

Declare shared JSONata lambdas under top-level `helpers` and call them as `$name(...)` from any expression in the document:

```json [helpers.json]
{
  "helpers": {
    "money": "function($s) { $number($replace($s, /[^0-9.]/, '')) }"
  },
  "resolve": [
    {
      "kind": "dom",
      "fields": { "raw": { "selector": ".total" } },
      "post": "{ 'amount': $money($value.raw) }"
    }
  ]
}
```

Helpers can read only their own arguments and cannot use reserved variable names such as `res`, `item`, `sources`, or `params`.

Place `helpers` in `catalog.json` to share them across every lens in the directory.

## Testing with `lens eval`

Test JSONata expressions offline against local JSON files or piped output using `lens eval`:

```sh [Terminal]
curl -s https://hn.algolia.com/api/v1/items/1 | lens eval '$res.body.title'
```

| Flag | Effect |
| :--- | :--- |
| `--input <file>` | Reads input JSON from a file instead of stdin |
| `--as <variable>` | Binds input JSON to `$<variable>` instead of `$res.body` |
| `--params <json>` | Binds a JSON object as `$params` |

Use `--as value` to test a DOM `post` expression and `--as item` to test a per-row `map`.

Because `lens eval` runs without loading a lens document, it does not load `helpers` or enforce static validation.

See [Expressions Reference](../reference/expressions.md) for the complete grammar and validation error messages.
