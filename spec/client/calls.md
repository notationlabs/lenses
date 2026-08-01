---
title: Call a lens through the client
---

# Call a lens through the client

## Context

The @caller invokes !call (or !value) on the TypeScript client; the client owns discovery, parameter validation, TTL caching, result validation, and the broker connection. Evidence: `packages/client/src/index.ts`, `packages/client/test/client.test.ts`.

## Rules

- **Lazy broker binding:** Constructing a client is synchronous and has no side effects; the broker is bound on first use, and a transport whose socket closes is dropped so the next call rebinds.
- **Construction guards:** A broker port outside 1–65535, a port combined with a custom transport, or an empty catalog string rejects construction.
- **TTL cache:** Results are cached per document-plus-parameters for `effects.cache` seconds; only complete (non-partial, non-cached) value results are stored, and a hit is returned with `cached: true`.
- **Strict validation:** A value result is validated against the schema derived from `returns`; in strict mode (the default) a violation becomes an error result carrying the issues, with a message naming the failing pointers and the URL the value was read from — `no resolver produced field …` when fields are missing, `result failed its schema at …` otherwise.
- **Lax validation:** With `strict: false`, violations attach to the value result as `warnings` instead of failing it.

## Outcomes

- **Listing:** !list returns one $LensSummary per document — name, shortname (the name after its scope), url, params, effects, declared outcome names, and any non-fatal document warnings.
- **Value unwrap:** !value returns the resolved value of a value result.
- **Catalog refresh:** !update refreshes cached sources from their origins, reloads, and reports the lens count per source.

## Failures

- **Bad input is a result:** An unknown lens parameter, missing parameter, or unexpandable URL hole returns an error result rather than throwing.
- **Outcome throw:** !value throws `LensOutcomeError` for an outcome result, carrying the outcome name, its value, and the `hint` string from the document's outcome declaration — `hint` is the only key read from a declaration.
- **Error throw:** !value throws `LensResultError` for an error result, carrying the message and any validation issues.
