# Configuration

Settings come from command-line flags, environment variables and `~/.config/lenses/config.json`. A flag wins over an environment variable, and an environment variable wins over the config file.

## Where settings come from

Use a Chrome profile every time:

```json
{ "browser": { "profile": "Profile 4" } }
```

Use a profile for one session:

```sh
lens call hn/top --profile "Profile 4"
```

The TypeScript client takes the `browserProfile` option of `createLensClient`. The environment variable is `LENS_BROWSER_PROFILE`.

The client passes the flag to the broker it starts as `LENS_BROWSER_PROFILE`, and the broker reads that variable before the config file. If none of the three is set, the broker uses `Default`.

Parameter defaults are merged instead. Lenses starts with `params` from the config file and applies the `parameterDefaults` option of `createLensClient` on top. **Explicit call parameters always win.**

## A running broker keeps its settings

The broker reads its settings once, at startup, and it outlives the command that started it. If a broker is already running, `lens call --profile "Profile 4"` connects to it, and the flag has no effect.

Restart the broker to apply a new profile:

```sh
lens broker shutdown
lens call hn/top --profile "Profile 4"
```

The same applies to the browser token and every `LENS_BROKER_*` variable. Parameter defaults are the exception: the client reads `params` on every command.

## The config file

The config file is `~/.config/lenses/config.json`, or `$XDG_CONFIG_HOME/lenses/config.json` if you set `XDG_CONFIG_HOME`. There is no per-project file, because one broker serves every project.

```json
{
  "browser": {
    "profile": "Profile 4",
    "playwrightExtensionToken": "abc123…"
  },
  "params": {
    "@djgrant/hn/item": { "limit": 50 }
  }
}
```

`browser.profile` is the Chrome profile directory the broker launches Chrome with. Use the directory name at the end of "Profile Path" on `chrome://version`. Playwright Extension must be installed in this profile, because the broker connects to Chrome through it.

`browser.playwrightExtensionToken` lets the broker connect to Playwright Extension without asking you. Without it, you approve the extension's connect page each time the broker connects. Copy the token from the extension's status page.

`params` sets default parameters. Each key is a pattern over the scoped lens name, where `*` matches any part, so `@djgrant/hn/*` covers every Hacker News lens. Values must be strings, numbers or booleans. Here `hn/item` returns 50 comments per page instead of 30. [Catalogs](../manual/catalogs.md) explains the matching.

If the file is missing or invalid, lenses uses its defaults.

## Environment variables

Each variable is read by one process: the client, the broker or the MCP server. Broker variables reach the broker through the client that starts it, so set them in that client's shell or MCP config.

### Browser connection

The broker reads these.

- `LENS_BROWSER_PROFILE` sets the Chrome profile, like `browser.profile`. The default is `Default`.
- `PLAYWRIGHT_MCP_EXTENSION_TOKEN` sets the Playwright Extension token, like `browser.playwrightExtensionToken`.
- `LENS_BROKER_AUTO_LAUNCH=0` stops the broker from starting Chrome when Chrome is not running. The broker then connects through Chrome remote debugging (CDP).

### MCP server

The MCP server, `lens-mcp`, lets an agent call lenses. It reads these from the `env` block of the agent's MCP config.

- `LENS_CATALOG` lists the catalogs the server offers, separated by commas. Without it, the agent can only call lenses by path or URL.
- `LENS_BROKER_PORT` sets the broker port. The default is `4319`. The desktop app reads it too, but the CLI uses `--port` instead.

### Broker timing

The broker exits after a period with no connected clients and no running calls, so it does not hold Chrome open forever. Times are in milliseconds.

- `LENS_BROKER_IDLE_EXIT_MS` is how long an idle broker waits before it exits while Chrome is reachable. The default is 15 minutes, and `0` keeps the broker running.
- `LENS_BROKER_NO_BROWSER_EXIT_MS` is how long an idle broker waits before it exits when it cannot reach Chrome. The default is 10 seconds.
- `LENS_BROKER_IDLE_RELEASE_MS` makes the broker disconnect from Chrome this long after the last call, so other CDP tools can connect. It reconnects on the next call. It is off by default.

### Paths

The client and the broker both read these.

- `LENS_CACHE_DIR` moves the cache directory from `~/.cache/lenses`.
- `LENS_BROKER_AUTH_FILE` moves the file that clients and the broker use to authenticate each other, from `~/.config/lenses/broker-auth.json`.
- `XDG_CONFIG_HOME` replaces `~/.config` in the paths of the config file and the auth file.

## Where lenses keeps its files

Settings live in `~/.config/lenses`: `config.json`, which you write, and `broker-auth.json`, a random token that lenses creates so clients can prove to the broker that they may connect.

Everything lenses can rebuild lives in `~/.cache/lenses`: clones of git catalogs under `git/`, which `lens update` refreshes, and `broker.log`. The broker has no terminal, so check `broker.log` when it fails to start or reach Chrome.

Cached lens results are not on disk. The broker keeps them in memory and loses them when it exits. [Calling lenses](../manual/calling.md) explains caching.

The desktop app keeps its own browser profile in `~/Library/Application Support/Lenses`, separate from Chrome, so you sign in to sites again inside the app.
