# Catalogs

A catalog is a directory of lens files. Every command that calls or lists lenses needs at least one, from a local directory or a git repository.

## A local directory

Pass a directory with `--catalog`, or `-c`:

```sh
lens call hn/top -c ./examples
```

Every top-level `.json` file must be a valid lens document. Subdirectories are skipped. Lenses rereads the directory on every call, so edits take effect at once.

## A git repository

Use a catalog that someone else publishes:

```sh
lens call hn/top -c git:github.com/notationlabs/lenses#main/examples
```

- `github.com/notationlabs/lenses` is the repository, cloned over HTTPS.
- `#main` is the branch or tag. Without it, lenses uses the default branch.
- `/examples` is the directory of lens documents, starting at the first `/` after the `#`. Leave it out when they sit at the repository root.

For a repository on your own disk, write an absolute path after `git:`, such as `git:/Users/me/src/my-lenses#main`.

Lenses clones the repository on first load into `~/.cache/lenses/git/`. Later calls read the clone, so they work offline.

## How a short name is found

Every lens document declares a scoped name:

```json
{
  "name": "@djgrant/hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}"
}
```

`@djgrant` is the author's scope. Lenses also registers a shortname without the scope, so `hn/top` and `@djgrant/hn/top` call the same lens.

Load several catalogs, in order:

```sh
lens list -c ./my-lenses -c ./examples
```

When catalogs overlap, the two kinds of name behave differently:

- A scoped name must be unique across all catalogs. If two catalogs both contain `@djgrant/hn/item`, the load fails with an error that names both.
- A shortname goes to the lens from the earliest catalog. If `./my-lenses` contains `@me/hn/item`, `hn/item` calls it, and `@djgrant/hn/item` stays reachable by its scoped name.

Put your own catalog first to override a lens from a shared one.

The MCP server takes a comma-separated list in `LENS_CATALOG`, and the TypeScript client takes a `catalog` array in `createLensClient`, with the same order rules. [Agents and MCP](./agents.md) and [TypeScript](./typescript.md) show the setup.

## Keeping a git catalog up to date

**After the first clone, lenses never fetches the repository on its own.** A git catalog stays at that commit even when the author pushes fixes. Fetch the latest commit:

```sh
lens update -c git:github.com/notationlabs/lenses#main/examples
```

It resets the clone to the branch and prints each catalog's lens count:

```json
{
  "sources": [
    { "source": "git:github.com/notationlabs/lenses#main/examples", "lenses": 9 }
  ]
}
```

A local directory needs no update. In TypeScript, `client.update()` does the same.

## Parameter defaults

`hn/item` returns 30 top-level comments per page, because its `limit` parameter defaults to 30. Set your own default of 50 in `~/.config/lenses/config.json`:

```json
{
  "params": {
    "@djgrant/hn/item": { "limit": 50 }
  }
}
```

Each key in `params` is a glob over the scoped name, not the shortname. `*` matches any characters, including `/`, so `"@djgrant/hn/*"` covers every Hacker News lens. When two globs match the same lens, the longer one wins.

A parameter passed in the call wins over a default.

Defaults are checked like any other parameter, so a default for an undeclared parameter makes the call fail. Keep a broad glob such as `@djgrant/hn/*` to parameters every matching lens declares.

In TypeScript, the `parameterDefaults` option of `createLensClient` takes the same object and wins over `config.json`.

## Shared settings in catalog.json

A `catalog.json` file in the catalog directory is not a lens document. Lenses merges it into every lens document beside it, so shared settings, such as the signed-out check every claude.ai lens needs, live in one place.

Give every claude.ai lens the same `needs_auth` outcome:

```json
{
  "scopes": [
    {
      "url": "https://claude.ai/*",
      "exceptions": {
        "needs_auth": { "matches": "$contains($page.url, '/login')" }
      }
    }
  ]
}
```

A scope applies to each document whose `url` matches the scope's `url` glob, so `claude/usage` gets the exception and `hn/top` does not. A document's own settings win over the shared ones. `catalog.json` can also hold shared `helpers` and `params`. [Lens document](../api/lens-document.md) has the full format.
