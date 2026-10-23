# Lenses app (prototype)

A menu bar app that runs the lens broker in its own process and drives its own
Chromium, instead of your Chrome. Its browser is one window of tabs: lens tabs
(marked ◎) open in the background and come forward when a call needs a
sign-in; tabs you open are for signing in, and the broker never attaches to
them. CLI, MCP, and library clients reach the app's
broker on the usual port (4319), so nothing else changes.

```sh
pnpm install && pnpm build
pnpm --filter @djgrant/lenses-app start
```

Set `LENS_BROKER_PORT` to run beside an existing broker, then pass the same
port to clients (`lens call hn/top --port 4329`). On start the app asks any
broker already on its port to shut down.

The browser follows T3 Code's in-app browser: a tab strip, a chrome row (back,
forward, reload, address bar), real popup windows for OAuth, a permission
allowlist, and a context menu. Each tab is a `WebContentsView` rather than a
`<webview>`: the main process owns every tab, and so decides which the broker
may attach to. Lens tabs stay in place under the tab on show, so they keep
rendering (animation frames, lazy loading) while in the background or while
the window is hidden; a view moved off the window or hidden renders nothing.
A user's background tabs are hidden and draw nothing. Closing the
window hides it: lens tabs live there. ⇧⌘S shows broker status.

Sessions live in the app's profile (`~/Library/Application Support/Lenses`),
separate from Chrome.

Not yet: password and passkey filling, packaging and signing, downloads, tab
reordering.

The app opens no remote debugging port. The broker drives each lens tab
through its own debugger (`webContents.debugger`), behind an in-process relay
that shows Puppeteer one browser: the Playwright Extension relay's tab model,
with the app in the extension's place. Only lens tabs and their popups are
handed to it, so nothing, the broker included, can attach to a tab you opened.

Sign-in pages see an ordinary browser: Electron's own User-Agent, and no
`navigator.webdriver` flag (a debugging port sets it on every page). Either a
User-Agent passing for plain Chrome or the flag makes Google refuse to sign in
("This browser or app may not be secure").
