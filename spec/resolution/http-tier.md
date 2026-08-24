---
title: Resolve through the http tier
---

# Resolve through the http tier

## Context

An http tier fires its own requests through the host instead of reading a page's, so a call it satisfies never binds a page. Evidence: `packages/core/src/resolvers/http.ts`, `packages/core/test/engine.test.ts`.

## Rules

- **Default request:** With neither `request` nor `sources`, the tier GETs the lens's canonical `url`; a `request` is `"METHOD url-template"` and an omitted method defaults to GET.
- **URL expansion encodes:** `{name}` holes in a request URL are filled percent-encoded; header values expand the same holes verbatim.
- **Bodies:** A single request or each chained source may declare exactly one encoding: `{json: expr}`, `{text: expr}`, `{form: {field: expr}}`, or `{search: {field: expr}}`. Expressions evaluate over params and prior source bindings. JSON and text serialize to strings; form creates multipart `FormData`; search creates URL-encoded `URLSearchParams`. Form/search arrays emit repeated fields.
- **Write consent:** Any method other than GET, HEAD, or OPTIONS is a write. The document must declare non-empty `effects.writes` and no positive cache, and the host refuses the call with `writes_not_allowed` unless the caller explicitly passes `allowWrites`.
- **Dotted holes address bodies:** `{name.path.to.value}` holes address into an earlier source's bound body and must resolve to a scalar; the scalar goes into the URL percent-encoded.
- **Chained sources:** `sources` are fetched in declaration order; each response body (through its `items` expression) binds as the JSONata variable `$name`, a scalar binding also fills plain `{name}` holes in later request templates, and structured bindings are reached with dotted holes. A source may override `credentials` and define headers whose JSONata values see earlier bindings.
- **Progressive detection:** With `sources`, detection runs after each response over the `$name` contexts fetched so far — a detected outcome stops the chain.
- **Credentialed requests:** `credentials: true` asks any capable host to send browser cookies; the extension serves it from its service worker. `credentials: "same-origin-page"` makes either extension or CDP evaluate fetch in an existing page matching the request origin. Backend/context selection occurs before transmission and unavailability returns `required_backend_unavailable` rather than missing into another tier.
- **Mutation retry safety:** An ambiguous failure from a non-idempotent mutation ends the call; Lens does not resend it through another resolver. Read-only or explicitly idempotent failures may miss into later tiers.

## Outcomes

- **Http value:** A projected value returns kind `value` with resolver `http` and `observed` set to the landed URL (comma-joined source URLs for a chain).
- **Per-item mapping:** In the single-request form, a `map` over an array working value applies per item; with `sources`, `map` evaluates once over the `$name` bindings, and without `map` the bindings object itself is the value.

## Failures

- **Host cannot fetch:** A host without an `httpFetch` capability misses the tier.
- **Network failure is a miss:** A failed request, including an unexpandable hole, misses rather than erroring the call.
- **Network failure falls through:** The miss lets later page tiers reach the same site through the browser and still succeed.
- **Non-2xx is a miss:** After detection, a response with status outside 200–299 misses.
- **Non-2xx diagnostic:** The miss names the response status and URL.
- **Empty value is a miss:** A source binding, working value, or projection that is null or undefined misses.
- **Empty value diagnostic:** The miss names the URL it drew nothing from.
