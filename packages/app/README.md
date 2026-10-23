# Lenses app (prototype)

A menu bar app that runs the lens broker in its own process and drives its own
Chromium, instead of your Chrome. CLI, MCP, and library clients reach the
app's broker on the usual port (4319), so nothing else changes.

```sh
pnpm install && pnpm build
pnpm --filter @djgrant/lenses-app start
```

Set `LENS_BROKER_PORT` to run beside an existing broker, then pass the same
port to clients (`lens call hn/top --port 4329`). On start the app asks any
broker already on its port to shut down.

There are no tabs to manage. Lens pages run out of sight, and the app is
built around two things:

- **Sites**: the lens pages open, grouped by domain.
- **The inbox**: pages that need you, such as a sign-in a lens call stopped
  at (a `needs_*` outcome). A page leaves the inbox when a later call on it
  gets through, or when it closes.

When a page joins the inbox, a notice drops down under the menu bar icon,
"Action required", with **Open** and **Ignore**. The app never comes forward
on its own: the notice takes no focus, and only Open (or picking an item from
the menu bar) opens the window, on that page. Ignore only quiets the notice;
the item stays in the inbox and the call keeps waiting until its time runs
out.

Lens pages are `WebContentsView`s in a host window that is never shown; the
window borrows the page you pick and gives it back when you close it. They
keep rendering out of sight (animation frames, lazy loading): Chromium's
occluded-window backgrounding is off. Popups a page opens stay hidden unless
you opened them from the page on show. Sessions live in the app's profile
(`~/Library/Application Support/Lenses`), separate from Chrome. There is no
DevTools: opening it on a lens page would take its debugger from the broker.

Not yet: password and passkey filling, packaging and signing, downloads.

The app opens no remote debugging port. The broker drives each lens page
through its own debugger (`webContents.debugger`), behind an in-process relay
that shows Puppeteer one browser: the Playwright Extension relay's tab model,
with the app in the extension's place. Only lens pages and what they open are
handed to it.

Sign-in pages see an ordinary browser: Electron's own User-Agent, and no
`navigator.webdriver` flag (a debugging port sets it on every page). Either a
User-Agent passing for plain Chrome or the flag makes Google refuse to sign in
("This browser or app may not be secure").

`pnpm test` runs the app in Electron (`test/harness.ts`), with the real broker
for the sign-in tests, against local sites: OAuth popups, signing in from the
notice while a call waits, and lens pages rendering out of sight. Its windows
are see-through and the app never becomes active, so the tests leave your
focus alone; `HARNESS_VISIBLE=1` shows them.
