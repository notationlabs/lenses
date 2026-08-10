---
title: Detect named outcomes
---

# Detect named outcomes

## Context

A document-level `detect` block is shared by every tier; each resolver may declare its own. Evidence: `packages/core/src/resolvers/outcome.ts`, `packages/core/test/engine.test.ts`.

## Rules

- **Resolver detect wins:** The merged detection map lists the resolver's entries first, then the document entries whose names the resolver did not use; a resolver entry of the same name replaces the document's expression outright.
- **First truthy fires:** Entries are evaluated in merged order and the first truthy expression ends the tier with that outcome.
- **Per-tier context:** Each tier evaluates detection against its own context — `{url, title}` for dom, `{status, url, body}` for a single-request intercept or http response, and named `$name` response contexts when a tier declares `sources`.

## Outcomes

- **Lens-typed outcome value:** When the declared outcome carries `$lens`, the outcome value is a reference `{$lens, params?, ...rest}` whose params are the declaration's string-valued expressions evaluated against the detection context; a declaration without parameter expressions yields a reference with no `params` key.
- **Context outcome value:** Any other detected outcome carries the detection context itself as its value.
