# Lenses app (prototype)

A menu bar app that runs the lens broker in its own process and drives its own
Chromium, instead of your Chrome. Lens tabs are hidden windows; a call that
needs a sign-in shows its window. CLI, MCP, and library clients reach the app's
broker on the usual port (4319), so nothing else changes.

```sh
pnpm install && pnpm build
pnpm --filter @djgrant/lenses-app start
```

Set `LENS_BROKER_PORT` to run beside an existing broker, then pass the same
port to clients (`lens call hn/top --port 4329`). On start the app asks any
broker already on its port to shut down.

The menu bar item opens a control panel: broker status, the running call, open
windows, and a field to open a site and sign in. Sessions live in the app's
profile (`~/Library/Application Support/Lenses`), separate from Chrome.

Not yet: password and passkey filling, packaging and signing, an address bar
in sign-in windows. Electron's remote debugging port is open on localhost while
the app runs, as Chrome's is when remote debugging is enabled.
