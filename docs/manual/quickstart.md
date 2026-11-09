# Quick Start

This page reads Hacker News and your claude.ai usage from the terminal and from TypeScript. It assumes you have finished [Installation](./installation.md).

## Point at the example lenses

The CLI has no built-in lenses, and it does not remember a catalog between commands, so every command takes `-c`. Keep the example catalog in a shell variable:

```sh
CATALOG=git:github.com/notationlabs/lenses#main/examples
```

The first command clones it into `~/.cache/lenses`. With a checkout of the repository, use `./examples` instead. [Catalogs](./catalogs.md) covers other sources.

## List the lenses

```sh
lens list -c $CATALOG
```

The entry for `hn/top`, trimmed:

```json
{
  "name": "@djgrant/hn/top",
  "shortname": "hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": { "page": { "type": "integer", "default": 1 } },
  "exceptions": []
}
```

`hn/top` takes an optional `page`. You can call it by `shortname` or by full `name`.

## Read the front page

```sh
lens call hn/top -c $CATALOG
```

```json
{
  "kind": "value",
  "value": {
    "stories": [
      {
        "title": "My YC app: Dropbox - Throw away your USB drive",
        "id": "8863",
        "score": "104 points",
        "item_url": { "$lens": "@djgrant/hn/item", "params": { "id": "8863" } }
      }
    ],
    "next_page": { "$lens": "@djgrant/hn/top", "params": { "page": 2 } }
  },
  "resolver": "dom"
}
```

The first call is slower because it starts the broker and connects to Chrome.

## Open a story

`item_url` tells you which lens to call next and with what parameters. Call it, with `limit` set to 1 to keep the output short:

```sh
lens call hn/item --params '{"id": "8863", "limit": 1}' -c $CATALOG
```

```json
{
  "kind": "value",
  "value": {
    "story": { "title": "My YC app: Dropbox - Throw away your USB drive", "score": "104 points" },
    "comments": [
      { "id": "8865", "author": "dhouston", "text": "oh, and a mac port is coming :)", "replies": [ … ] }
    ],
    "next_page": { "$lens": "@djgrant/hn/item", "params": { "id": "8863", "page": 2, "limit": 1 } }
  },
  "resolver": "http"
}
```

`resolver` is `"http"`: `hn/item` got the story from an API without opening a tab.

## Read a signed-in page

`claude/usage` reads your plan and limits from claude.ai, using the session in your Chrome profile. If you are signed out, the CLI waits up to two minutes for you to sign in. `--auth-lease-ms 0` returns at once instead:

```sh
lens call claude/usage --auth-lease-ms 0 -c $CATALOG
```

```json
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": { "$lens": "@djgrant/claude/login" },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
}
```

Sign in to claude.ai in Chrome and run it again to get your usage.

**An outcome exits with status 0.** Only an `error` exits with 1, so a script must check `kind`, not the exit status. [Calling Lenses](./calling.md) explains the three kinds.

## Call from TypeScript

```sh
npm install @djgrant/lenses
```

```ts
import { createLensClient } from "@djgrant/lenses";

await using lenses = createLensClient({ catalog: "git:github.com/notationlabs/lenses#main/examples" });

const top = await lenses.value({ lens: "hn/top" }); // ← throws on an outcome or error
console.log(top);
```

`call()` returns the same object `lens call` prints, if you want to branch on `kind` instead of catching. [TypeScript](./typescript.md) covers generated types.
