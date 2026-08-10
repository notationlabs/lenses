---
title: Perform write steps before resolution
---

# Perform write steps before resolution

## Context

A $LensDocument may declare a top-level `perform` block — an ordered list of write steps !execute runs once against the bound page, after bind and before the resolver walk. The resolve tiers then read the result back through the machinery that already exists; readback is not a second call. Evidence: `packages/core/src/engine.ts`, `packages/core/src/page-functions.ts`, `packages/core/src/validate.ts`, `packages/core/test/engine.test.ts`, `packages/core/test/page-functions.test.ts`.

## Rules

- **Step opcodes:** A step is exactly one of `{fill, value}`, `{click}`, `{press}`, `{wait}`, or `{navigate: "fresh"}` — a closed, validated union; unknown keys fail closed at validation.
- **Fill semantics:** `fill` focuses the single element the selector resolves to, selects all, and inserts text via `insertText` — never a `value=` property write, which ProseMirror-style editors ignore. Zero or multiple matches hard-error the step.
- **Fill value is an expression:** `value` is a JSONata expression over declared params (`"$message"`), evaluated before any step runs; an expression that produces nothing errors the call before the page is touched.
- **Click semantics:** `click` clicks the first visible match and errors on zero matches or a disabled/`aria-disabled` target.
- **Press semantics:** `press` takes named keys (`Enter`, `Meta+Enter`), never key codes.
- **Wait forms:** A `wait` declares exactly one of `appears` (≥1 match present), `gone` (0 matches; stateless, immediately true when already satisfied), or `increases` (match count exceeds the baseline sampled at step entry). Every form takes `timeoutMs` (default 10000); the poll interval is internal.
- **Navigate fresh:** `navigate: "fresh"` reloads the bound target — the same reload a fresh bind performs; a tab that has drifted off-origin navigates back to the expanded lens `url` and settles. `"fresh"` is the only navigation.
- **Browser is forced:** A document with `perform` always binds a browser; the http-only short-circuit does not apply.
- **Bind reuses the tab:** `perform` present binds with `reuse` navigation — a reload only ever comes from an explicit `navigate` step, so a send cannot reload the chat it is about to type into. One session spans `perform` and `resolve`.
- **Pre-perform detect:** The document-level `detect` runs once against `{url, title}` after bind, before step 0; a hit returns that outcome and no step runs.
- **Consent is per call:** The host runs `perform` only when the caller passed `allowWrites` (CLI `--allow-writes`, MCP `lens_call` `allowWrites`); the default is deny at every layer, and nested calls and `$lens` param defaults never inherit it.

## Outcomes

- **Performed flag:** Any result — value, outcome, or error — from a call whose `perform` ran every step carries `performed: true`; absence means the write did not happen.
- **Readback result:** After a successful perform the resolver pipeline runs as usual and its result is the call's result, with `performed: true` attached.
- **Detect over timeout:** A `wait` timeout re-runs the document `detect` against `{url, title}`; a hit (e.g. `needs_auth`) returns that outcome instead of `perform_failed`.

## Failures

- **Denied write:** A `perform` document called without `allowWrites` is refused with an error carrying `code: "writes_not_allowed"`; it never carries `performed`.
- **Step failure aborts:** A step failure errors the call with `code: "perform_failed"` and the 0-based `step`; the page is left as-is, no tier runs, and there is no partial resolve after a half-send. `perform_failed` never carries `performed`.
- **Host cannot act:** A host without a `perform` capability errors the call rather than silently skipping the steps.
- **Miss after commit:** A resolve miss after a successful perform is still a failed call, but the side effect stands and `performed: true` is the machine-readable scar.

## Invariants

- **Writes are commit-once:** `perform` is not a resolver tier — a failed step never falls through into a second attempt, the orchestrator bypasses the result cache for any document with `perform`, and never auto-retries one.
- **Declaration alone is not permission:** Non-empty `effects.writes` without `perform` stays documentary; permission is `perform` plus the caller's flag.
- **Effects stay declarative:** `effects` remains `{reads, writes, idempotent, cache}` and is never overloaded with opcodes — what a lens does stays split from how it does it.
