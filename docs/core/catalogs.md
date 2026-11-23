# Catalogs

Notation Lenses loads lens documents from ordered catalog sources, either local directories or cached git repositories. A catalog also holds shared defaults and site rules so individual lenses stay small.

## Local directories

Pass a directory path with `--catalog`, or `-c`:

```sh [Terminal]
lens call hn/top -c ./examples
```

You can also prefix a directory with `file:`, such as `file:./examples`. Lenses reads every top-level JSON file except `catalog.json` on each call, skips subdirectories, and applies edits immediately.

## Git repositories

Load a published catalog directly from git using the `git:` scheme:

```sh [Terminal]
lens call hn/top -c git:github.com/notationlabs/lenses#main/examples
```

A `git:` reference splits into three parts:

| Segment | Meaning |
| :--- | :--- |
| `github.com/notationlabs/lenses` | Repository path cloned over HTTPS |
| `#main` | Optional branch or tag name |
| `/examples` | Optional subdirectory holding lens files |

For a local git repository on disk, use an absolute path such as `git:/Users/me/src/my-lenses#main`. Lenses performs a shallow `--depth 1` clone into `~/.cache/lenses/git/` on first load and reads from that cache offline afterward.

## Scoped names and precedence

Every lens document declares a scoped `name` such as `@djgrant/hn/top`, and Lenses registers both `@djgrant/hn/top` and the shortname `hn/top`.

Pass multiple catalogs in priority order when combining sources:

```sh [Terminal]
lens list -c ./my-lenses -c ./examples
```

Scoped names must be unique across all loaded catalogs; duplicates fail the load and report both sources. When two catalogs declare different scoped names with the same shortname, the first catalog wins the shortname while later scoped names stay directly callable.

## Updating git catalogs

Lenses never pulls cached git repositories automatically after the initial clone. Run `lens update` to refresh git clones from their origins:

```sh [Terminal]
lens update -c git:github.com/notationlabs/lenses#main/examples
```

The command fetches `--depth 1`, resets the clone to `FETCH_HEAD`, and prints each source's lens count:

```json [Output]
{
  "sources": [
    {
      "source": "git:github.com/notationlabs/lenses#main/examples",
      "lenses": 9
    }
  ]
}
```

Local directory catalogs are read live and require no update. In TypeScript, `client.update()` performs the same refresh.

## Parameter defaults

A lens declares inputs under `params`, referenced in URL templates as `{params.name}` and in expressions as `$params.name`. When a caller omits a parameter, Lenses resolves defaults in order of precedence:

1. Explicit `params` passed in the call always win.
2. `parameterDefaults` passed to `createLensClient` overrides user config.
3. User config in `~/.config/lenses/config.json` sets defaults per scoped-name glob.
4. Document defaults in `params` apply last, either as a scalar value or a `{ "$lens": "...", "field": "..." }` reference.

Set personal defaults in `~/.config/lenses/config.json` under `params`:

```json [~/.config/lenses/config.json]
{
  "params": {
    "@djgrant/hn/*": { "limit": 50 },
    "@djgrant/hn/item": { "limit": 25 }
  }
}
```

Globs match the scoped name rather than the shortname, and `*` matches across `/`. More specific patterns with more non-wildcard characters override broader globs. Defaults undergo normal parameter validation, so setting an undeclared parameter in a broad glob fails the call.

A document parameter can also declare a dynamic default using a lens reference:

```json [Document snippet]
{
  "params": {
    "orgId": {
      "type": "string",
      "default": {
        "$lens": "@example/app/session",
        "field": "$value.orgId"
      }
    }
  }
}
```

When `orgId` is omitted, Lenses calls the referenced lens before URL expansion and projects `field` from its result. Dynamic defaults are capped at 8 calls and depth 4 per outer call.

## Shared catalog settings

Place a `catalog.json` file alongside lens documents to share `helpers`, `params`, and URL-matched `scopes` across the directory:

```json [catalog.json]
{
  "helpers": {
    "trimText": "function($s) { $trim($s) }"
  },
  "scopes": [
    {
      "url": "https://claude.ai/*",
      "tab": "reuse",
      "navigate": "in-page",
      "exceptions": {
        "needs_auth": {
          "matches": "$contains($page.url, '/login')"
        }
      }
    }
  ]
}
```

Lenses merges `catalog.json` into every document in that directory without treating it as a lens. Each entry under `scopes` matches document URL templates in array order against `*`-only globs:

| Setting | Effect |
| :--- | :--- |
| `helpers` | Adds shared JSONata functions to every document |
| `params` | Merges shared parameter declarations into every document |
| `tab` | Set to `"reuse"` to keep and reuse one tab per origin |
| `navigate` | Set to `"in-page"` to route with `history.pushState` |
| `exceptions` | Inherits matching exception rules into matching documents |

A document's own settings override values inherited from `catalog.json`.

See [Lens Document](../reference/lens-document.md) for the full document schema.  See [Configuration](../reference/configuration.md) for user config options.
