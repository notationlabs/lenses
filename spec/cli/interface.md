---
title: Run the lens CLI
---
# Run the lens CLI

## Context

`@djgrant/lenses` installs the `lens` command, a JSON adapter over the client. Evidence: `packages/cli/src/index.ts`, `packages/cli/src/graphql-server.ts`.

## Rules

- **JSON to stdout:** Every command prints its result as pretty-printed JSON on stdout; `--verbose` writes timestamped diagnostics to stderr without contaminating the JSON.
- **Catalog requirement:** `--catalog` (repeatable, tried in order) is required except for `status`, `observe`, `broker`, `eval`, and `skill`; `gen` may take catalogs as operands instead.
- **Help:** `--help` or a bare `lens` prints usage (command-specific when a command is named); an unrecognised command fails.
- **Option bounds:** Numeric options must be non-negative safe integers, and `--port` must be within 1–65535.
- **Call operand:** `call` takes exactly one lens operand, and `--params` must parse as a JSON object; `--lax` demotes result-schema violations to warnings; the whole-call timeout defaults to 90000 ms.
- **Eval offline:** `eval` takes one JSONata expression, reads its data from `--input` or piped stdin (none on a TTY), binds `--params` as JSONata variables, and needs no catalog or browser.
- **Observe selector:** `observe --request` treats an all-digit value as a request index and anything else as a URL substring.
- **Status wait:** `status --wait-ms` waits up to that long for a browser backend before reporting.
- **Broker actions:** `broker` accepts exactly `status`, `release`, `acquire`, or `shutdown`.
- **Skill output:** `skill` prints an agent SKILL.md (frontmatter included) teaching lens calling and authoring; it needs no catalog or browser.
- **Graphql loopback:** `graphql <playground|serve>` compiles the catalog to a GraphQL schema served on 127.0.0.1 only, refusing cross-origin requests with 403; without `--listen` it scans upward from port 4381 for a free port, and each operation gets a lens-call budget of `--max-calls` (default 25).

## Outcomes

- **Update report:** `update` refreshes cached catalog sources and prints the lens count per source.
- **List report:** `list` prints the broker status alongside the validated lens summaries.
- **Eval null note:** An `eval` expression that produces no result prints `null` and writes a stderr note.

## Failures

- **Non-zero exit:** A thrown error prints its message to stderr and exits non-zero; a printed result whose `kind` is `error` also sets the exit status to 1.