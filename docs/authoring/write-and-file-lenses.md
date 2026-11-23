# Write & File Lenses

Notation Lenses supports lenses that mutate site state through browser interactions or HTTP requests, as well as lenses that save downloaded files to disk. Write lenses declare their side effects in `effects.writes` so callers must explicitly pass `--allow-writes`.

## Perform steps

A `perform` array lists browser steps that execute once in order before any `resolve` tier runs. In `examples/chatgpt.send.json`, the lens fills the composer, clicks send, and waits for the reply:

```json [chatgpt.send.json]
{
  "perform": [
    { "wait": { "appears": "#prompt-textarea" } },
    { "fill": "#prompt-textarea", "value": "$params.message" },
    { "wait": { "appears": "[data-testid='send-button']" } },
    { "click": "[data-testid='send-button']" },
    { "wait": { "increases": "section[data-turn='assistant']", "timeoutMs": 30000 } },
    { "wait": { "gone": "[data-testid='stop-button']", "timeoutMs": 120000 } }
  ]
}
```

| Step | Action |
| :--- | :--- |
| `wait` | Polls until a selector matches `appears`, `gone`, or `increases` |
| `fill` | Sets an input value or inserts text into a contenteditable editor |
| `click` | Clicks the first visible matching element that is not disabled |
| `submit` | Populates named form fields and triggers native `requestSubmit` |
| `press` | Dispatches synthetic `keydown` and `keyup` events to the active element |
| `drop` | Reads a local file and dispatches drag-and-drop events onto a target |
| `navigate` | Reloads the lens URL when set to `"fresh"` |

Each step uses specific DOM mechanics so modern frameworks observe the interaction:

- **`wait` forms** – Supply one of `appears`, `gone`, or `increases`, with optional text and timeout (default 10000 ms). Place an increasing wait right after the triggering action because it samples the baseline count at step entry.
- **`fill` target** – Uses the native input or textarea value setter plus an `input` event, or `insertText` on contenteditable elements. The selector must match one element.
- **`click` matching** – Skips hidden elements, pierces shadow roots with `a >>> b`, and accepts an optional `text` template selecting the innermost text match. Wait steps share both behaviors.
- **`submit` forms** – Sets matching native controls or appends hidden inputs before calling `requestSubmit`.
- **`press` keys** – Sends synthetic key events to the active element and does not trigger trusted native form submits.
- **`drop` file rules** – Set `file` to literal `"$params.<name>"` naming a declared string parameter without a default. Callers must pass an absolute file path at runtime.
- **`navigate` reload** – Setting `"navigate": "fresh"` reloads the lens URL, as used in `examples/chatgpt.clear.json` to discard a logged-out chat.

If any step fails, Lenses halts before running resolvers and returns `code: "perform_failed"` with the 0-based `step` index, unless the landed page matches a declared exception. Once every step completes, the call result carries `"performed": true` even if subsequent readback fails.

## Declaring writes and idempotency

Lenses cannot infer side effects from `perform` steps because clicking a button may only open a menu. Declare every mutation in `effects.writes`:

```json [chatgpt.send.json]
{
  "effects": {
    "reads": ["chatgpt.com"],
    "writes": ["chatgpt.com (sends a message in the logged-out chat)"],
    "idempotent": false,
    "cache": 0
  }
}
```

When `effects.writes` is non-empty, `effects.cache` must be `0` or omitted so callers never receive a cached response without executing the write.

Set `"idempotent": true` only when repeating the operation produces the same state, such as reloading an empty chat in `chatgpt/clear`.

When a non-idempotent `perform` call times out or an HTTP mutation fails with ambiguous transmission state, Lenses skips remaining resolvers and attaches a `mutation` object.

That object reports `performed` as `"no"`, `"yes"`, or `"unknown"` so callers know whether retrying could duplicate the write.

## Sending an HTTP request body

An `http` resolver can mutate remote state directly by setting `body` alongside a non-`GET` method such as `POST`:

| Format | Encoding |
| :--- | :--- |
| `json` | Evaluates one expression and sends `application/json` |
| `text` | Evaluates one expression and sends plain text |
| `form` | Maps field names to expressions for multipart form data |
| `search` | Maps field names to expressions for URL-encoded form parameters |

```json [post-message.json]
{
  "kind": "http",
  "request": { "method": "POST", "url": "https://example.com/api/messages" },
  "credentials": true,
  "body": { "json": "{ 'message': $params.message }" }
}
```

Any HTTP method other than GET, HEAD, or OPTIONS counts as a write and fails validation unless `effects.writes` is non-empty. GET and HEAD requests cannot declare `body`.

Body expressions read `$params`, and chained `sources` bodies also read earlier replies via `$sources`.

## File lenses

Set `"returns": { "type": "file" }` at the top level of a lens document when the lens saves a binary or text file instead of returning JSON. A file resolver's `map` produces content, encoding, media type, and an optional filename:

```json [statement-pdf.json]
{
  "returns": { "type": "file" },
  "resolve": [
    {
      "kind": "http",
      "credentials": true,
      "map": {
        "content": "$res.body.content",
        "encoding": "'base64'",
        "mimeType": "'application/pdf'",
        "name": "'Statement-' & $params.id & '.pdf'"
      }
    }
  ]
}
```

`encoding` must be `"base64"` or `"utf8"`. Missing fields, invalid base64 payloads, or unsafe filenames fail with `code: "file_invalid"` before any write occurs.

File lenses follow three runtime safeguards:

- **32 MiB capture limit** – `http` and `intercept` tiers on a file lens buffer response bodies up to 32 MiB instead of the 512 KiB limit used for JSON lenses.
- **Download suppression** – While a file lens runs and for 5 seconds afterward, Lenses blocks `<a download>` clicks in the page so the browser does not save a duplicate copy into Downloads.
- **Output directory** – Callers must pass `--out-dir` or the call fails with `out_dir_required` or `out_dir_invalid`. Lenses writes the decoded file into that directory and returns its saved metadata.

See [Resolvers & Fallbacks](./resolvers-and-fallbacks.md) for combining `http`, `intercept`, and `dom` readback tiers.
