/**
 * The app, run in Electron for the end-to-end tests: the same parts wired the
 * same way (createLensesApp), with no menu bar icon. Two endpoints, on a port
 * printed as `HARNESS <port>`:
 *
 * - /cdp: the broker's view, a browser-level CDP endpoint over the lens pages
 *   through the same relay the broker uses (one relay per connection).
 * - /control: the user's side, and what the tests check: the inbox, the
 *   notice and its buttons, the window, script in any page as the user would.
 *
 * With HARNESS_BROKER_PORT set, the real broker also runs here on that port.
 */
import { app, BrowserWindow, webContents, type WebContents } from "electron";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createElectronRelay, setElectronHost } from "@djgrant/lenses-client/electron-host";
import { createLensesApp, type LensesApp } from "../src/lenses-app.js";
import { prepareChromium } from "../src/pages.js";

// Compiled to dist-test/test/, so static/ is two levels up.
const staticDir = fileURLToPath(new URL("../../static/", import.meta.url));

// A fresh profile: no cookies from earlier runs, and no clash with a running app.
app.setPath("userData", mkdtempSync(join(tmpdir(), "lenses-app-test-")));
app.on("window-all-closed", () => {});
prepareChromium();

/** Every time the app tried to come forward: shown a window, or taken focus. */
const forward: string[] = [];
const titleOf = (window: BrowserWindow) => window.webContents.getURL().split("/").pop() || window.getTitle();
const show = BrowserWindow.prototype.show;
const focus = BrowserWindow.prototype.focus;
const appFocus = app.focus.bind(app);
// Run without taking the user's focus: the app can never become the active
// app, its windows open without activating, and they are see-through and let
// clicks pass. They still render as shown windows do. HARNESS_VISIBLE=1
// shows them, for debugging.
const quiet = !process.env.HARNESS_VISIBLE;
BrowserWindow.prototype.show = function (this: BrowserWindow) {
  forward.push(`show ${titleOf(this)}`);
  if (quiet) this.showInactive();
  else show.call(this);
};
BrowserWindow.prototype.focus = function (this: BrowserWindow) {
  forward.push(`focus ${titleOf(this)}`);
  if (!quiet) focus.call(this);
};
app.focus = (options) => {
  forward.push("app.focus");
  if (!quiet) appFocus(options);
};
if (quiet) {
  app.on("ready", () => app.setActivationPolicy?.("prohibited"));
  app.once("web-contents-created", (_event, contents) => {
    Object.getPrototypeOf(contents).focus = function () {};
  });
  app.on("browser-window-created", (_event, window) => {
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
  });
}
// To stderr, which the tests show, rather than a dialog.
process.on("uncaughtException", (error) => console.error("uncaught:", error));

let lenses: LensesApp;

export interface PageInfo {
  id: number;
  url: string;
  site: string;
  popup: boolean;
  /** On show to the user: displayed in the app's window, or a popup's window shown. */
  shown: boolean;
  /** Listed for the broker. */
  exposed: boolean;
}

function pages(): PageInfo[] {
  const exposed = new Set(lenses.lensTabs.tabs.list());
  const windowVisible = lenses.appWindow.window.isVisible();
  return lenses.pages.list().map((page) => ({
    id: page.id,
    url: page.url,
    site: page.site,
    popup: page.popup,
    shown: page.popup ? page.shown : page.shown && windowVisible,
    exposed: exposed.has(page.id),
  }));
}

function contentsOf(id: number): WebContents {
  const contents = webContents.fromId(id);
  if (!contents || contents.isDestroyed()) throw new Error(`no page ${id}`);
  return contents;
}

const click = (contents: WebContents, selector: string) =>
  contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);

const control: Record<string, (...args: any[]) => unknown> = {
  pages,
  inbox: () => lenses.inbox.items(),
  notice: () => {
    const state = lenses.notice.state();
    return state ? { ...state, focusable: lenses.notice.window.isFocusable() } : null;
  },
  /** The text the notice shows. */
  noticeText: () => lenses.notice.window.webContents.executeJavaScript(`document.querySelector("#card").innerText`),
  /** The user clicks the notice's Open or Ignore. */
  noticeClick: (button: "open" | "ignore") => click(lenses.notice.window.webContents, `#${button}`),
  /** The window: whether it is open, and the page on show. */
  window: () => ({ visible: lenses.appWindow.window.isVisible(), shown: lenses.pages.shown() ?? null }),
  /** Script in the window's own page, as the user using it. */
  windowEvaluate: (script: string) => lenses.appWindow.window.webContents.executeJavaScript(script, true),
  closeWindow: () => lenses.appWindow.window.close(),
  /** The user opens the window, on a page or not (as from the menu bar). */
  open: (page?: number) => lenses.open(page ?? undefined),
  /** Every time the app tried to come forward since the last ask. */
  forward: () => forward.splice(0),
  /** The broker says a page needs the user. */
  attention: (id: number, need: string) => lenses.lensTabs.tabs.attention(id, need),
  /** A PNG of the window (with the page on show drawn in), the notice, or a page, to `path`. */
  async capture(target: "window" | "notice" | number, path: string) {
    const { writeFileSync } = await import("node:fs");
    if (target === "window") {
      const window = lenses.appWindow.window;
      const base = await window.webContents.capturePage();
      const shownId = lenses.pages.shown();
      const shown = shownId !== undefined ? lenses.pages.get(shownId) : undefined;
      writeFileSync(path, base.toPNG());
      if (shown) writeFileSync(path.replace(/\.png$/, "-page.png"), (await shown.capturePage()).toPNG());
      return;
    }
    const contents = target === "notice" ? lenses.notice.window.webContents : contentsOf(target);
    writeFileSync(path, (await contents.capturePage()).toPNG());
  },
  /** Script in a page with a user gesture, as the user clicking would. */
  evaluate: (id: number, script: string) => contentsOf(id).executeJavaScript(script, true),
  close(id: number) {
    contentsOf(id).close();
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
  const relay = createElectronRelay(lenses.lensTabs.tabs, (message) => console.error(message));
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

app.whenReady().then(async () => {
  lenses = createLensesApp({ staticDir, anchor: () => undefined, status: () => ({ line: "Test" }) });
  const brokerPort = Number(process.env.HARNESS_BROKER_PORT);
  if (brokerPort) {
    setElectronHost({ port: brokerPort, tabs: lenses.lensTabs.tabs });
    await import("@djgrant/lenses-client/broker-daemon");
  }
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
