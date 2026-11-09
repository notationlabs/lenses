# Resolvers

A resolver, also called a tier, is one way for a lens to get its data. A lens lists its tiers in the `resolve` array, cheapest first, and the engine tries them in order until it has a complete value. The kinds are `http`, `intercept`, `dom` and `llm`.

## How a lens tries its resolvers

Each tier ends in one of four ways:

- A **value**: the engine adds it to the fields gathered so far and returns them if they match the lens's `returns` shape. Otherwise it tries the next tier.
- A **miss**, such as an API answering 404: the engine tries the next tier.
- An **outcome**, a known state such as a sign-in page: the call returns it.
- An **error**: the call stops.

If every tier misses, the call fails with an error whose message starts with `all resolvers exhausted`.

Many fields hold JSONata expressions, such as `"$res.body.title"`, or URL templates such as `{params.id}`. [Expressions and Templates](./expressions.md) explains both.

## `http`

An `http` tier sends its own HTTP requests and never loads the page, so it is the cheapest kind. Use it when the site has an API that returns the data.

Fetch a story and its comments from Algolia's Hacker News API (the first tier of `hn/item`):

```json
{
  "kind": "http",
  "request": { "method": "GET", "url": "https://hn.algolia.com/api/v1/items/{params.id}" },
  "items": "( ... { 'story': { 'title': $res.body.title, ... }, 'comments': [...] } )",
  "exceptions": { "not_found": { "matches": "$res.status = 404" } }
}
```

`$res` has a `status`, a `url` and a parsed `body`. A tier can also give a `map`, which runs once for each element `items` returns, bound as `$item`. Without the `exceptions` entry, a 404 would be a miss rather than the outcome `not_found`.

By default the request runs without a browser or cookies. For a site that needs you signed in, set `"credentials": true` to send it through the browser with your cookies, or `"same-origin-page"` to send it from an open tab on the same site.

Chain requests with named `sources`. `claude/usage` puts the first organisation's id into the next URL:

```json
"sources": {
  "orgs":  { "request": { "method": "GET", "url": "https://claude.ai/api/organizations" } },
  "usage": { "request": { "method": "GET", "url": "https://claude.ai/api/organizations/{sources.orgs.body.0.uuid}/usage" } }
},
"map": { "plan": "$sources.orgs.body[0].rate_limit_tier", "limits": "..." }
```

Later sources and `map` read each response as `$sources.<name>`. A status outside 200–299 stops the chain, and the tier misses.

An `http` tier takes these fields:

- `request` is the `{method, url}` of a single request. Without `request` or `sources`, the tier sends a GET to the lens's `url`.
- `sources` names several requests, which run in order.
- `body` is the request body, keyed by its format: `json`, `text`, `form` or `search`.
- `headers` adds request headers.
- `credentials` is `false` by default, or `true`, or `"same-origin-page"`.
- `items` is an expression over `$res` that selects the value or the rows.
- `map` shapes the value, as one expression or an object of expressions.
- `exceptions` lists the outcomes this tier can detect, in the same form as the document's [`exceptions`](./lens-document.md). `intercept` and `dom` tiers take it too.

Any method other than GET, HEAD or OPTIONS counts as a write, which the lens must declare in `effects.writes`.

## `intercept`

An `intercept` tier sends no requests. It reads the JSON responses the page fetched while loading. Use it when the site's API is hard to call directly but the page loads the data.

Read the usage data the claude.ai settings page loads:

```json
{
  "kind": "intercept",
  "sources": {
    "usage": { "request": { "method": "GET", "url": "https://claude.ai/api/organizations/*/usage*" } },
    ...
  },
  "reloadOnMiss": true,
  "waitMs": 8000,
  "map": { "limits": "[$sources.usage.body.limits.{ ... }]" }
}
```

In `url`, `*` matches any characters. The pattern must match the whole URL, so `usage*` ends with `*` to allow a query string. If the page has not fetched a match yet, `reloadOnMiss` reloads the tab and waits for one.

An `intercept` tier takes these fields:

- `request` is the `{method, url}` pattern of a single response.
- `sources` names several patterns.
- `items` is an expression over `$res`. It works only with `request`.
- `map` shapes the value, as in an `http` tier.
- `reloadOnMiss` reloads the tab once when a response is missing.
- `waitMs` is how long to wait for missing responses, in milliseconds. With `reloadOnMiss`, the default is 8000.

## `dom`

A `dom` tier reads the rendered page with CSS selectors. It works on any site but breaks when the markup changes, so it usually comes after the other kinds.

Read each story on the Hacker News front page, which has no API. Each story is a row with the class `athing`, and its score sits in the row below:

```json
{
  "kind": "dom",
  "item": ".athing",
  "fields": {
    "id":       { "selector": ":self", "attr": "id" },
    "title":    { "selector": ".titleline > a" },
    "score":    { "selector": ".score", "scope": "+" }
  },
  "post": "{ \"stories\": $map($value, ...) }"
}
```

With `item`, the tier returns one object per matching row, and field selectors run inside the row. `":self"` reads the row itself, and `"scope": "+"` moves to the next row first. `post` reads the array as `$value`. The tier misses when `item` matches nothing or `post` returns nothing.

A `dom` tier takes these fields:

- `item` selects repeated elements. Without it, the tier returns one object read from the whole page.
- `fields` names the fields to read.
- `post` is an expression over `$value`, and its result replaces the value.

Each entry in `fields` takes these keys:

- `selector` is a CSS selector. The first match wins, and no match gives `null`.
- `attr` reads this attribute instead of the text. `href` and `src` become absolute URLs.
- `scope` moves the selector's starting point: `"+"` starts at the next sibling element, and an ancestor selector starts at that ancestor.

## `llm`

An `llm` tier is a last-resort fallback for when selectors stop matching. **It does not call a model.** It returns the page's visible text to the caller, usually an AI agent, with a prompt that says what to extract.

The last tier of `hn/top`:

```json
{ "kind": "llm", "prompt": "Extract this Hacker News front page as {stories, next_page}. ..." }
```

The call returns an outcome named `agent_extract`. Its `value` holds the `prompt`, the page's `url`, `title` and `text`, and any fields earlier tiers found, in `gathered`. The tier never misses.

An `llm` tier takes these fields:

- `prompt` is the instruction for the agent. It is required.
- `maxSnapshotChars` limits the page text. The default is 20000 characters.

## Perform steps

The document's `perform` array lists actions on the page that run once, before the first tier. `chatgpt/send` fills the prompt box and clicks send:

```json
"perform": [
  { "wait": { "appears": "#prompt-textarea" } },
  { "fill": "#prompt-textarea", "value": "$params.message" },
  { "click": "[data-testid='send-button']" },
  ...
]
```

If a step fails, no tier runs, and the call returns the error `perform_failed`. [Write and File Lenses](../manual/write-lenses.md) covers writing steps.

These are the steps:

- `fill` sets the matching input to `value`.
- `click` clicks the first visible match.
- `submit` sets the controls in `form`, then submits the form.
- `press` sends a key, such as `"Meta+Enter"`, to the focused element.
- `drop` drops the file at `$params.<name>` on the first visible match.
- `wait` waits until a selector `appears`, is `gone`, or `increases` in count.
- `navigate: "fresh"` reloads the lens URL.

## How fields from several tiers combine

After each tier that returns a value, the engine adds the fields still missing. **It never replaces a field an earlier tier set.** It stops once every field in `returns` is present.

The first `dom` tier of `hn/top` returns `{stories}`, but `returns` also declares `next_page`, so a second `dom` tier reads the "More" link:

```json
{ "kind": "dom", "fields": { "next_page": { "selector": "a.morelink", "attr": "href" } } }
```

The call returns the combined value with `resolver` set to `"reconciled"`. If the tiers run out before `returns` is satisfied, the call returns what it gathered, marked `"partial": true`.
