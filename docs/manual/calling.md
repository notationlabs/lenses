# Calling Lenses

The examples leave out `--catalog`.

## Passing parameters

Ask `hn/top` for the second page:

```sh
lens call hn/top --params '{"page": 2}'
```

The client checks parameters against the types the lens declares, before anything runs. It does not convert types, so `{"page": "2"}` fails: `page` is an integer, and `"2"` is a string.

## Reading the result

Every result has a `kind`: `value`, `outcome` or `error`. Check it before you read anything else.

### `value`: the lens got the data

```json
{
  "kind": "value",
  "value": {
    "stories": [
      { "title": "Show HN: …", "score": "312", "item_url": { "$lens": "@djgrant/hn/item", "params": { "id": "41234567" } } }
    ],
    "next_page": { "$lens": "@djgrant/hn/top", "params": { "page": 2 } }
  },
  "resolver": "dom",
  "tab": "t1834"
}
```

`value` always matches the shape the lens declares, so `stories` is always an array of objects with a `title`.

`item_url` and `next_page` are follow-up calls. To get page 2, call what `next_page` names:

```sh
lens call @djgrant/hn/top --params '{"page": 2}'
```

### `outcome`: the page is in a known state

The page is in a state the lens author named, usually signed out. From `claude/usage`:

```json
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": { "$lens": "@djgrant/claude/login" },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
}
```

`hint` is for a person to read. `value` is a follow-up call that fixes the problem.

In a terminal, `lens call` waits up to two minutes for you to sign in, then runs the lens again. Outside a terminal it returns the outcome at once. `--auth-lease-ms` sets the wait; `0` turns it off.

### `error`: the call failed

```json
{
  "kind": "error",
  "code": "writes_not_allowed",
  "message": "@djgrant/chatgpt/send performs writes; call it with allowWrites: true to consent"
}
```

The most common error is a shape mismatch: the page changed, and the data no longer fits the declared shape. The result then lists each mismatch in `issues`. `--lax` returns the value anyway, with the mismatches in `warnings`.

**The CLI exits with 1 only for errors.** An outcome exits with 0, so a script that checks only the exit status treats "signed out" as success. Read `kind` instead. The [CLI reference](../api/cli.md) lists every error code.

## Calling again in the same tab

Pass a result's `tab` id back to run in the same browser tab:

```sh
lens call hn/item --params '{"id": "41234567"}' --tab t1834
```

Use this when a site keeps state in the tab, such as a half-finished form. A closed tab fails with `tab_closed`.

## Cached results

`hn/top` declares that its results stay fresh for 60 seconds. A second call within a minute returns the first result, marked `"cached": true`, without loading the page. Only values are cached. `--no-cache` forces a fresh read.

## Lenses that change things

`chatgpt/send` types a message and presses send. The broker refuses lenses that change things unless you pass `--allow-writes`:

```sh
lens call chatgpt/send --params '{"message": "hello"}' --allow-writes
```

A retry can send the message twice, so check the result first:

- `"performed": true` means the write happened. Do not retry.
- A timeout error carries a `mutation` object. If its `performed` is `"unknown"`, check the site before you retry.

A lens marked `idempotent` is safe to retry. `lens list` shows the flag. [Write and File Lenses](./write-lenses.md) explains how authors declare writes.

## Lenses that return files

Save a statement PDF into an existing directory:

```sh
lens call bank/statement-pdf --params '{"id": "123"}' --out-dir ~/Statements
```

`value` describes the saved file, with its absolute `path`, `name`, `mimeType` and `bytes`. Without `--out-dir`, the call fails with `out_dir_required`.
