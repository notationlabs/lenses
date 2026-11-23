# Configuration & Paths

Notation Lenses resolves settings from command-line flags, `createLensClient` options, environment variables, and a user-level JSON file. Because a single persistent broker serves every workspace on a port, Lenses uses no per-project config file.

## Precedence order

Lenses evaluates browser and parameter configuration in strict order from highest priority to lowest.

| Priority | Source |
| :--- | :--- |
| First | CLI flags or `createLensClient` options |
| Second | Process environment variables |
| Third | User file at `~/.config/lenses/config.json` |
| Fourth | Built-in defaults |

When spawning a new broker, CLI flags and client options forward into the broker process as `LENS_BROWSER_PROFILE` and `PLAYWRIGHT_MCP_EXTENSION_TOKEN`.

A running broker keeps its startup settings until it exits or restarts. If a broker is already listening on the target port, passing `--profile` or changing broker environment variables has no effect until you run `lens broker shutdown`.

Parameter defaults merge rather than overwrite across layers: explicit call `params` override `createLensClient` `parameterDefaults`, which override `config.json` defaults and lens declarations.

`LensClient` reads user `params` fresh on client creation without restarting the broker.

## `config.json` structure

Store persistent browser settings and parameter defaults in `~/.config/lenses/config.json`, or `$XDG_CONFIG_HOME/lenses/config.json` when `XDG_CONFIG_HOME` is set.

```json [~/.config/lenses/config.json]
{
  "browser": {
    "profile": "Profile 4",
    "playwrightExtensionToken": "your-playwright-extension-token"
  },
  "params": {
    "@djgrant/hn/*": {
      "page": 1
    },
    "@djgrant/hn/item": {
      "limit": 50
    }
  }
}
```

| Field | Value |
| :--- | :--- |
| `browser.profile` | Chrome profile directory name from `chrome://version` |
| `browser.playwrightExtensionToken` | Connect token copied from the Playwright Extension status page |
| `params` | Map of canonical lens-name globs to parameter defaults |

Each entry inside `params` accepts `string`, `number`, or `boolean` values. Matching globs apply from least specific to most specific by non-wildcard character count, so exact lens names override wildcard patterns.

If `config.json` is missing, unreadable, or malformed JSON, Lenses falls back silently to built-in defaults.

## Environment variables

Client, broker, MCP server, and bundle builds read the following environment variables:

| Variable | Purpose |
| :--- | :--- |
| `LENS_BROKER_PORT` | Overrides the default `4319` broker port for `lens-mcp` |
| `LENS_CATALOG` | Comma-separated catalog sources loaded by `lens-mcp` |
| `LENS_BROWSER_PROFILE` | Chrome profile directory used when starting a broker |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | Playwright Extension token skipping manual connect approval |
| `LENS_BROKER_AUTO_LAUNCH` | Set to `"0"` to stop the broker from launching Chrome |
| `LENS_BROKER_IDLE_RELEASE_MS` | Milliseconds after a call before releasing Chrome's debugging slot |
| `LENS_BROKER_IDLE_EXIT_MS` | Idle exit delay in milliseconds while Chrome is reachable |
| `LENS_BROKER_NO_BROWSER_EXIT_MS` | Idle exit delay in milliseconds when Chrome is unreachable |
| `LENS_CACHE_DIR` | Overrides the `~/.cache/lenses` cache directory |
| `LENS_BROKER_AUTH_FILE` | Overrides the `~/.config/lenses/broker-auth.json` token path |
| `LENSES_BUNDLED` | Set to `"1"` in published bundles to skip workspace source lookups |
| `XDG_CONFIG_HOME` | Replaces `~/.config` for `config.json` and `broker-auth.json` |

`LENS_BROKER_PROFILE` defaults to `"Default"`. `LENS_BROKER_IDLE_RELEASE_MS` defaults to 0.

`LENS_BROKER_IDLE_EXIT_MS` defaults to 900000 milliseconds with 0 disabling idle exit, and `LENS_BROKER_NO_BROWSER_EXIT_MS` defaults to 10000 milliseconds.

## Disk paths and Playwright Extension

Lenses stores user configuration, credentials, logs, and cloned git catalogs across XDG config and cache directories.

| Path | Role |
| :--- | :--- |
| `~/.config/lenses/config.json` | Persistent browser profile, extension token, and `params` defaults |
| `~/.config/lenses/broker-auth.json` | Random 32-byte HMAC credential created with mode `0600` |
| `~/.cache/lenses/broker.log` | Timestamped broker stderr log rotated at 1 MiB to `broker.log.1` |
| `~/.cache/lenses/tab-handover.json` | Mode `0600` tab handover file expiring 2 minutes after broker exit |
| `~/.cache/lenses/git/` | Shallow clones of `git:` catalog sources keyed by SHA-256 hash |

`tab-handover.json` preserves open **Lenses** group tabs across broker restarts and is deleted as soon as the replacement broker reads it.

The broker connects to Chrome through the Playwright Extension.

| Extension detail | Value |
| :--- | :--- |
| Extension ID | `mmlmfjhmonkocbjadbfplnigmagldckm` |
| Connect page URL | `chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html` |
| Chrome Web Store URL | `https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm` |

Install the extension inside the target Chrome profile before calling browser-backed lenses. See [Installation](../core/installation.md) for setup steps.
