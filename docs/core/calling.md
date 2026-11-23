# Calling Lenses

Notation Lenses validates parameters before running a call, classifies every response by `kind`, and enforces explicit consent for writes and file downloads. Examples below omit `--catalog` for brevity.

## Passing parameters

Pass arguments as a JSON object with `--params`:

```sh [Terminal]
lens call hn/top --params '{"page": 2}'
```

Lenses checks every parameter against the lens's declared types before executing any step or tier. Because the client does not coerce types, `{"page": "2"}` fails when `page` is declared as `integer`.

## Result kinds and exit status

Every call returns a JSON object whose `kind` is one of three values:

| Result kind | Meaning |
| :--- | :--- |
| `value` | The call succeeded and returned data matching `returns` |
| `outcome` | The call reached a declared state such as `needs_auth` |
| `error` | The call failed or returned data violating `returns` |

`lens call` exits with status 0 for `value` and `outcome`, and exits with status 1 only for `error` or invalid CLI input.

Scripts and CI jobs must check `kind` rather than relying on the exit code alone.

### Value results

A `value` result carries the extracted payload, the `resolver` that produced it, and the `tab` identifier if a browser tab was used:

```json [Value result]
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
  "tab": "t1834"
}
```

Follow `$lens` links such as `next_page` by calling the named lens with its `params`:

```sh [Terminal]
lens call @djgrant/hn/top --params '{"page": 2}'
```

### Outcome results

An `outcome` indicates a known state declared by the lens author, most commonly `needs_auth`:

```json [Outcome result]
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

In an interactive terminal, `lens call` waits up to two minutes for you to sign in and then retries automatically. Non-interactive runs return the outcome immediately; pass `--auth-lease-ms` to change the wait duration or `0` to disable waiting.

### Error results and `--lax`

An `error` result includes a `message` and usually a machine-readable `code`:

```json [Error result]
{
  "kind": "error",
  "code": "writes_not_allowed",
  "message": "@djgrant/chatgpt/send performs writes; call it with allowWrites: true to consent"
}
```

When extracted data fails the `returns` schema, the call returns an error listing every mismatch in `issues`.

Pass `--lax` to return the `value` anyway with those mismatches moved to `warnings`. See the [CLI reference](../reference/cli.md) for all error codes.

## Reusing a browser tab

Pass a previous result's `tab` identifier to `--tab` to run the next call in that exact tab:

```sh [Terminal]
lens call hn/item --params '{"id": "41234567"}' --tab t1834
```

Use `--tab` when a site holds session or form state inside the open page. If the user closed that tab, the call fails with `tab_closed`.

## Cached results

Read lenses can declare a cache lifetime in `effects.cache`, measured in seconds. A repeated call within that window returns the cached `value` marked `"cached": true` without touching the browser or network.

Only `value` results are cached; outcomes, errors, and write lenses are never cached. Pass `--no-cache` to bypass an existing cache entry and skip caching the new result.

## Write lenses

Lenses that declare `effects.writes` modify remote state, such as sending a chat message. The broker refuses write lenses with `writes_not_allowed` unless you pass `--allow-writes`:

```sh [Terminal]
lens call chatgpt/send --params '{"message": "hello"}' --allow-writes
```

Check the result fields before retrying a failed or timed-out write call:

- **Completed steps** – When every `perform` step ran, the result carries `"performed": true` even if later extraction failed, meaning a retry repeats the write.
- **Ambiguous timeouts** – A non-idempotent write timeout attaches a `mutation` object reporting whether the write ran (`"yes"`, `"no"`, or `"unknown"`) so you know whether to inspect the site before retrying.
- **Idempotent writes** – Lenses with `idempotent` set to `true` in `lens list` are safe to retry directly.

See [Write and File Lenses](../authoring/write-and-file-lenses.md) for how authors model side effects and retries.

## File-returning lenses

Lenses that declare a `file` return type write their output to disk instead of returning raw bytes in JSON. Pass an existing directory with `--out-dir`:

```sh [Terminal]
lens call bank/statement-pdf --params '{"id": "123"}' --out-dir ~/Statements
```

Without `--out-dir`, the call fails before opening the page with `out_dir_required`. On success, `value` describes the saved file:

```json [Saved file result]
{
  "path": "/Users/you/Statements/Statement-123.pdf",
  "name": "Statement-123.pdf",
  "mimeType": "application/pdf",
  "bytes": 48213
}
```

While a file lens runs – and for five seconds after it finishes – Lenses suppresses page-initiated downloads so Chrome does not save a duplicate copy alongside the file written to `--out-dir`.
