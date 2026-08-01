---
title: Observe a page for authoring
---

# Observe a page for authoring

## Context

!observe loads a target URL and reports what a lens author needs: the text snapshot and the JSON requests the page made. Evidence: `packages/client/src/index.ts` (`LensClient.observe`), `packages/lens/src/page-functions.ts` (`pageSnapshot`).

## Rules

- **Index by default:** Without `request`, each captured request is listed with its index, method, URL, status, body size, and a 120-character preview; bodies are elided and a note says how to read one.
- **Request drill:** `request` selects captured requests by index (a number) or URL substring (a string); at most 5 matching bodies are returned, with a note when more matched.
- **HTML option:** `html: true` also returns the page's body markup with scripts, styles, noscript, template elements, and comments stripped — the input for writing dom-tier selectors — capped at 80000 characters.

## Failures

- **No matching request:** A `request` selector that matches nothing returns an error naming the selector and the number of captured requests.
