# Lens Document

A lens document is one JSON file that declares one lens: the page it reads, its parameters, the data it returns, and how to get that data out of the page. Here is `hn/top`, which reads the Hacker News front page, with its `llm` prompt shortened:

```json
{
  "name": "@djgrant/hn/top",
  "description": "Front-page stories on Hacker News. Each story links onward to hn/item via item_url. Hiring posts carry no score or comments (null). Paginated: next_page is the following page of stories (null on the last page).",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": {
    "page": { "type": "integer", "default": 1 }
  },
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
          "item_url": { "$lens": "@djgrant/hn/item", "params": { "id": "$item.id" } }
        }
      },
      "next_page": {
        "$lens": "@djgrant/hn/top",
        "params": { "page": "$number($substringAfter($item.next_page, 'p='))" }
      }
    }
  },
  "effects": { "reads": ["news.ycombinator.com"], "writes": [], "idempotent": true, "cache": 60 },
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
      "fields": { "next_page": { "selector": "a.morelink", "attr": "href" } }
    },
    { "kind": "llm", "prompt": "Extract this Hacker News front page as {stories, next_page}. …" }
  ],
  "exceptions": { "not_found": null }
}
```

`name`, `url`, `effects` and `resolve` are required. The client rejects unknown keys at every level, so a misspelled key is an error.

## `name`

`name` is how callers ask for the lens. Its three segments are owner, site and lens, as in `@djgrant/hn/top`, and each uses only lowercase letters, digits, `_` and `-`. A catalog also registers the short name `hn/top`; see [Catalogs](../manual/catalogs.md).

## `description`

`description` tells callers what the lens returns. The lens listing and the MCP tool descriptions show it.

## `url`

`url` is the page the browser opens before the resolvers run. `{params.name}` inserts a parameter:

```json
"url": "https://news.ycombinator.com/news?p={params.page}"
```

With `{"page": 2}`, the browser opens `https://news.ycombinator.com/news?p=2`. The URL must be absolute, and every `{params.name}` must name a declared parameter. [Expressions and Templates](./expressions.md) describes the template syntax.

## `params`

`params` declares the inputs a caller can pass. The client checks each call against it before running the lens. An optional page number:

```json
"params": {
  "page": { "type": "integer", "default": 1 }
}
```

A parameter without a default is required, and can be written as the type alone, as in `"id": "string"`. The object form takes these keys:

| Key | Type | Required |
| --- | --- | --- |
| `type` | `"string"`, `"number"`, `"integer"` or `"boolean"` | yes |
| `default` | a value of that type | no |
| `enum` | array of strings, for `string` parameters only | no |

A default can come from another lens: `{"$lens": "@acme/site/account", "field": "$value.org_id"}` makes the client call that lens and read one value from its result.

Templates read a parameter as `{params.page}`; expressions read it as `$params.page`.

## `returns`

`returns` declares the shape of the data. The client checks every result against it and returns an error on a mismatch; see [Calling Lenses](../manual/calling.md).

A primitive is a type name such as `"string"`. An object is `{"type": "object", "fields": {…}}`. An array is `{"type": "array", "items": {…}}`, where `items` is the field map for each element.

Every declared field is required in the result. Mark a field that can be missing as nullable, as `hn/top` does with `score`, because hiring posts have none.

### Links to other lenses

A `$lens` field is a follow-up call to another lens, with parameters filled in from the other fields of the same object:

```json
"item_url": { "$lens": "@djgrant/hn/item", "params": { "id": "$item.id" } }
```

Each parameter value is an expression, and `$item` is the containing object, here one story. The caller receives `{"$lens": "@djgrant/hn/item", "params": {"id": "41234567"}}` and can call it directly. `next_page` turns the "More" link into a call for the next page.

### Recursive shapes

For data that nests to any depth, declare the repeated object shape once under the top-level `$defs` field and point to it with `$ref`. In `hn/item`, the `comments` shape has a `replies` array whose items are `{"$ref": "comments"}`.

A lens that downloads a file declares `"returns": {"type": "file"}`; see [Write and File Lenses](../manual/write-lenses.md).

## `effects`

`effects` declares what the lens reads and changes, which decides whether the caller must consent and whether results are cached. `hn/top` only reads, and caches for 60 seconds:

```json
"effects": { "reads": ["news.ycombinator.com"], "writes": [], "idempotent": true, "cache": 60 }
```

| Key | Type | Required | Default |
| --- | --- | --- | --- |
| `reads` | array of strings, usually hostnames | yes | |
| `writes` | array of strings | yes | |
| `idempotent` | boolean | no | `false` |
| `cache` | seconds | no | `0` |

**A lens is a write when `writes` is not empty**, and a caller must pass `--allow-writes` to run it. A write lens cannot be cached, so its `cache` must be `0` or absent. `idempotent: true` means a retry is safe.

## `resolve`

`resolve` lists the strategies for getting the data. The client tries them in order, keeps the fields each one finds, and stops once every field in `returns` is present.

In `hn/top`, two `dom` resolvers read the stories and the "More" link, and an `llm` resolver asks the caller's model to extract the page if the selectors stop matching. The other kinds are `http` and `intercept`. [Resolvers](./resolvers.md) describes each kind.

## `exceptions`

An exception names a page state that is not the data, such as a sign-in page. When one matches, the call returns an `outcome` with that name instead of a value.

Handle a signed-out user in `claude/usage`:

```json
"exceptions": {
  "needs_auth": {
    "$lens": "@djgrant/claude/login",
    "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
  }
}
```

`hint` is for a person, and `$lens` names a lens that fixes the problem. `matches` is the condition, an expression over `$page` (the page's `url` and `title`) or `$res` (a response's `status`, `url` and `body`):

```json
"matches": "$contains($page.url, '/login') or $res.status = 401"
```

`params` holds expressions for the `$lens` call's parameters. All four keys are optional.

A document inherits exceptions from its catalog. Setting an entry to `null` turns one off, as `hn/top` does with `"not_found": null`. For names that start with `needs_`, the broker keeps the tab open for the user. [Authoring](../manual/authoring.md) shows the sign-in pattern in full.

## `perform`

`perform` lists browser steps that run before the resolvers read the page. `chatgpt/send` types and sends a message:

```json
"perform": [
  { "wait": { "appears": "#prompt-textarea" } },
  { "fill": "#prompt-textarea", "value": "$params.message" },
  { "click": "[data-testid='send-button']" }
]
```

Steps alone do not make a lens a write: a lens that only pages through a list keeps `writes` empty. [Resolvers](./resolvers.md) lists every step, and [Write and File Lenses](../manual/write-lenses.md) explains how to author them.

## `tab`, `navigate` and `ready`

These fields control how the browser reaches the page, which matters for single-page apps that keep state in the tab.

By default each call opens its own tab. `"tab": "reuse"` runs the call in the tab this site used last, which the broker never closes.

`"navigate": "in-page"` changes the route inside the existing page instead of loading a new page, so the app keeps its state.

`ready` is a CSS selector that the resolvers wait for, for apps that still show a loading screen after the page loads:

```json
"ready": "[data-testid='conversation-turn']"
```

The wait for the page and for `ready` lasts up to `loadTimeoutMs`, default `30000` milliseconds.

## `helpers`

`helpers` defines JSONata functions that any expression in the document can call, for conversions that repeat:

```json
"helpers": { "money": "function($s) { $number($replace($s, /[^0-9.]/, \"\")) }" }
```

An expression calls it as `$money($value.total)`. A helper sees only its arguments, not `$params` or the page. Its name cannot be a built-in variable name: `res`, `item`, `sources`, `params`, `value` or `page`.

## `catalog.json`

A `catalog.json` beside the lens documents holds settings they share, such as a sign-in check. It takes `helpers` and `params` in the same form as a document, and a list of `scopes`. Each scope applies its `exceptions`, `tab` and `navigate` to documents whose `url` matches the scope's `url` glob, where `*` matches anything:

```json
{
  "scopes": [
    {
      "url": "https://claude.ai/*",
      "tab": "reuse",
      "exceptions": {
        "needs_auth": { "matches": "$contains($page.url, '/login') or $res.status = 401" }
      }
    }
  ]
}
```

A document's own fields win. Exceptions merge key by key, so a document can add a `$lens` to the `needs_auth` above and keep its `matches`. `params`, `helpers`, `tab` and `navigate` replace the catalog's entries of the same name.
