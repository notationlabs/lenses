# Write and File Lenses

A write lens changes something on a site, such as sending a message, and then reads the page. A file lens saves a file, such as a PDF, instead of returning JSON. This page builds `examples/chatgpt.send.json`, which sends a message in the logged-out chat at chatgpt.com and returns the conversation. It assumes you have read [Writing a Lens](./authoring.md).

## Perform steps

`perform` is a list of steps that the engine runs once, in order, before any `resolve` tier. The tiers then read the page as the steps left it.

Type the `message` parameter, send it, and wait for the reply:

```json
"perform": [
  { "wait": { "appears": "#prompt-textarea" } },
  { "fill": "#prompt-textarea", "value": "$params.message" },
  { "wait": { "appears": "[data-testid='send-button']" } },
  { "click": "[data-testid='send-button']" },
  { "wait": { "increases": "section[data-turn='assistant']", "timeoutMs": 30000 } },
  { "wait": { "gone": "[data-testid='stop-button']", "timeoutMs": 120000 } }
]
```

The `fill` value is an expression, so `$params.message` becomes the text the caller passed.

The `increases` wait counts the assistant turns when it starts, and holds until there is one more. It must come directly after the click, because a wait placed later would count the new turn as already there.

The `gone` wait holds until the stop button disappears. ChatGPT shows that button only while it streams the reply.

After the steps, `chatgpt/send` reads the transcript with the same `dom` and `llm` tiers as `chatgpt/chat`, which has no steps. Keep the read as its own lens, so a caller can read without sending.

If a step fails, the call stops there and no tier runs. The result is an error with `code: "perform_failed"` and `step`, the 0-based index of the failed step. If the page the step landed on matches one of the lens's exceptions, such as a sign-in page, the call returns that outcome instead.

**When every step ran, the result carries `performed: true`, even if the tiers then failed to read the page.** It tells the caller the message has been sent and a retry would send it again.

[Resolvers](../api/resolvers.md) lists every step kind and its fields.

## Declaring writes

The broker cannot tell from the steps whether a lens changes anything, because a click can open a menu as easily as submit a form. The author declares writes in `effects.writes`:

```json
"effects": {
  "reads": ["chatgpt.com"],
  "writes": ["chatgpt.com (sends a message in the logged-out chat)"],
  "idempotent": false,
  "cache": 0
}
```

When `effects.writes` has at least one entry, the broker refuses to run the lens unless the caller passes `--allow-writes`:

```sh
lens call chatgpt/send --params '{"message": "hello"}' --allow-writes
```

Each entry is free text that callers and agents read before they consent, so name the site and say what changes.

A lens whose steps only open a panel or page through a list declares `"writes": []`, and runs without `--allow-writes`.

`effects.cache` must be absent or `0` on a write lens. A cached result would let a second call return without sending anything.

## Idempotent writes

A write is idempotent when running it twice has the same effect as running it once. `chatgpt/send` is not. `chatgpt/clear` is: it reloads the tab, which discards the logged-out conversation, and reloading an empty chat leaves it empty.

Set `effects.idempotent: true` only when this holds. For a lens that is not idempotent, a timeout error carries a `mutation` object whose `performed` field is `"no"`, `"yes"`, or `"unknown"`, so the caller can decide whether a retry is safe. For an idempotent lens, the broker returns a plain timeout error.

## Sending a request body

An `http` tier can write by sending a request body instead of driving the page. The body is an object with one key that names the format, and its value is an expression over `$params`:

```json
{
  "kind": "http",
  "request": { "method": "POST", "url": "https://example.com/api/messages" },
  "credentials": true,
  "body": { "json": "{ 'message': $params.message }" }
}
```

`json` sends `content-type: application/json`. The other formats are `text`, `form` for multipart form data, and `search` for URL-encoded parameters. A `GET` or `HEAD` request cannot have a body.

Any method other than `GET`, `HEAD`, or `OPTIONS` counts as a write, so the lens must list something in `effects.writes` or it fails validation.

## File lenses

A file lens returns a file, such as a bank statement PDF, instead of JSON:

```json
"returns": { "type": "file" }
```

The tier's `map` then describes the file. For a statement that an API returns as base64:

```json
"map": {
  "content": "$res.body.content",
  "encoding": "'base64'",
  "mimeType": "'application/pdf'",
  "name": "'Statement-' & $params.id & '.pdf'"
}
```

`encoding` is `"base64"` or `"utf8"`. `name` is optional. Without it, the broker builds a name from the lens name, a short hash of the content, and an extension that matches the media type.

If a field is missing or the content does not decode, the call fails with `code: "file_invalid"` before anything is written.

The caller does not receive the content. The broker writes the file into the directory passed with `--out-dir`, and `value` describes the saved file:

```json
{
  "path": "/Users/you/Statements/Statement-123.pdf",
  "name": "Statement-123.pdf",
  "mimeType": "application/pdf",
  "bytes": 48213
}
```

[Calling Lenses](./calling.md) covers the caller's side of `--out-dir`.
