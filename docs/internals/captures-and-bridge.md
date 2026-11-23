# Captures, Bridge & Downloads

Notation Lenses records network traffic, executes DOM helpers inside pages, blocks duplicate browser downloads, and writes deduplicated screenshots across shared utilities in Core and Client.

## Cursor ring buffer and capture limits

`createCaptureBuffer` maintains a ring buffer capped at 200 `InterceptedResponse` entries (`CAPTURE_BUFFER_CAP`) indexed by a monotonic `nextCursor`.

`readCaptures` returns entries at or after the requested cursor. When no new entries exist yet, it long-polls once until the deadline and wakes immediately via `wakeCaptureWaiters` on push or reset; stale cursors before `oldestCursor` set `truncated: true`.

`createPageCaptures` attaches one response listener per Puppeteer `Page` via `WeakMap`, storing JSON or text responses whose trimmed body starts with `{` or an opening bracket:

| Call type | Per-response body cap |
| :--- | :--- |
| Standard call | `MAX_BODY_BYTES` at 512 KiB |
| File lens | `MAX_FILE_BODY_BYTES` at 32 MiB |

When `returnsFile(spec)` is true, `cdp-host.ts` sets the page's capture limit to 32 MiB instead of the default 512 KiB.

## Serializable page helpers and stamp

Exported helpers in `page-functions.ts` (`pageDomExtract`, `pageGuardDownloads`, `pageSnapshot`, and perform helpers) must remain self-contained with zero imports or module closures because hosts serialize only the function source when evaluating in the page.

`pageFunctionsStamp()` (`page-stamp.ts`, exposed via `@notation/lenses/page-stamp`) computes and caches a 16-character SHA-256 hex digest over the canonical `page-functions.ts` source so packaged and workspace builds share a stable source fingerprint.

## Download guard for file lenses

When a file lens runs, `cdp-host.ts` enables `pageGuardDownloads({ on: true })` so the browser does not save a duplicate copy alongside `saveFile` output. The guard intercepts three trigger paths for `<a download>` elements:

1. **`HTMLAnchorElement.prototype.click`** – Drops calls on anchors that declare a `download` attribute.
2. **`EventTarget.prototype.dispatchEvent`** – Returns false for click events targeting `<a download>`.
3. **Capturing document listener** – Calls `preventDefault()` when a click originates inside `a[download]`.

`releaseDownloadsLater` keeps the guard active for 5000ms (`DOWNLOAD_GUARD_GRACE_MS`) after the call finishes, checking a per-page generation counter so an expiring timer cannot disable a newer call's guard.

## Recording monitor and screenshot deduplication

`RecordingMonitor` polls `recordingState()` every 50ms (`POLL_MS`) and waits 500ms (`SETTLE_MS`) while loading is false and the revision-URL key stays unchanged before capturing a screenshot. If page state changes during capture, the frame is discarded.

`appendRecordingCheckpoint` hashes each PNG's decoded bytes with SHA-256, writes each unique image once to the run directory, and records `duplicateOf` in `index.json` when an identical digest already exists.
