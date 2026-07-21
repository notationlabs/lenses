# Roadmap

- **Batch calls over one tab.** Every call is a full page load, which is fine for a
  few detail rows and painful for forty. A batched call for the same lens over a
  parameter list could reuse one bound tab and navigate through it.
- **Headless browser profile.** Calls open visible tabs in the user's Chrome; a
  scheduled sync wants a dedicated profile (or headless instance) running the same
  extension, so it does not fight the interactive session for window focus.
- **Python SDK.** `lens gen ts-sdk` now generates a first-party TypeScript SDK, and
  `lens schema` emits standard JSON Schema for external codegen; Python needs both
  a generated-types step and a runtime client speaking to the broker or MCP server.
- **Intercept requests made by service workers.** The intercept tier patches
  `fetch`/XHR in the page world, so requests made by a site's own service worker
  never pass through the patch and are invisible to lenses.
- **Content-pin remote lenses.** A lens loaded by URL is fetched as-is on every
  call, so its author can change it after you started trusting it. An SRI-style
  hash in the ref would pin the content.
- **Firefox extension.** Firefox's `filterResponseData` offers native response
  interception; the current extension is Chromium-only.
