---
title: Resolve through the intercept tier
---

# Resolve through the intercept tier

## Context

An intercept tier reads JSON responses the bound page already fetched; it never fires requests of its own. Evidence: `packages/core/src/resolvers/intercept.ts`, `packages/core/src/url-pattern.ts`, `packages/core/test/engine.test.ts`, `packages/core/test/url-pattern.test.ts`.

## Rules

- **Single request as source:** The `request` shorthand is normalised to one source, so both forms share the capture and projection path.
- **Request pattern match:** A source's `"METHOD urlglob"` pattern matches a $CapturedResponse when the method matches (default GET) and the URL matches the glob anchored at both ends, with `*` matching any run of characters.
- **Newest capture wins:** Each source binds the newest captured response that matches its pattern.
- **Reload on miss:** With `reloadOnMiss` and a host that can reload, unmatched sources trigger one reload followed by polling the capture buffer every 250 ms until `waitMs` (default 8000 ms) elapses.
- **Body parse:** A captured body is parsed as JSON, falling back to the raw text.
- **Projection:** Each source's body passes through its `items` expression; with `sources` the tier's `map` evaluates over the `$name` bindings (or the bindings object stands as the value), and in the single-source form `map` applies per item when the working value is an array.

## Failures

- **All sources required:** If any source has no matching capture, the tier misses.
- **Missing source diagnostic:** The miss names the unmatched request patterns.
- **Non-2xx is a miss:** After detection, any matched response with status outside 200–299 misses.
- **Non-2xx meaning:** The miss is the intercept-tier equivalent of a signed-out redirect.
- **Empty value is a miss:** A null or undefined working value, or a null projection over `sources`, misses.
- **Empty value diagnostic:** The miss names the response URLs so a broken expression is not confused with a request that never matched.

## Invariants

- **Passive capture:** Beyond an http tier's declared requests, a lens only observes what the page already does — the intercept tier cannot fire requests or act on the page.
