# Installation

Notation Lenses requires Node.js 22.12 or later and Google Chrome. Lenses connects to your running Chrome profile through the Playwright Chrome Extension so calls reuse your existing signed-in sessions.

## Install the CLI and SDK

Install `@notation/lenses` globally to put the `lens` CLI and `lens-mcp` server on your `PATH`:

```sh [Terminal]
npm install -g @notation/lenses
```

To run without a global install, add `@notation/lenses` as a local project dependency and invoke `npx lens` – or run one-off commands directly:

```sh [Terminal]
@pm.dlx("@notation/lenses call hn/top -c git:github.com/notationlabs/lenses#main/examples")
```

## Install the Playwright Extension

Install the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) from the Chrome Web Store in the Chrome profile where you sign in to sites. Lenses connects to the `Default` profile unless you select another.

## Approve the browser connection

Run a lens that requires Chrome:

```sh [Terminal]
lens call claude/usage -c git:github.com/notationlabs/lenses#main/examples
```

Chrome opens the extension's connect page and asks which tabs Lenses may control. Approved tabs move into a Chrome tab group named **Lenses**, where Lenses also opens any new tabs it creates.

Keep at least one tab inside the **Lenses** tab group. Closing every tab in that group disconnects the extension so the next call reopens the connect page.

## Save the extension token

Without a saved token, Chrome asks you to approve the connect page every time the broker starts. Click the Playwright Extension icon in Chrome's toolbar to open its status page and copy the connection token.

Save the token in `~/.config/lenses/config.json`:

```json [~/.config/lenses/config.json]
{
  "browser": {
    "playwrightExtensionToken": "your-playwright-extension-token"
  }
}
```

Or export `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in your shell or MCP environment instead of writing the config file:

```sh [Terminal]
export PLAYWRIGHT_MCP_EXTENSION_TOKEN="your-playwright-extension-token"
```

Restart the broker so it reads the updated configuration:

```sh [Terminal]
lens broker shutdown
```

Run the test call again to confirm no connect page opens:

```sh [Terminal]
lens call claude/usage -c git:github.com/notationlabs/lenses#main/examples
```

If the call returns a `value` result or a `needs_auth` outcome without opening the approval page, the connection is ready. If the extension is missing from the selected profile, Lenses returns an error naming the profile and Chrome Web Store URL.

## Select a Chrome profile

To use a profile other than `Default`, open `chrome://version` in that Chrome window and copy the final directory name from "Profile Path", such as `Profile 4`. Use the directory name on disk rather than the display name in Chrome's profile menu.

Set the profile persistently in `~/.config/lenses/config.json`:

```json [~/.config/lenses/config.json]
{
  "browser": {
    "profile": "Profile 4"
  }
}
```

You can also override the profile for a newly started broker using `--profile` on the CLI or the `LENS_BROWSER_PROFILE` environment variable. Because a running broker reads browser settings only at startup, run `lens broker shutdown` after changing either setting.

See [Configuration](../reference/configuration.md) for all config file fields and environment variables, then continue to [Quickstart](./quickstart.md).
