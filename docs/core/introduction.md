# Introduction

Notation Lenses turns a webpage, or the API behind it, into a typed function that returns validated JSON. Lenses runs calls against your signed-in Chrome session, so a lens can read or act on pages behind authentication without asking for passwords or API tokens.

You can call a lens from the `lens` CLI, from TypeScript, from an AI agent over MCP, or through a GraphQL server. Install the CLI and connect Chrome in [Installation](./installation.md), then run your first calls in [Quickstart](./quickstart.md).

## Typed calls over live sites

Running a lens returns a structured JSON result with a `kind`, a `value` matching the lens contract, and the `resolver` tier that produced it:

```sh [Terminal]
lens call hn/top -c git:github.com/notationlabs/lenses#main/examples
```

```json [Result]
{
  "kind": "value",
  "value": {
    "stories": [
      {
        "title": "My YC app: Dropbox - Throw away your USB drive",
        "url": "https://www.getdropbox.com/u/2/screencast.html",
        "id": "8863",
        "score": "104 points",
        "comments": "71 comments",
        "item_url": {
          "$lens": "@djgrant/hn/item",
          "params": { "id": "8863" }
        }
      }
    ],
    "next_page": {
      "$lens": "@djgrant/hn/top",
      "params": { "page": 2 }
    }
  },
  "resolver": "dom",
  "tab": "t1"
}
```

`item_url` and `next_page` are typed `$lens` references rather than raw URLs. Each reference names the target lens and its parameters so callers can follow links by making another call.

## A lens is a JSON document

Each lens document declares its target URL, input parameters, `returns` schema, and `resolve` tiers:

```json [examples/hn.top.json]
{
  "name": "@djgrant/hn/top",
  "url": "https://news.ycombinator.com/news?p={params.page}",
  "params": {
    "page": { "type": "integer", "default": 1 }
  },
  "returns": {
    "type": "object",
    "fields": {
      "stories": {
        "type": "array",
        "items": {
          "title": "string",
          "score": { "type": "string", "nullable": true },
          "item_url": {
            "$lens": "@djgrant/hn/item",
            "params": { "id": "$item.id" }
          }
        }
      }
    }
  },
  "resolve": [
    {
      "kind": "dom",
      "item": ".athing",
      "fields": {
        "id": { "selector": ":self", "attr": "id" },
        "title": { "selector": ".titleline > a" },
        "score": { "selector": ".score", "scope": "+" }
      }
    }
  ]
}
```

The client validates every resolved value against `returns`. If a site changes and extracted data no longer matches the schema, Lenses returns a structured error listing the failing paths instead of returning malformed data. See [Writing a Lens](../authoring/writing-a-lens.md) to author a lens from scratch.

## Signed-in sessions and outcomes

A background broker process connects to your Chrome session, so sites like `claude.ai` see your existing browser login. Lenses never asks for your password or exposes raw cookies to lens documents.

When your browser is signed out, a lens can return an `outcome` named `needs_auth` instead of failing with a generic error:

```json [Outcome]
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": {
    "$lens": "@djgrant/claude/login"
  },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call.",
  "resolver": "http"
}
```

Because expected states are declared in the lens document, your code or agent can branch on `kind` and follow `hint` instead of parsing error strings.

## Resolver fallback order

A lens can list multiple `resolve` tiers from fastest to most resilient. Lenses runs each tier in order and stops at the first one that satisfies `returns`:

| Tier | Mechanism |
| :--- | :--- |
| `http` | Calls the site API directly using your browser credentials without opening a tab |
| `intercept` | Opens the page and reads JSON responses from the site's network requests |
| `dom` | Queries the rendered page with CSS selectors |
| `llm` | Passes page text to the caller's language model when selectors fail |

While a site's API works, `http` returns data without opening a tab. If the API changes, `intercept`, `dom`, or `llm` still resolves the call through the browser.
