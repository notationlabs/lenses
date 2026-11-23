# Quickstart

This guide runs your first Notation Lenses calls against Hacker News and `claude.ai` from the terminal and TypeScript. Finish [Installation](./installation.md) before starting.

## Set a catalog source

The CLI has no built-in catalog and does not remember one between commands. Pass `--catalog` or `-c` to commands that load lenses from a catalog:

| Catalog flag | Commands |
| :--- | :--- |
| Required | `list`, `call`, `schema`, `update`, `graphql` |
| Optional | `gen` |
| Not used | `observe`, `eval`, `broker`, `skill` |

Store the example catalog location in a shell variable for the steps below:

```sh [Terminal]
CATALOG=git:github.com/notationlabs/lenses#main/examples
```

The first command clones the repository into `~/.cache/lenses`. See [Catalogs](./catalogs.md) for local directories and multi-catalog resolution.

## List available lenses

Inspect the lenses in the catalog:

```sh [Terminal]
lens list -c $CATALOG
```

Each entry includes its names, target URL, declared parameters, side effects, and exceptions:

```json [Result excerpt]
{
  "name": "@djgrant/hn/top",
  "shortname": "hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": {
    "page": { "type": "integer", "default": 1 }
  },
  "effects": {
    "reads": ["news.ycombinator.com"],
    "writes": [],
    "idempotent": true,
    "cache": 60
  },
  "exceptions": []
}
```

You can call a lens by its `shortname` or its full scoped `name`.

## Read the Hacker News front page

Call `hn/top` with no parameters:

```sh [Terminal]
lens call hn/top -c $CATALOG
```

```json [Result]
{
  "kind": "value",
  "value": {
    "stories": [
      {
        "title": "My YC app: Dropbox - Throw away your USB drive",
        "url": "https://www.getdropbox.com/u/2/screencast.html",
        "id": "8863",
        "score": "104 points",
        "comments": "71 comments",
        "item_url": {
          "$lens": "@djgrant/hn/item",
          "params": { "id": "8863" }
        }
      }
    ],
    "next_page": {
      "$lens": "@djgrant/hn/top",
      "params": { "page": 2 }
    }
  },
  "resolver": "dom",
  "tab": "t1"
}
```

The first call takes longer because it starts the background broker and connects to Chrome.

`lens call` exits with status 0 for `value` and `outcome` results, and exits with status 1 only for `error` results or invalid CLI arguments.

## Follow a `$lens` reference

`item_url` names the follow-up lens and parameters for a story thread. Pass those parameters to `hn/item` with `limit` set to `1` to keep the output compact:

```sh [Terminal]
lens call hn/item --params '{"id": "8863", "limit": 1}' -c $CATALOG
```

```json [Result]
{
  "kind": "value",
  "value": {
    "story": {
      "title": "My YC app: Dropbox - Throw away your USB drive",
      "url": "https://www.getdropbox.com/u/2/screencast.html",
      "score": "104 points"
    },
    "comments": [
      {
        "id": "8865",
        "author": "dhouston",
        "age": "2007-04-04T19:16:40.000Z",
        "text": "oh, and a mac port is coming :)",
        "replies": []
      }
    ],
    "next_page": {
      "$lens": "@djgrant/hn/item",
      "params": { "id": "8863", "page": 2, "limit": 1 }
    }
  },
  "resolver": "http"
}
```

Here `"resolver"` is `"http"` because `hn/item` queried the Algolia Hacker News API directly without opening a browser tab.

## Read a signed-in page

`claude/usage` reads your plan and usage limits from your Chrome session on `claude.ai`. When signed out in an interactive terminal, `lens call` waits up to two minutes for you to sign in; pass `--auth-lease-ms 0` to return immediately:

```sh [Terminal]
lens call claude/usage --auth-lease-ms 0 -c $CATALOG
```

```json [Outcome]
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": {
    "$lens": "@djgrant/claude/login"
  },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call.",
  "resolver": "http"
}
```

Sign in to `claude.ai` in Chrome and run the command again to receive `"kind": "value"` with your usage data. Because an outcome exits with status `0`, scripts must inspect `kind` rather than relying on the exit code; see [Calling Lenses](./calling.md) for details.

## Call from TypeScript

Install `@notation/lenses` in your project:

```sh [Terminal]
npm install @notation/lenses
```

Create a client with `createLensClient` and call `value()` to unwrap the result directly or throw on outcomes and errors:

```ts [src/index.ts]
import { createLensClient } from "@notation/lenses";

await using lenses = createLensClient({
  catalog: "git:github.com/notationlabs/lenses#main/examples",
});

const top = await lenses.value({ lens: "hn/top" });
console.log(top);
```

Use `call()` instead of `value()` when you want the raw result object to branch on `kind`. See [TypeScript](./typescript.md) for generated typed SDKs.
