---
title: Resolve through the dom tier
---

# Resolve through the dom tier

## Context

A dom tier extracts fields from the rendered document with CSS selectors, executed inside the page. Evidence: `packages/lens/src/resolvers/dom.ts`, `packages/lens/src/page-functions.ts`, `packages/lens/test/page-functions.test.ts`.

## Rules

- **Verbatim selector expansion:** `{name}` holes in `item`, field selectors, and field scopes expand from declared parameters verbatim — never percent-encoded — before the spec crosses into the page.
- **Repeating items:** With `item`, the tier yields one object per matching element and each field selector is scoped to that element; without it, fields resolve once against the whole document.
- **First match wins:** A field's selector reads the first matching element; the special selector `:self` reads the scoped element itself.
- **Attribute reads:** `attr` reads that attribute instead of text; non-empty `href` and `src` values are resolved to absolute URLs against the page.
- **Scope moves the root:** `scope: "+"` (or `"+ sel"`, which also requires the sibling to match) runs the field's selector from the item's next element sibling; any other value is an ancestor selector resolved with `closest()`; `sibling: true` is the deprecated spelling of `"+"`.
- **Rendered text:** A field without `attr` reads rendered `innerText` with horizontal whitespace runs collapsed to one space, line breaks preserved, and blank-line runs capped at one; elements without `innerText` (SVG, MathML) fall back to fully collapsed `textContent`.
- **Blank versus missed:** An element that is present but blank reads `""`; only a missed selector (or scope) yields null for that field.
- **Post projection:** `post` is a JSONata expression applied to the extracted value.

## Failures

- **Nothing extracted is a miss:** A null extracted value, an empty item list, or a null `post` result misses.
- **Dom miss provenance:** Every dom miss carries the landed URL so a caller can see that the tier was reading the wrong page.

## Outcomes

- **Dom value:** An extracted value returns kind `value` with resolver `dom` and `observed` set to the page's landed URL.
