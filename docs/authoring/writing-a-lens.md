# Writing a Lens

Notation Lenses turns a live web page or API into a typed JSON document that runs against your browser session. This guide builds `hn-top.json` matching `examples/hn.top.json` from page inspection to schema validation.

## Observing the page

Start by inspecting the target page to see whether its data arrives in JSON requests or rendered HTML:

```sh [Terminal]
lens observe https://news.ycombinator.com/news --html
```

The command returns a `snapshot` with the page text and stripped body HTML, plus a `requests` index of JSON replies fetched during load.

On JavaScript-rendered sites that load data from an API, pass `--request` with a request index or URL substring to print the full reply body. Hacker News renders on the server, so no JSON request holds the stories.

In the HTML output, each story row is a `tr` with class `athing`, its title link sits in `.titleline > a`, and its score sits in `.score` on the following sibling row.

## Testing expressions offline

Lenses transforms extracted data with JSONata expressions. Test an expression locally with `lens eval` before adding it to a document:

```sh [Terminal]
lens eval --as value '{ "stories": $value }' --input rows.json
```

Expressions have no implicit input, so every root path must start from a bound variable. Passing `--as value` binds the JSON as `$value` to match a DOM `post` expression, while omitting it binds the input as `$res.body`.

## Building the lens document

Create `hn-top.json` and declare its identity, parameters, return contract, side effects, and resolvers.

### Name, URL, and parameters

Set a scoped three-part `name`, a `url` template, and an optional `page` parameter defaulting to `1`:

```json [hn-top.json]
{
  "name": "@djgrant/hn/top",
  "description": "Front-page stories on Hacker News.",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": {
    "page": {
      "type": "integer",
      "default": 1
    }
  }
}
```

The `{params.page}` hole interpolates the `page` parameter into the URL before navigation.

### Returns and effects

Declare `returns` so Lenses validates every result, and declare `effects` to record host reads, writes, and caching:

```json [hn-top.json]
{
  "returns": {
    "type": "object",
    "fields": {
      "stories": {
        "type": "array",
        "items": {
          "title": "string",
          "url": "string",
          "id": "string",
          "score": { "type": "string", "nullable": true },
          "comments": { "type": "string", "nullable": true },
          "item_url": {
            "$lens": "@djgrant/hn/item",
            "params": { "id": "$item.id" }
          }
        }
      },
      "next_page": {
        "$lens": "@djgrant/hn/top",
        "params": {
          "page": "$number($substringAfter($item.next_page, 'p='))"
        }
      }
    }
  },
  "effects": {
    "reads": ["news.ycombinator.com"],
    "writes": [],
    "idempotent": true,
    "cache": 60
  }
}
```

Both `reads` and `writes` are required even when the lens performs no mutations.

Mark `score` and `comments` as nullable because Hacker News job posts omit both fields.

### Resolvers

Add the `resolve` array with a repeating DOM tier for `stories`, a page-level DOM tier for `next_page`, and an `llm` fallback:

```json [hn-top.json]
{
  "resolve": [
    {
      "kind": "dom",
      "item": ".athing",
      "fields": {
        "id": { "selector": ":self", "attr": "id" },
        "title": { "selector": ".titleline > a" },
        "url": { "selector": ".titleline > a", "attr": "href" },
        "score": { "selector": ".score", "scope": "+" },
        "comments": { "selector": ".subline > a:last-child", "scope": "+" }
      },
      "post": "{ \"stories\": $map($value, function($v) { $merge([$v, {\"item_url\": $v.id}]) }) }"
    },
    {
      "kind": "dom",
      "fields": {
        "next_page": { "selector": "a.morelink", "attr": "href" }
      }
    },
    {
      "kind": "llm",
      "prompt": "Extract {stories, next_page} from this Hacker News front page."
    }
  ]
}
```

The first tier iterates `.athing` rows and uses `"scope": "+"` to read scores and comment counts from each row's next sibling element.

The second tier supplies `next_page`, and Lenses merges both objects into the final result.

See [Resolvers & Fallbacks](./resolvers-and-fallbacks.md) for how tiers combine and when to prefer HTTP or intercept resolvers.

## Calling and validating the file

Run the document directly by path while passing a catalog directory:

```sh [Terminal]
lens call ./hn-top.json --catalog .
```

The CLI requires `--catalog` even when calling a local file path. A successful call prints JSON with `"kind": "value"` and the validated `value` object.

Validate the document and inspect its draft 2020-12 JSON Schema without opening a browser:

```sh [Terminal]
lens schema ./hn-top.json --catalog .
```

If the document is invalid, `lens schema` prints each error with its JSON pointer location:

```text [Terminal]
invalid lens spec:
  at /returns/fields/stories/items/fields/type: Invalid option: expected one of "string"|"number"|"boolean"|"integer"
```

## Common pitfalls

Check these three rules when a new lens fails validation or fails at runtime:

- **Array `items` expects a bare field map** – Put field names directly inside `items` instead of wrapping them in `"type": "object"` and `"fields"`.
- **Root expressions require a bound variable** – Write `$value.title` or `$res.body.title` instead of bare `title`, because Lenses evaluates expressions with no implicit input.
- **Missed DOM selectors return `null`** – Any optional element such as `.score` on a job post must be marked `"nullable": true` in `returns`, or validation rejects the call on rows missing that element.

Here is the `items` fix when declaring an array of objects:

```diff [hn-top.json]
  "type": "array",
- "items": { "type": "object", "fields": { "title": "string" } }
+ "items": { "title": "string" }
```

See [Expressions & Templates](./expressions-and-templates.md) for the full variable rules at each expression site.
