---
title: Match exceptions
---

# Match exceptions

A lens declares named non-happy paths in `exceptions`. Each entry is `null` or an object with `matches` (JSONata), `hint`, `$lens`, and optional expression-valued `params`. Put `matches` first when authoring:

```json
"exceptions": {
  "needs_auth": {
    "matches": "$contains(url, '/login') or status = 401",
    "hint": "Sign in, then retry."
  }
}
```

A catalog can supply `scopes: [{"url": "https://*.example.com/*", "exceptions": {...}}]`. The *-only glob matches the **URL template** at load time; matching scopes merge in order, then the document merges by name and by field. `null` on a document key suppresses the entire inherited exception; `matches: null` only turns off its inherited predicate. These settings apply only to documents in the same catalog directory.

A resolver may declare `exceptions` too. Its matching entries are tried first against that tier's context (including `$name` metadata from named sources); they do not replace the document's page/response predicates. Those are checked separately on every `{url, title}` page and `{status, url, body}` response, including each response of a chained HTTP request **before** the next request. A resolver's `null` key suppresses its inherited matcher. The first matching entry ends the tier.

The firing entry inherits missing `hint`, `$lens`, and `params` fields from the document entry. A `$lens` entry binds params against the firing context and yields a reference; otherwise the result carries that context. The result's `hint` carries resolver-local advice to clients, while the result kind remains `outcome` for consumers.

Legacy `detect` and `outcomes` keys are invalid.
