# Installation

You need Node.js 22.12 or later and Google Chrome.

## 1. Install the package

```sh
npm install -g @notation/lenses
```

This installs the `lens` CLI, the `lens-mcp` server and the TypeScript library. Without `-g`, run the CLI with `npx lens`.

## 2. Install Playwright Extension

Install [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) from the Chrome Web Store. It lets Lenses control the Chrome tabs you approve.

Install it in the Chrome profile you are signed in with. Lenses uses the `Default` profile unless you [choose another](#using-another-chrome-profile).

## 3. Approve the connection

Run a lens that needs the browser:

```sh
lens call claude/usage -c git:github.com/notationlabs/lenses#main/examples
```

Chrome opens the extension's connect page. Pick the tabs Lenses may use. They move into a tab group named **Lenses**, and Lenses opens its own tabs there too.

**Do not close every tab in the Lenses group.** That disconnects the extension, and the next call waits on the connect page again.

## 4. Save the token

Without a token, you approve the connect page again every time the broker restarts. Click the extension's icon to open its status page, copy the token, and save it in `~/.config/lenses/config.json`:

```json
{ "browser": { "playwrightExtensionToken": "<token from the status page>" } }
```

Then restart the broker so it reads the file:

```sh
lens broker shutdown
```

## 5. Check it works

```sh
lens status --wait-ms 10000
```

```json
{
  "connected": true,
  "backend": "playwright-extension",
  …
}
```

If `connected` is `true` and there is no `advice` field, you are done. If there is an `advice` field, it says what to do, for example:

```text
Playwright Extension is not installed; install it from https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm or enable chrome://inspect/#remote-debugging for the CDP fallback (Chrome will ask you to click Allow)
```

## Using another Chrome profile

Open `chrome://version` in the profile you want and copy the last part of "Profile Path", such as `Profile 4`. This is not the name in Chrome's profile menu. Add it to the config file and restart the broker:

```json
{ "browser": { "profile": "Profile 4" } }
```

```sh
lens broker shutdown
```

## Without the extension

If Playwright Extension is not installed or does not connect, Lenses uses Chrome's remote debugging instead. It needs Chrome 144 or later.

1. Open `chrome://inspect/#remote-debugging` and enable remote debugging.
2. Run a lens that needs the browser.
3. Click **Allow** in the dialog Chrome shows. Chrome asks again after each restart.

[Configuration](../api/configuration.md) lists the environment variables and flags for every setting.
