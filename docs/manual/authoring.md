# Writing a Lens

This page builds `hn/top`, a lens that returns the stories on the Hacker News front page. The finished file is `examples/hn.top.json`.

## Looking at the page

Find where the data lives on the page:

```sh
lens observe https://news.ycombinator.com/news --html
```

`snapshot` holds the page's text, plus its HTML without scripts and styles when you pass `--html`. `requests` lists the JSON requests the page made while it loaded, with a short preview of each reply. On a page that loads its data with JavaScript, `--request` with part of a URL returns that request's full reply.

Hacker News renders on the server, so no reply contains the stories, and the lens must read the HTML with CSS selectors. Each story is a `tr` with the class `athing`, and its title link sits inside `.titleline`.

## Trying an expression offline

Lenses reshape data with JSONata expressions, and `lens eval` runs one against a JSON file without a browser. Write two story rows by hand in `rows.json`, and wrap them in a `stories` object:

```sh
lens eval --as value '{ "stories": $value }' --input rows.json
```

An expression has no implicit input: every value it reads is a named variable. `--as value` binds the file as `$value`, the name it will have inside the lens. Without `--as`, the file is bound as `$res.body`, where HTTP replies appear.

## Writing the document

Create `hn-top.json` and add the fields below.

### Name and URL

The `name` is scope, site and lens. The `url` is the page the browser opens:

```json
"name": "@me/hn/top",
"url": "https://news.ycombinator.com/news?p={params.page}",
```

### Parameters

Take a `page` parameter that defaults to 1:

```json
"params": { "page": { "type": "integer", "default": 1 } },
```

### Returns

Declare the shape of the result. The client checks every result against it:

```json
"returns": {
  "type": "object",
  "fields": {
    "stories": {
      "type": "array",
      "items": {
        "id": "string",
        "title": "string",
        "url": "string",
        "score": { "type": "string", "nullable": true }
      }
    }
  }
},
```

`score` needs `nullable`, because job posts have no score.

### Effects

Declare the hosts the lens reads and the changes it writes. Both `reads` and `writes` are required, even when empty. `cache` keeps a result for 60 seconds:

```json
"effects": { "reads": ["news.ycombinator.com"], "writes": [], "cache": 60 },
```

### A DOM resolver

Read the rendered page with one `dom` resolver:

```json
"resolve": [
  {
    "kind": "dom",
    "item": ".athing",
    "fields": {
      "id": { "selector": ":self", "attr": "id" },
      "title": { "selector": ".titleline > a" },
      "url": { "selector": ".titleline > a", "attr": "href" },
      "score": { "selector": ".score", "scope": "+" }
    },
    "post": "{ \"stories\": $value }"
  }
]
```

`item` produces one object per `.athing` row, and each field's selector runs inside that row. `":self"` is the row itself, and `attr` reads an attribute instead of the text. The score sits in the next row, so `"scope": "+"` moves its selector to the next sibling element. `post` is the expression you tried with `lens eval`.

## Calling the file

Call the file by path:

```sh
lens call ./hn-top.json --catalog .
```

The result has the format [Calling Lenses](./calling.md) describes. A value that does not match `returns` is an error listing each mismatch.

## Checking the document

Check the document without a browser:

```sh
lens schema ./hn-top.json --catalog .
```

A valid document prints the JSON Schema of its result. An invalid one lists each problem with its location, as here for the first mistake below:

```text
invalid lens spec:
  at /returns/fields/stories/items/fields/type: Invalid option: expected one of "string"|"number"|"boolean"|"integer"
  …
```

## Choosing a resolver

Many sites also serve their data as JSON. Each kind of resolver reads a different source:

- `http` calls the site's API itself and reads the JSON replies, without opening the page.
- `intercept` opens the page and reads the JSON replies the page fetched.
- `dom` reads the rendered HTML with CSS selectors.
- `llm` extracts nothing. It hands the page text and a prompt back to the caller, usually an AI agent, which reads the page itself.

Prefer them in that order, because a JSON reply changes less often than HTML.

The engine runs a document's resolvers in order until the result is complete. `examples/hn.item.json` tries the Algolia API with `http`, then falls back to `dom`. When `returns` is an object, each resolver can supply only some fields: the finished `hn/top` uses a second `dom` resolver just for the `next_page` link.

## Two common mistakes

**Nesting an object inside array `items`.** In an array, `items` maps field names straight to types, so a `"type": "object"` wrapper is wrong:

```diff
  "type": "array",
- "items": { "type": "object", "fields": { "title": "string" } }
+ "items": { "title": "string" }
```

The validator reads `type` and `fields` as field names and rejects the document.

**A non-nullable field that a selector can miss.** A `dom` field whose selector matches nothing is `null`, which fails a plain `"string"`. The call fails only on rows that lack the element, such as job posts on Hacker News, so this is easy to miss.

## Naming a page state

A state named in `exceptions`, most often a sign-in page, makes the call return an outcome instead of a value. `hn/top` works signed out, so this example is `examples/claude.usage.json`, which reads usage from claude.ai.

Declare the outcome once, with a follow-up lens that signs the user in and a hint for a person:

```json
"exceptions": {
  "needs_auth": {
    "$lens": "@djgrant/claude/login",
    "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
  }
}
```

Each resolver recognises the state with a `matches` expression. The `dom` resolver checks the page URL:

```json
"exceptions": {
  "needs_auth": { "matches": "$contains($page.url, '/login')" }
}
```

The `http` resolver checks for a 401 or 403 status instead. Both inherit the hint and follow-up lens through the shared name `needs_auth`.

## Sites that keep state in the tab

Many online banks keep the session in the open tab rather than in cookies, so any new page load lands on the sign-in page. Keep the lens in one tab:

```json
"tab": "reuse",
"navigate": "in-page",
"ready": "ibank-account-card",
```

`"tab": "reuse"` runs every call in the tab this site used last, and never closes it. `"navigate": "in-page"` changes the URL with the history API instead of loading a page. These apps keep rendering after load, so resolvers wait for `ready`, a selector that only the finished target page matches. A [catalog](./catalogs.md) can set `tab` and `navigate` for every lens on a site.

Observe in the existing tab, because a plain `lens observe <url>` loads a new page and signs the session out:

```sh
lens observe https://bank.example/statements --tab t1
```
