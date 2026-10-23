/**
 * The app's browser and lens tabs, run in Electron for the end-to-end tests.
 * Two endpoints, on a port printed as `HARNESS <port>`:
 *
 * - /cdp: the broker's view, a browser-level CDP endpoint over the lens tabs
 *   through the same relay the broker uses (one relay per connection).
 * - /control: the user's side, and what the tests check: open user tabs, run
 *   script in any page as the user would, list every page the app holds.
 */
import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createElectronRelay } from "@djgrant/lenses-client/electron-host";
import { createBrowser, type Browser } from "../src/browser.js";
import { createLensTabs } from "../src/lens-tabs.js";

// Compiled to dist-test/test/, so static/ is two levels up.
const staticDir = fileURLToPath(new URL("../../static/", import.meta.url));

// A fresh profile: no cookies from earlier runs, and no clash with a running app.
app.setPath("userData", mkdtempSync(join(tmpdir(), "lenses-app-test-")));
app.on("window-all-closed", () => {});
// To stderr, which the tests show, rather than a dialog.
process.on("uncaughtException", (error) => console.error("uncaught:", error));

let browser: Browser;
const lensTabs = createLensTabs({
  open: (url) => browser.openLensTab(url),
  reveal: (contents) => browser.reveal(contents),
});

export interface PageInfo {
  id: number;
  url: string;
  /** A tab in the browser window, or a popup in a window of its own. */
  where: "tab" | "popup";
  kind?: "lens" | "user";
  /** Listed for the broker. */
  exposed: boolean;
  visible: boolean;
}

function pages(): PageInfo[] {
  const exposed = new Set(lensTabs.tabs.list());
  return webContents
    .getAllWebContents()
    .filter((contents) => !contents.isDestroyed() && contents !== browser.window.webContents)
    .filter((contents) => !contents.getURL().startsWith("devtools:"))
    .map((contents) => {
      const kind = browser.kindOf(contents);
      const owner = kind ? browser.window : BrowserWindow.fromWebContents(contents);
      return {
        id: contents.id,
        url: contents.getURL(),
        where: kind ? "tab" : "popup",
        ...(kind ? { kind } : {}),
        exposed: exposed.has(contents.id),
        visible: owner?.isVisible() ?? false,
      } satisfies PageInfo;
    });
}

function contentsOf(id: number): WebContents {
  const contents = webContents.fromId(id);
  if (!contents || contents.isDestroyed()) throw new Error(`no page ${id}`);
  return contents;
}

const control: Record<string, (...args: any[]) => unknown> = {
  pages,
  openUserTab: (url: string) => browser.openUserTab(url).id,
  /** Script in a page with a user gesture, as the user clicking would. */
  evaluate: (id: number, script: string) => contentsOf(id).executeJavaScript(script, true),
  showWindow: () => browser.show(),
  close(id: number) {
    contentsOf(id).close();
  },
  reveal(id: number) {
    lensTabs.tabs.reveal(id);
  },
};

function serveControl(socket: WebSocket): void {
  socket.on("message", async (raw) => {
    const { id, method, params = [] } = JSON.parse(String(raw));
    try {
      const fn = control[method];
      if (!fn) throw new Error(`unknown control method ${method}`);
      socket.send(JSON.stringify({ id, result: (await fn(...params)) ?? null }));
    } catch (error) {
      socket.send(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

function serveCdp(socket: WebSocket): void {
  const relay = createElectronRelay(lensTabs.tabs, (message) => console.error(message));
  const trace = process.env.HARNESS_TRACE ? (line: string) => console.error(line.slice(0, 400)) : () => {};
  relay.transport.onmessage = (message) => {
    trace(`<- ${message}`);
    socket.send(message);
  };
  socket.on("message", (raw) => {
    trace(`-> ${raw}`);
    relay.transport.send(String(raw));
  });
  socket.on("close", () => relay.dispose());
}

app.whenReady().then(() => {
  browser = createBrowser({ staticDir, changed: () => {}, lensOpened: lensTabs.add });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket, request) => {
    if (request.url === "/cdp") serveCdp(socket);
    else if (request.url === "/control") serveControl(socket);
    else socket.close();
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address === "object") console.log(`HARNESS ${address.port}`);
  });
});
