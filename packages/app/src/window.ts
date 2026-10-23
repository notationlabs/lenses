/**
 * The app's window, opened only by the user: the inbox (pages that need
 * them) and sites (the lens pages open, by domain), and whichever page they
 * pick, borrowed from the hidden host window while it is on show.
 */
import { app, BrowserWindow, ipcMain, Menu, type Rectangle } from "electron";
import { join } from "node:path";
import { needLabel, type Inbox } from "./inbox.js";
import { addressToUrl, type Pages } from "./pages.js";

export interface AppWindowOptions {
  staticDir: string;
  pages: Pages;
  inbox: Inbox;
  /** The user is done with an inbox item. */
  done(page: number): void;
  /** Broker status, for the window's footer. */
  status(): unknown;
}

export function createAppWindow(options: AppWindowOptions) {
  const { pages, inbox } = options;
  let quitting = false;
  let viewport: Rectangle = { x: 260, y: 52, width: 840, height: 708 };

  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: "Lenses",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(options.staticDir, "app-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      devTools: false,
    },
  });
  void window.loadFile(join(options.staticDir, "app.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  app.on("before-quit", () => {
    quitting = true;
  });
  // Lens pages live in the host window; closing this one only hides it.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hide();
  });
  window.on("hide", () => {
    pages.park();
    syncDock();
  });
  window.on("show", syncDock);

  /** Give the page on show back before hiding: the hide event is not always sent. */
  function hide(): void {
    pages.park();
    window.hide();
    syncDock();
  }

  function syncDock(): void {
    if (window.isVisible()) void app.dock?.show();
    else app.dock?.hide();
  }

  const fromWindow = (event: Electron.IpcMainEvent) => event.sender === window.webContents;

  ipcMain.on("app:ready", (event) => {
    if (fromWindow(event)) send();
  });
  ipcMain.on("app:viewport", (event, rect: Rectangle) => {
    if (!fromWindow(event)) return;
    viewport = rect;
    pages.resize(rect);
  });
  ipcMain.on("app:command", (event, command: string, page?: number, address?: string) => {
    if (!fromWindow(event)) return;
    switch (command) {
      case "select":
        if (page !== undefined) display(page);
        return;
      case "clear":
        return pages.park();
      case "done":
        if (page !== undefined) options.done(page);
        return;
    }
    if (command === "navigate" && page === undefined) {
      // Typed with no page on show: a new page, as a browser's new tab.
      const url = typeof address === "string" ? addressToUrl(address) : undefined;
      if (!url) return;
      const contents = pages.open(url);
      display(contents.id);
      window.webContents.send("select", contents.id);
      return send();
    }
    const contents = page !== undefined ? pages.get(page) : undefined;
    if (!contents) return;
    switch (command) {
      case "back":
        return contents.navigationHistory.goBack();
      case "forward":
        return contents.navigationHistory.goForward();
      case "reload":
        return contents.reload();
      case "stop":
        return contents.stop();
      case "navigate": {
        const url = typeof address === "string" ? addressToUrl(address) : undefined;
        if (url) void contents.loadURL(url).catch(() => {});
        return;
      }
    }
  });

  /** A page on show in the window; a popup shows its opener here and comes forward itself. */
  function display(page: number): void {
    const opener = pages.openerOf(page);
    if (opener !== undefined) {
      pages.show(opener, window, viewport);
      pages.show(page, window, viewport);
    } else {
      pages.show(page, window, viewport);
    }
  }

  function send(): void {
    if (window.isDestroyed()) return;
    window.webContents.send("state", {
      inbox: inbox.items().map((item) => ({ ...item, label: needLabel(item.need, item.site) })),
      pages: pages.list(),
      shown: pages.shown(),
      status: options.status(),
    });
  }

  function installMenu(): void {
    const withShown = (fn: (contents: Electron.WebContents) => void) => () => {
      const id = pages.shown();
      const contents = id !== undefined ? pages.get(id) : undefined;
      if (contents) fn(contents);
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        {
          label: "File",
          submenu: [{ label: "Close Window", accelerator: "CmdOrCtrl+W", click: () => hide() }],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { label: "Open Location", accelerator: "CmdOrCtrl+L", click: () => window.webContents.send("focus-address") },
            { type: "separator" },
            { label: "Reload Page", accelerator: "CmdOrCtrl+R", click: withShown((c) => c.reload()) },
            { label: "Back", accelerator: "CmdOrCtrl+[", click: withShown((c) => c.navigationHistory.goBack()) },
            { label: "Forward", accelerator: "CmdOrCtrl+]", click: withShown((c) => c.navigationHistory.goForward()) },
          ],
        },
        { role: "windowMenu" },
      ])
    );
  }
  installMenu();

  return {
    window,
    /** The user asked for the window, on a page or not. */
    open(page?: number): void {
      if (page !== undefined) display(page);
      window.show();
      window.focus();
      // The user clicked Open: bringing the app forward is what they asked for.
      app.focus({ steal: true });
      window.webContents.send("select", page);
      send();
    },
    send,
  };
}

export type AppWindow = ReturnType<typeof createAppWindow>;
