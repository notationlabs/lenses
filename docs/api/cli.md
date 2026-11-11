# CLI

The `lens` command runs lenses from a terminal or a script. Install it from npm:

```sh
npm install @notation/lenses
```

`lens --help` lists all commands, and `lens <command> --help` prints the help for one.

## Catalogs

A catalog is a directory or git repository of lens files. Give one with `--catalog`, or `-c`:

```sh
lens call hn/top --catalog ./examples
```

There is no default catalog, so `list`, `call`, `schema`, `update` and `graphql` fail without one. The other commands need none. Repeat `--catalog` to search several catalogs in order. A source is a directory path such as `./examples`, or a git reference such as `git:github.com/owner/repo#main/lenses`; see [Catalogs](../manual/catalogs.md).

## The broker

Most commands send their work to the broker, a background process that keeps a connection to Chrome open. The first command that needs it starts it, and it keeps running. It listens on port 4319; `--port`, or `-p`, picks another. See [Broker and Browser](../manual/broker.md).

## Output and exit status

Results go to stdout, as JSON except for `skill`, `gen ts-sdk` and `graphql`. Errors go to stderr, and `--verbose`, or `-v`, adds diagnostics there.

A lens call returns one JSON object whose `kind` is `"value"`, `"outcome"` or `"error"` (see [Calling lenses](../manual/calling.md)). The CLI exits with 1 for an error, or when it cannot run the command at all, such as when `--params` is not valid JSON. Otherwise it exits with 0.

**An outcome exits with 0.** A script that checks only the exit status treats `needs_auth` ("you are signed out") as success, so read `kind`.

## `call`

`lens call` runs one lens and prints its result. Name the lens by shortname (`hn/item`), full name (`@djgrant/hn/item`), or file path or URL.

```sh
lens call hn/item -c ./examples --params '{"id": "8863", "page": 2, "limit": 10}'
```

- `--params <json>` passes parameters as a JSON object. Values must have the declared types, so `"2"` fails where the lens wants an integer.
- `--timeout-ms <number>` limits the whole call. The default is 90000.
- `--auth-lease-ms <number>` sets how long to wait for you to sign in after `needs_auth`. The default is 120000 in a terminal and 0 (no wait) outside one.
- `--tab <id>` runs in the browser tab named by an earlier result's `tab`.
- `--no-cache` ignores a fresh cached result.
- `--allow-writes` permits lenses that change something on the site, such as `chatgpt/send`. Without it, they are refused.
- `--out-dir <dir>` is an existing directory for downloaded files. Lenses that download require it.
- `--lax` returns a value that does not match the declared shape, with the mismatches in `warnings`. Without it, a mismatch is an error.

[Write and File Lenses](../manual/write-lenses.md) covers writes and downloads.

## `list`

`lens list` prints every lens in the catalog with its parameters.

```sh
lens list -c ./examples
```

Each entry in `lenses` has `name`, `shortname`, `url`, `description`, `params`, `effects` and `exceptions`.

## `schema`

`lens schema` prints a JSON Schema (draft 2020-12) for the value a lens returns, built from the lens file's `returns` field.

```sh
lens schema hn/top -c ./examples
```

## `observe`

`lens observe` loads a page and prints a text snapshot with the JSON requests it made, to show where its data comes from. See [Authoring](../manual/authoring.md).

```sh
lens observe 'https://hn.algolia.com/?query=rust'
```

Each request has an `index`, `method`, `url`, `status`, `bodyChars` and a short `bodyPreview`.

- `--request <selector>` prints the bodies of matching requests instead. A number matches `index`; other text matches URLs that contain it.
- `--tab <id>` observes a tab from an earlier result. Without a URL, it reads the tab as it is. With one, it moves the tab there without a full page load, so you stay signed in.
- `--html` also prints the HTML, without scripts, styles or comments.
- `--wait-ms <number>` sets how long to collect requests after load. The default is 4000.
- `--timeout-ms <number>` limits the whole command. The default is 60000.

## `eval`

`lens eval` runs a JSONata expression against local JSON, so you can try it before you put it in a lens:

```sh
lens call hn/top -c ./examples | jq .value | lens eval --as value '[$value.stories.{ "t": title }]'
```

There is no implicit input. The JSON goes in `$res.body`, where a lens finds an HTTP response body, unless you set `--as`. [Expressions and Templates](./expressions.md) lists the variables.

- `--input <file>` reads JSON from a file instead of stdin.
- `--as <name>` puts the JSON in `$<name>`. Give the name without the `$`.
- `--params <json>` sets `$params`.

An empty result prints `null` and writes `expression produced no result` to stderr.

## `gen ts-sdk`

`lens gen ts-sdk` writes TypeScript types for every lens in one or more catalogs, so the compiler checks lens names, parameters and results. See [TypeScript](../manual/typescript.md).

```sh
lens gen ts-sdk ./examples -o src/lenses.gen.ts
```

Give catalogs as arguments or with `--catalog`. `--out`, or `-o`, writes to a file instead of stdout.

## `status`

`lens status` prints whether the broker is connected to Chrome, any recent errors, and an `advice` field that suggests fixes when calls fail.

```sh
lens status --wait-ms 5000
```

`--wait-ms <number>` first waits up to that long for a browser connection.

## `broker`

`lens broker` controls the broker's connection to Chrome, called the lease. While the broker holds it, tools such as `chrome-devtools-mcp` cannot connect to Chrome.

```sh
lens broker release
```

- `status` prints `connected` and `lease`, which is `held`, `released` or `disconnected`.
- `release` drops the connection so another tool can use Chrome. The next lens call retakes it.
- `acquire` reconnects to Chrome.
- `shutdown` stops the broker after the current call. The next command starts a new one.

`--timeout-ms <number>` limits the action. The default is 60000.

Two flags apply when the CLI starts a broker. `--profile <name>` picks the Chrome profile (default `Default`). `--playwright-extension-token <token>` passes the Playwright Extension's token, so you need not approve each connection. A running broker keeps its settings, so run `lens broker shutdown` after changing them. [Configuration](./configuration.md) shows other ways to set both.

## `update`

`lens update` fetches the latest commits for git catalogs and prints each catalog's lens count. Directory catalogs are read on every call.

```sh
lens update -c git:github.com/owner/repo#main/lenses
```

## `graphql`

`lens graphql` serves the catalog as a GraphQL API on your machine, with each lens as a query field. [GraphQL](../manual/graphql.md) explains the schema.

```sh
lens graphql playground -c ./examples
```

`playground` serves the API at `/graphql` and a query editor at `/`; `serve` serves only the API. Both run until Ctrl-C.

- `--listen <port>` sets the HTTP port. By default it takes the first free port from 4381 up.
- `--max-calls <number>` limits lens calls per query. The default is 25.

## `skill`

`lens skill` prints a skill file that teaches coding agents to call and write lenses. See [Agents](../manual/agents.md).

```sh
mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md
```

## Error codes

An error result always has a `message`, and often a `code`:

- `tab_closed`: the `--tab` tab is closed. Call again without `--tab`.
- `writes_not_allowed`: the lens changes the site, and you did not pass `--allow-writes`.
- `out_dir_required`: the lens downloads a file, and you did not pass `--out-dir`.
- `out_dir_invalid`: the `--out-dir` directory is missing or not writable.
- `file_invalid`: the lens produced a broken or incomplete file. The lens is at fault.
- `perform_failed`: a write lens's step on the page, such as a click, failed. `step` gives its 0-based number.
- `required_backend_unavailable`: the lens needs a browser connection, such as an open tab on the site, that the broker lacks. Open the site in Chrome and retry.
- `broker_busy`: an earlier timed-out call is still running in the browser. Retry later, or run `lens broker shutdown`.

A timeout has no code. Its message says `timed out after` and the time limit.
