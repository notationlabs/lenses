/** Agent skill for the lens CLI, printed by `lens skill` in SKILL.md format. */
export const skillMarkdown = `---
name: lenses
description: Read live web pages as typed function calls through the lens CLI. Use when a task needs data from a website the user is signed into, or when authoring a new lens for an unmapped page.
---

# Lenses

A lens turns a webpage into a typed function. Calls run through the user's own
browser via a Chrome extension, so signed-in sessions work without exporting
cookies. Lenses observe what a page already does — they cannot click, type,
navigate sequences, or fire requests.

Every command prints JSON to stdout and exits non-zero on errors. Pass a catalog
directory with \`--catalog <path>\` (or ask the user where their lens catalog is).

## Calling a lens

\`\`\`sh
lens status --wait-ms 5000        # check the browser extension is connected
lens list --catalog ./examples    # discover lenses, their params and outcomes
lens call hn/item --params '{"id":"42"}' --catalog ./examples
\`\`\`

A call result is one of:

- \`{"kind": "value", "value": ...}\` — the typed result. Fields may contain
  \`$lens\` references: a ready-made follow-up call (lens name + evaluated
  params) for things like pagination. Call it next instead of guessing URLs.
- \`{"kind": "outcome", "name": ...}\` — a declared non-happy path such as
  \`needs_auth\`, optionally carrying the lens that resolves it. An
  \`agent_extract\` outcome contains the page snapshot and an extraction
  prompt: extract the declared \`returns\` shape from the snapshot yourself.
- \`{"kind": "error", "message": ..., "issues": [...]}\` — \`issues\` names
  failing JSON pointers when the value violated the lens's schema. Retry with
  \`--lax\` to receive the value with warnings instead.

## Authoring a lens for an unmapped page

1. Observe the page:

   \`\`\`sh
   lens observe https://example.com/page --wait-ms 4000 --html
   \`\`\`

   This returns the JSON requests the page fired, a text snapshot, and (with
   \`--html\`) stripped body markup for writing CSS selectors.

2. Iterate JSONata offline against a captured response before it goes in a
   document:

   \`\`\`sh
   lens eval '[stories.{ "t": title }]' --input sample.json
   \`\`\`

3. Write a JSON lens document into the catalog. Resolver tiers run in order and
   accumulate fields until \`returns\` is satisfied:
   - \`intercept\` — map a JSON response the page already fetched (preferred).
   - \`dom\` — CSS selectors, optionally a repeating \`item\` selector.
   - \`llm\` — last resort; returns the snapshot and prompt to you.

   \`\`\`jsonc
   {
     "name": "@scope/site/thing",
     "url": "https://site.com/{id}",
     "params": { "id": "string" },
     "returns": { "type": "object", "fields": { "title": "string" } },
     "outcomes": { "needs_auth": { "$lens": "@scope/site/login" } },
     "resolve": [
       { "kind": "intercept",
         "request": "GET https://site.com/api/thing/*",
         "detect": { "needs_auth": "status = 401" },
         "map": { "title": "data.title" } }
     ]
   }
   \`\`\`

4. Call it by file path to test: \`lens call ./my-lens.json --catalog .\`

\`map\`, \`post\`, and \`detect\` are sandboxed JSONata: no network or DOM
access. Declared params are available as variables (\`$id\`) in URL templates
and every expression.

## Other commands

\`\`\`sh
lens schema hn/top                  # JSON Schema (draft 2020-12) for the result
lens gen ts-sdk -o src/lenses.gen.ts  # typed TypeScript SDK for a catalog
\`\`\`

Run \`lens <command> --help\` for full options.
`;
