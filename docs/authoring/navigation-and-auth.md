# Navigation & Auth States

Notation Lenses handles sign-in gates, missing records, and single-page applications through declarative `exceptions`, tab lifecycle controls, and shared `catalog.json` scopes.

## Declaring exceptions

Declare `exceptions` at the top level of a lens document when a page can land in a non-data state such as a login wall or missing item:

```json [claude.usage.json]
{
  "exceptions": {
    "needs_auth": {
      "$lens": "@djgrant/claude/login",
      "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
    }
  }
}
```

| Field | Purpose |
| :--- | :--- |
| `matches` | JSONata predicate evaluated against page or response state |
| `$lens` | Follow-up lens returned in the outcome value to resolve the state |
| `params` | Object of expressions binding parameters for the `$lens` call |
| `hint` | Human-readable guidance returned alongside the outcome |

When an exception matches, the call stops immediately and returns `"kind": "outcome"` with the exception name instead of continuing to later tiers.

Exception names starting with `needs_` keep the browser tab open for the user to act. Lenses will not navigate a reused tab away from a page that already matches a `needs_` exception, bringing that tab to the front instead.

Individual resolvers can also declare `exceptions` to check tier-local state such as HTTP status codes or extracted DOM text:

```json [tier-exception.json]
{
  "kind": "http",
  "request": { "method": "GET", "url": "https://hn.algolia.com/api/v1/items/{params.id}" },
  "exceptions": {
    "not_found": {
      "matches": "$res.status = 404"
    }
  }
}
```

Tier-local `exceptions` run before inherited or document-level matchers.

They bind `$value` and `$page` on DOM tiers, `$res` on single-request HTTP and intercept tiers, and `$sources` on chained sources tiers.

## Overriding and disabling exceptions

Document exceptions merge key by key over catalog scope exceptions, and tier exceptions merge over document exceptions. A document can supply `$lens` and `hint` while inheriting `matches` from `catalog.json`.

Two `null` patterns disable inherited rules:

- **Disable an entire exception** – Set the named entry to `null` (such as `"not_found": null` in `examples/hn.top.json`) to prevent it from matching at all.
- **Disable only an inherited matcher** – Set `"matches": null` inside an entry to suppress an inherited predicate while keeping the rest of the entry intact.

Legacy `detect` and `outcomes` keys are removed and rejected during validation with errors directing you to `exceptions`.

## SPA and stateful tab options

Single-page applications and banks that store session state in tab memory rather than cookies lose authentication on every fresh page load. Configure tab reuse and client-side routing on those documents:

```json [spa-lens.json]
{
  "tab": "reuse",
  "navigate": "in-page",
  "ready": "ibank-account-card",
  "loadTimeoutMs": 45000
}
```

| Field | Behavior |
| :--- | :--- |
| `tab` | Set to `"reuse"` to run in the site's last open tab without closing it |
| `navigate` | Set to `"in-page"` to change routes via History API instead of reloading |
| `ready` | CSS selector waited on after navigation before running resolvers |
| `loadTimeoutMs` | Maximum milliseconds to wait for load and `ready`, defaulting to `30000` |

After navigation, Lenses waits up to `loadTimeoutMs` until either `ready` matches or a `needs_` exception triggers.

Because `intercept` tiers already wait for matching network requests, `ready` matters most for DOM tiers on client-rendered views.

When authoring against a tab-scoped session, pass `--tab` to `lens observe` so Lenses inspects or routes the existing tab in-page instead of opening a fresh tab:

```sh [Terminal]
lens observe https://bank.example/statements --tab t1 --html
```

## Sharing settings with `catalog.json`

Place a `catalog.json` file alongside your lens documents to share helpers, parameters, and host-specific `scopes` across the directory without duplicating them. Lenses excludes `catalog.json` from lens loading.

```json [catalog.json]
{
  "helpers": {
    "money": "function($s) { $number($replace($s, /[^0-9.]/, '')) }"
  },
  "scopes": [
    {
      "url": "https://bank.example/*",
      "tab": "reuse",
      "navigate": "in-page",
      "exceptions": {
        "needs_auth": {
          "matches": "$contains($page.url, '/sign-in') or $res.status = 401",
          "hint": "Sign in to bank.example in the open tab, then retry."
        }
      }
    }
  ]
}
```

Each entry in `scopes` matches document `url` templates with `*`-only globs in array order, applying tab reuse, in-page navigation, and exceptions.

A document's own `tab`, `navigate`, `params`, and `helpers` override catalog entries by name. Exception rules merge field by field.
