# lens CLI

Notation Lenses provides the `lens` binary to run lenses, inspect pages, test JSONata expressions, generate TypeScript bindings, and serve GraphQL schemas from a terminal. Install `@notation/lenses` globally or run it via `npx lens`.

```sh [Terminal]
lens --help
lens call --help
```

## Global flags

Every `lens` command shares a set of top-level flags controlling catalog resolution, broker targeting, and diagnostics.

| Flag | Behavior |
| :--- | :--- |
| `-c`, `--catalog` | Catalog directory path, `file:` URI, or `git:` source; repeatable in priority order |
| `-p`, `--port` | Persistent browser broker port |
| `--profile` | Chrome profile directory name used when spawning a new broker |
| `--playwright-extension-token` | Playwright Extension connection token used when spawning a new broker |
| `-v`, `--verbose` | Writes timestamped diagnostic messages to stderr |
| `-h`, `--help` | Prints global or per-command help text and exits |

`-p` defaults to 4319, and `--profile` falls back to `~/.config/lenses/config.json` or Default.

Because an already running broker keeps its startup configuration, `--profile` and `--playwright-extension-token` take effect only when the command starts a fresh broker.

## Catalog requirement and exit codes

Commands divide into catalog-requiring commands and standalone commands that work without `--catalog`.

| Scope | Commands |
| :--- | :--- |
| Catalog-requiring | `list`, `call`, `schema`, `update`, `graphql`, `gen ts-sdk` |
| Standalone | `eval`, `observe`, `broker`, `skill` |

`gen ts-sdk` accepts catalog sources either as positional arguments or via `--catalog`.

Most commands emit JSON to stdout and diagnostics to stderr. `gen ts-sdk` prints TypeScript source unless `--out` is passed, `skill` prints Markdown, and `graphql` prints the bound URL while serving HTTP.

| Exit code | Condition |
| :--- | :--- |
| `0` | Command succeeded, including `kind: "value"` and `kind: "outcome"` call results |
| `1` | Invalid arguments, unhandled runtime error, or a `kind: "error"` result |

Scripts calling `lens call` must check `kind` on stdout rather than treating exit code 0 as data success, because sign-in outcomes such as `needs_auth` also exit 0.

## `list`

Prints every validated lens in the configured catalogs as `{ "lenses": [...] }`.

```sh [Terminal]
lens list -c ./examples
```

| Flag | Behavior |
| :--- | :--- |
| `-c`, `--catalog` | Required catalog source |
| `-p`, `--port` | Persistent browser broker port |
| `-v`, `--verbose` | Writes diagnostics to stderr |

Each returned entry carries the following summary fields:

| Field | Contents |
| :--- | :--- |
| `name` | Scoped lens identifier |
| `shortname` | Group and lens name without scope prefix |
| `url` | Canonical target URL template |
| `description` | Optional human-readable summary |
| `params` | Declared parameter types and defaults |
| `effects` | Declared reads, writes, idempotency, and cache TTL |
| `exceptions` | Enabled named outcomes |
| `warnings` | Non-fatal document warnings when present |

## `call`

Executes a lens by scoped name, shortname, `.json` path, or HTTP URL.

```sh [Terminal]
lens call hn/item -c ./examples --params '{"id":"8863","page":2}'
```

| Flag | Behavior |
| :--- | :--- |
| `--params` | JSON object of declared lens parameters |
| `--timeout-ms` | Execution timeout in milliseconds |
| `--auth-lease-ms` | Sign-in wait duration after `needs_auth` in milliseconds |
| `--tab` | Existing broker tab ID from a previous result |
| `--no-cache` | Ignores cached results and skips caching this result |
| `--allow-writes` | Permits `perform` steps and mutating HTTP methods |
| `--out-dir` | Output directory required by file-returning lenses |
| `--lax` | Moves `returns` schema mismatches into `warnings` instead of failing |

`--timeout-ms` defaults to 90000. `--auth-lease-ms` defaults to 120000 when stdin is a TTY and 0 when non-interactive.

## `schema`

Emits a draft 2020-12 JSON Schema built from a lens document's `returns` contract.

```sh [Terminal]
lens schema hn/top -c ./examples
```

| Flag | Behavior |
| :--- | :--- |
| `-c`, `--catalog` | Required catalog source |
| `-v`, `--verbose` | Writes diagnostics to stderr |

## `gen ts-sdk`

Generates a typed TypeScript SDK module from one or more catalogs.

```sh [Terminal]
lens gen ts-sdk ./examples -o src/lenses.gen.ts
```

| Flag | Behavior |
| :--- | :--- |
| `-o`, `--out` | File path for generated TypeScript source |
| `-c`, `--catalog` | Catalog source when positional catalog arguments are omitted |
| `-v`, `--verbose` | Writes diagnostics to stderr |

Without `--out`, `lens gen ts-sdk` prints the generated module to stdout. Lens names must be unique across all passed catalogs.

## `eval`

Evaluates a JSONata expression in the lens sandbox against local JSON with no browser or catalog required.

```sh [Terminal]
lens call hn/top -c ./examples | jq .value | lens eval --as value '[$value.stories.{ "t": title }]'
```

| Flag | Behavior |
| :--- | :--- |
| `--input` | Reads JSON input from a file instead of piped stdin |
| `--as` | Variable name receiving the parsed JSON input |
| `--params` | JSON object bound to `$params` |

Without `--as`, input JSON binds to `$res.body` to mirror HTTP and intercept resolvers.

Custom variable names cannot be `params`, and an expression producing no value prints `null` with a note on stderr.

## `observe`

Loads a page or attaches to an existing tab to return a text snapshot and captured JSON request index.

```sh [Terminal]
lens observe https://news.ycombinator.com --wait-ms 2000
```

| Flag | Behavior |
| :--- | :--- |
| `--tab` | Existing broker tab ID to inspect or navigate in-page |
| `--request` | Index or URL substring returning full bodies for up to 5 matches |
| `--html` | Includes stripped body HTML for authoring DOM selectors |
| `--wait-ms` | Post-load network capture window in milliseconds |
| `--timeout-ms` | Whole observation timeout in milliseconds |

`observe` requires a target URL, `--tab`, or both. `--wait-ms` defaults to 4000, and `--timeout-ms` defaults to 60000.

## `broker`

Manages the persistent broker's Chrome debugging lease or shuts down the daemon.

```sh [Terminal]
lens broker release
```

| Subcommand | Behavior |
| :--- | :--- |
| `release` | Drops Chrome's debugging slot so other tools can attach |
| `acquire` | Reconnects the broker to Chrome |
| `shutdown` | Drains active calls, releases Chrome, and stops the broker process |

Pass `--timeout-ms` to override the `60000` millisecond default and `-p` to target a non-default broker port.

## `update`

Fetches remote changes for `git:` catalog sources and prints each source's lens count.

```sh [Terminal]
lens update -c git:github.com/notationlabs/lenses#main/examples
```

| Flag | Behavior |
| :--- | :--- |
| `-c`, `--catalog` | Required catalog source |
| `-v`, `--verbose` | Writes diagnostics to stderr |

Directory and `file:` catalogs are read live on every call and are reported unchanged.

## `graphql`

Compiles the catalog into a GraphQL schema and serves it on `127.0.0.1` until interrupted. See [GraphQL Reference](./graphql.md) for schema mapping and runtime behavior.

```sh [Terminal]
lens graphql playground -c ./examples
```

| Subcommand | Behavior |
| :--- | :--- |
| `playground` | Serves GraphiQL at `/` and GraphQL queries at `/graphql` |
| `serve` | Serves `POST /graphql` without the GraphiQL UI |

| Flag | Behavior |
| :--- | :--- |
| `--listen` | Explicit loopback port instead of auto-scanning |
| `--max-calls` | Per-operation lens call budget |
| `-c`, `--catalog` | Required catalog source |
| `-p`, `--port` | Persistent browser broker port |

Without `--listen`, Lenses scans ports 4381 through 4400 and binds the first free port. `--max-calls` defaults to 25.

## `skill`

Prints the built-in agent skill Markdown file teaching coding agents how to run and author lenses.

```sh [Terminal]
mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md
```

No flags other than `-h` or `--help` are needed.

## Error codes

Failed calls return `kind: "error"` with a `message` and, for known failure modes, a structured `code`.

| Code | Cause |
| :--- | :--- |
| `writes_not_allowed` | Lens performs mutations and `--allow-writes` was omitted |
| `perform_failed` | Write step failed on the page; `step` holds the 0-based index |
| `tab_closed` | Target `--tab` was closed before or during the call |
| `out_dir_required` | File-returning lens called without `--out-dir` |
| `out_dir_invalid` | `--out-dir` is not an existing writable directory |
| `file_invalid` | File lens failed to produce valid file payload bytes |
| `broker_busy` | An earlier timed-out call is still executing in the browser |
| `required_backend_unavailable` | Required Chrome extension or site tab connection is unavailable |

Timeouts omit `code` and describe the elapsed limit in `message`. See [Calling Lenses](../core/calling.md) for examples of handling results and outcomes.
