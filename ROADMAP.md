# Roadmap

- **TypeScript codegen from lens schemas.** `lens schema` now emits standard JSON
  Schema for a lens's `returns`, so typed bindings can be generated externally;
  first-party `lens types` output would remove that extra step.
- **Intercept requests made by service workers.** The intercept tier patches
  `fetch`/XHR in the page world, so requests made by a site's own service worker
  never pass through the patch and are invisible to lenses.
- **Content-pin remote lenses.** A lens loaded by URL is fetched as-is on every
  call, so its author can change it after you started trusting it. An SRI-style
  hash in the ref would pin the content.
- **Firefox extension.** Firefox's `filterResponseData` offers native response
  interception; the current extension is Chromium-only.
