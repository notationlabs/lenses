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
`<webview>`, because the broker tells its tabs apart by CDP opener and a
guest has none. Inactive tabs are parked off-screen at full size, not
hidden, so lens tabs keep painting and can be screenshotted. Closing the
window hides it: lens tabs live there. ⇧⌘S shows broker status.

Sessions live in the app's profile (`~/Library/Application Support/Lenses`),
separate from Chrome.

Not yet: password and passkey filling, packaging and signing, downloads, tab
reordering. Electron's remote debugging port is open on localhost while
the app runs, as Chrome's is when remote debugging is enabled.
