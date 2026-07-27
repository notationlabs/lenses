# Roadmap

- **Batch calls over one tab.** Every call is a full page load, which is fine for a
  few detail rows and painful for forty. A batched call for the same lens over a
  parameter list could reuse one bound tab and navigate through it.
- **Headless browser profile.** Calls open visible tabs in the user's Chrome; a scheduled sync wants a dedicated profile (or headless instance) running the same CDP host, so it does not fight the interactive session for window focus.
- **Python SDK.** `lens gen ts-sdk` now generates a first-party TypeScript SDK, and
  `lens schema` emits standard JSON Schema for external codegen; Python needs both
  a generated-types step and a runtime client speaking to the broker or MCP server.
- **Content-pin remote lenses.** A lens loaded by URL is fetched as-is on every
  call, so its author can change it after you started trusting it. An SRI-style
  hash in the ref would pin the content.
- **Report the extension's build stamp.** The content script bundles the page
  functions, so Chrome keeps extracting with the copy it loaded until the
  extension is reloaded — and from outside, that is indistinguishable from a fix
  that was never shipped. `broker-stamp.ts` already solves this for the daemon;
  the extension should send the same kind of stamp in its `extension-hello`, and
  `status` should report it. It has to travel with the running instance: when
  this last bit, both `packages/lens/dist/page-functions.js` and
  `extensions/chrome/dist/content.js` were current and only Chrome's in-memory
  copy was stale, so any build-side or mtime comparison would have reported a
  confident all-clear. The manifest version cannot serve either, since a local
  rebuild never moves it.
