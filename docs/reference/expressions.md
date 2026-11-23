# Expressions & Templates

Notation Lenses uses two string languages inside lens documents: `{...}` **templates** for URLs, headers, and selectors, and [JSONata](https://jsonata.org) **expressions** for data transformation, request payloads, and exception predicates.

## Templates and holes

Template strings interpolate scalar values from call parameters and earlier chained HTTP sources. Every hole must name its root using `{params.<name>}` or `{sources.<name>.<path>}` syntax.

Lenses expands templates through three functions depending on where the template appears:

| Function | Escaping behavior |
| :--- | :--- |
| `expandUrl` | Percent-encodes each value with `encodeURIComponent` for lens and HTTP URLs |
| `expandRequestPattern` | Percent-encodes each value and replaces `*` with `%2A` for intercept patterns |
| `expandTemplate` | Inserts each value verbatim for `ready`, selectors, headers, and perform steps |

Escaping `*` as `%2A` prevents a parameter from widening an intercept URL glob to match another item or account. Because `expandTemplate` does not escape CSS syntax, declare parameters interpolated into selectors as integers when possible.

```json [template-holes.json]
{
  "url": "https://claude.ai/api/organizations/{sources.orgs.body.0.uuid}/usage",
  "headers": {
    "X-Org-Id": "{params.org}"
  }
}
```

At runtime, `{sources.<name>.<path>}` is available only inside chained HTTP source URLs and headers, reading responses from earlier sources. Missing or non-scalar hole targets throw an error during expansion.

## JSONata evaluation and root rules

Lenses evaluates every JSONata expression with an `undefined` root input context rather than an implicit JSON document. All top-level paths must start at a bound variable or helper function.

| Construct | Validation behavior |
| :--- | :--- |
| `title` | Bare root paths fail because expressions have no implicit input |
| `$` | Rejected at root because no input context exists |
| `$$` | Rejected everywhere because no root document exists |
| `*` | Rejected at root unless preceded by a variable-rooted step |
| `**` | Rejected at root unless preceded by a variable-rooted step |
| `%` | Rejected at root unless preceded by a variable-rooted step |

Once a path starts from a variable, inner predicates, projections, sort terms, group-by clauses, and transform clauses evaluate relative to that step's items. Lambda bodies keep the outer scope, so inside `function($v) { ... }` you must reference `$v` or another bound variable.

```text [Relative inner paths]
$res.body.hits.{ "id": objectID, "title": title }
$map($value, function($v) { $v.text })
```

Boolean predicates such as exception `matches` use JSONata `$boolean` truthiness. Empty arrays, empty objects, and lambda functions evaluate to `false`, whereas JavaScript treats them as truthy.

Expressions may call any of the 65 whitelisted JSONata built-in functions alongside helpers declared on the document or catalog.

## Reserved variables

Lenses reserves six variable names across expression sites and binds each site to a fixed subset.

| Variable | Value |
| :--- | :--- |
| `$res` | Response envelope with `status`, `url`, and parsed `body` |
| `$item` | Current element during `map` iteration or `$lens` reference binding |
| `$sources` | Map of named response envelopes in a `sources` tier |
| `$params` | Resolved caller input parameters |
| `$value` | Extracted DOM value in `post`, or target result in a lens default |
| `$page` | Page metadata object with `url` and `title` |

When a response body is valid JSON, Lenses parses it into `body` automatically and leaves non-JSON responses as text.

## Variables by site

Static validation checks every expression against the variables bound at its site.

| Site | Variables |
| :--- | :--- |
| Single-request HTTP or intercept items | `$res`, `$params` |
| Map in a tier with items | `$item`, `$res`, `$params` |
| Map in a tier without items | `$res`, `$params` |
| Map in a tier with sources | `$sources`, `$params` |
| HTTP source items | `$res`, `$sources`, `$params` |
| HTTP source body | `$sources`, `$params` |
| Intercept source items | `$res`, `$params` |
| Single-request HTTP body | `$params` |
| Perform fill and submit values | `$params` |
| DOM post | `$value`, `$params` |
| DOM tier exceptions | `$page`, `$value`, `$params` |
| Single-request HTTP or intercept exceptions | `$res`, `$params` |
| Sources tier exceptions | `$sources`, `$params` |
| Document and catalog exceptions | `$page`, `$res`, `$params` |
| Lens reference params | `$item`, `$params` |
| Parameter default field | `$value` |
| Helper lambda body | None |

In HTTP source `items` and `body`, `$sources` includes only sources declared earlier in the chain.

When a tier exception entry omits `matches`, its `params` expressions also inherit `$page` and `$res` from document exceptions.

Helper lambdas have zero root context variables and read only their own arguments.

## `map` projections

A `map` field accepts either a single JSONata expression string or an object mapping output keys to expressions and nested map objects.

```json [map-forms.json]
{
  "items": "$res.body.children",
  "map": {
    "id": "$string($item.id)",
    "author": "$item.author",
    "source": "'algolia'"
  }
}
```

In the object form, constant string literals require inner JSONata quotes, sibling keys cannot reference each other, and any key whose expression evaluates to `undefined` is omitted from the output object. Use a single expression string when you need local variables, filtering, or cross-field logic.

If `items`, `map`, or `post` evaluates to undefined or `null`, the tier counts as a miss.

## `helpers`

Top-level `helpers` entries compile as cached JSONata lambdas bound as `$name` before site variables are applied.

```json [helpers-definition.json]
{
  "helpers": {
    "norm": "function($s) { $trim($lowercase($s)) }"
  }
}
```

Validation rejects any helper whose name collides with a reserved variable or whose body reads anything outside its own arguments, local bindings, and whitelisted built-ins.

## Validation errors

Lenses validates every expression and template when loading a document and prefixes each error with the failing field path.

```text [Validation diagnostics]
resolve[0].items: path "title" must start at a variable ($res, $params); expressions have no implicit input
resolve[1].post: $res is not available here; in scope: $value, $params
resolve[0].items: variable "$limit" is not defined; read the call parameter as $params.limit
resolve[0].sources.first.items: $sources.second is not available yet; a source sees only the sources declared before it
url: hole "{id}" must name its root; write "{params.id}"
```

Syntax failures report `<site> expression does not parse` followed by the JSONata parser error. Undeclared `$params.<name>` lookups and future `$sources.<name>` references also fail before any browser work starts.

## Testing with `lens eval`

Run `lens eval` to test an expression locally in the same undefined-root sandbox without opening a browser or loading a catalog.

```sh [Terminal]
curl -s https://hn.algolia.com/api/v1/items/1 | lens eval '$res.body.title'
```

| Flag | Behavior |
| :--- | :--- |
| `--input <file>` | Reads JSON input from a file instead of stdin |
| `--as <variable>` | Binds input JSON directly to `$<variable>` |
| `--params <json>` | Binds a JSON object as `$params` |

Without `--as`, input JSON is bound as `$res.body`.

Pass `--as value` to test a DOM `post` expression, or `--as item` to test a per-row `map`.

Because `lens eval` runs outside a lens document, it does not bind `helpers` or run static AST validation. When an expression yields nothing, it writes `expression produced no result` to stderr and prints `null` to stdout.
