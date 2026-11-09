# Broker and Browser

The broker is a background process that holds the connection to Chrome. You rarely need to think about it. Read this page when a call hangs, Chrome does not connect, or another debugging tool cannot get into Chrome.

## What the broker does

The CLI, the TypeScript client and `lens-mcp` all send calls over a local WebSocket to the broker on port 4319:

```text
lens CLI ───────┐
your app ───────┼──► broker :4319 ──► Chrome
lens-mcp ───────┘
```

Because every client goes through the broker, they share:

- **One connection to Chrome.** Chrome asks you to approve each connection, so the broker connects once for every client.
- **One cache.** A result that `lens call` fetched is a cache hit for an MCP client a few seconds later.
- **One call at a time.** Two clients never act on the same browser session at once.

## Starting and queueing

The first client call starts the broker if none is running on port 4319, and the broker keeps running after the CLI exits. If a call needs the browser and Chrome is not running, the broker launches it.

A call that arrives while another is running waits in a queue. The CLI prints `queued by serial broker concurrency policy (1 ahead)`.

## How the broker connects to Chrome

The broker tries Playwright Extension first. If the extension is not installed or does not connect, it falls back to Chrome's remote debugging protocol, CDP. [Installation](./installation.md) sets up both, and the Chrome profile.

**The broker reads its settings only when it starts.** If a broker is already running, `lens call --profile "Profile 4"` connects to it and the flag has no effect. Run `lens broker shutdown` after you change the profile or token.

## When the broker stops

The broker exits once no client is connected and no call is running: after 15 minutes if Chrome is open, or 10 seconds if no browser is reachable. `LENS_BROKER_IDLE_EXIT_MS=0` keeps it running.

## Checking on the broker

When a call is stuck or the browser does not connect, run `lens status`. It prints JSON. Read these fields first:

- `connected`: whether the broker has a working connection to Chrome.
- `backend`: `playwright-extension` or `cdp`.
- `diagnostics`: the running call and the number of queued calls.
- `advice`: present when you need to act, for example `Approve the Playwright Extension connect page to continue this browser acquisition.`

`lens status` starts the broker if none is running. `--wait-ms 30000` gives the browser up to 30 seconds to connect before it reports.

## Controlling the broker

The broker's connection to Chrome is the **lease**. Chrome allows only one consented debugging connection, so while the broker holds the lease, tools such as `chrome-devtools-mcp` cannot connect. `lens broker status` reports `lease` as `held`, `released` or `disconnected`.

`lens broker release` frees Chrome for another debugging tool. The broker finishes its current call, drops the connection and keeps running. The next lens call takes the lease back without a new prompt.

`lens broker acquire` reconnects at once and retries Playwright Extension, which helps if the broker fell back to CDP because you missed the connect page.

`lens broker shutdown` stops the broker. It also helps when every call fails with `broker_busy`, which means an earlier call timed out while the broker was still working in the browser. The error clears once that work finishes.

The broker log is at `~/.cache/lenses/broker.log`, with a timestamp on each line.

## The desktop app

The repository has a prototype menu-bar app in `app/`, started with `pok app start`. It runs its own broker on port 4319 and its own built-in browser instead of your Chrome, and clients work with it unchanged. It does not share Chrome's cookies, so you sign in to each site again; pages that need a sign-in appear in the app's inbox. It does not yet fill passwords or passkeys, handle downloads, or ship as a packaged, signed app.
