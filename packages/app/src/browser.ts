/**
 * The app's browser: one window of tabs, each a WebContentsView. Lens tabs
 * (and their popups) are handed to the broker as they open; tabs the user
 * opens never are, so nothing can attach to them. Modelled on T3 Code's
 * in-app browser: chrome row, popup policy, permission allowlist, context
 * menu.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type Rectangle,
  type WebContents,
  type WindowOpenHandlerResponse,
} from "electron";
import { join } from "node:path";

export type TabKind = "lens" | "user";

export interface TabState {
  id: number;
  kind: TabKind;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

interface Tab {
  id: number;
  kind: TabKind;
  view: WebContentsView;
  /** Kept: a destroyed view no longer has its contents. */
  contentsId: number;
  favicon?: string;
  error?: string;
}

export interface BrowserOptions {
  staticDir: string;
  /** Anything outside the tabs changed; the app pushes fresh state. */
  changed(): void;
  /** A lens tab, or a popup or tab a lens tab opened: the broker's to drive. */
  lensOpened(contents: WebContents): void;
}

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Room around the views for the tab strip and chrome row, until the renderer measures it. */
const DEFAULT_INSETS: Insets = { top: 80, right: 0, bottom: 0, left: 0 };
/** Inactive tabs keep their size off to the side: a hidden view stops painting, and the broker screenshots them. */
const PARKED_OFFSET = 20_000;

/**
 * As T3 Code: clipboard writes need `clipboard-sanitized-write` in both
 * handlers, and fullscreen fills the view rather than the window. Not
 * notifications (pages would post them as Lenses) nor local fonts.
 */
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

const TAB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // Lens tabs run while parked or while the window is hidden.
  backgroundThrottling: false,
  disableHtmlFullscreenWindowResize: true,
} as const;

/** A real window for scripted popups: OAuth needs `window.opener` to post its result back. */
const POPUP_OPTIONS: BrowserWindowConstructorOptions = {
  width: 520,
  height: 680,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
};

const isWebUrl = (raw: string) => {
  try {
    return ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
};

/**
 * T3 Code's split: `new-window` is a scripted popup, a link to a new tab
 * becomes a tab, and anything a new tab could not carry (a POST body, an odd
 * scheme) loads in place.
 */
function windowOpenAction(details: HandlerDetails): "popup" | "tab" | "navigate" | "deny" {
  if (details.url === "" || details.url === "about:blank") return "deny";
  if (!isWebUrl(details.url)) return "navigate";
  if (details.disposition === "new-window") return "popup";
  if (details.postBody) return "navigate";
  return details.disposition === "foreground-tab" || details.disposition === "background-tab"
    ? "tab"
    : "navigate";
}

/** Address bar input: a URL as typed, a bare host, or a search. */
export function normaliseAddress(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

export function createBrowser(options: BrowserOptions) {
  const tabs: Tab[] = [];
  const byContents = new Map<number, Tab>();
  let nextId = 1;
  let activeId: number | undefined;
  let insets = DEFAULT_INSETS;
  let quitting = false;
  let focusAddressOnLoad = false;

  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 420,
    title: "Lenses",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(options.staticDir, "browser-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  void window.loadFile(join(options.staticDir, "browser.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  app.on("before-quit", () => {
    quitting = true;
  });
  // Lens tabs live in this window: closing it hides it.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on("show", syncDock);
  window.on("hide", syncDock);
  window.on("resize", layout);

  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  );
  defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );

  function syncDock(): void {
    if (window.isVisible()) void app.dock?.show();
    else app.dock?.hide();
  }

  function state(tab: Tab): TabState {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      kind: tab.kind,
      title: contents.getTitle(),
      url: contents.getURL(),
      favicon: tab.favicon,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: tab.error,
    };
  }

  function send(): void {
    if (window.isDestroyed()) return;
    window.webContents.send("tabs", { tabs: tabs.map(state), activeId });
    const active = tabs.find((tab) => tab.id === activeId);
    window.setTitle(active ? active.view.webContents.getTitle() || "Lenses" : "Lenses");
    options.changed();
  }

  /** Insets rather than a rect, so the views follow a resize before the renderer measures again. */
  function viewportBounds(): Rectangle {
    const [width = 0, height = 0] = window.getContentSize();
    return {
      x: insets.left,
      y: insets.top,
      width: Math.max(1, width - insets.left - insets.right),
      height: Math.max(1, height - insets.top - insets.bottom),
    };
  }

  function layout(): void {
    const bounds = viewportBounds();
    for (const tab of tabs) {
      const parked = tab.id !== activeId;
      tab.view.setBounds(parked ? { ...bounds, x: bounds.x - PARKED_OFFSET } : bounds);
    }
  }

  /** Each tab, whoever made it: listeners, popups, shortcuts, menu. */
  function adopt(view: WebContentsView, kind: TabKind, activate: boolean): Tab {
    const contents = view.webContents;
    const tab: Tab = { id: nextId++, kind, view, contentsId: contents.id };
    tabs.push(tab);
    byContents.set(contents.id, tab);
    view.setBackgroundColor("#ffffff");
    window.contentView.addChildView(view);

    const update = () => send();
    contents.on("did-start-loading", () => {
      tab.error = undefined;
      update();
    });
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", update);
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons[0];
      update();
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // -3 is an aborted load: a redirect or a new navigation, not a failure.
      if (!isMainFrame || code === -3) return;
      tab.error = description;
      update();
    });
    contents.setWindowOpenHandler((details) => openFrom(tab, details));
    contents.on("did-create-window", (popup) => {
      // As T3 Code: one popup deep. Nothing in an OAuth flow opens a second.
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      installContextMenu(popup.webContents);
      if (tab.kind === "lens") options.lensOpened(popup.webContents);
    });
    installContextMenu(contents);
    // The broker closing a page, or the page calling window.close().
    contents.once("destroyed", () => remove(tab));

    if (activate) activeId = tab.id;
    layout();
    send();
    if (kind === "lens") options.lensOpened(contents);
    return tab;
  }

  function openFrom(opener: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    const action = windowOpenAction(details);
    if (action === "popup") return { action: "allow", overrideBrowserWindowOptions: POPUP_OPTIONS };
    if (action === "navigate") {
      void opener.view.webContents.loadURL(details.url).catch(() => {});
      return { action: "deny" };
    }
    if (action === "deny") return { action: "deny" };
    // A tab that keeps its opener, so a lens tab's links stay the broker's.
    return {
      action: "allow",
      outlivesOpener: true,
      createWindow: (windowOptions) => {
        const view = new WebContentsView({
          webContents: (windowOptions as { webContents?: WebContents }).webContents,
          webPreferences: { ...windowOptions.webPreferences, ...TAB_PREFERENCES },
        });
        adopt(view, opener.kind, details.disposition === "foreground-tab" && opener.id === activeId);
        return view.webContents;
      },
    };
  }

  function remove(tab: Tab): void {
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    tabs.splice(index, 1);
    byContents.delete(tab.contentsId);
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (activeId === tab.id) activeId = (tabs[index] ?? tabs[index - 1])?.id;
    layout();
    send();
  }

  function find(id: number | undefined): Tab | undefined {
    return tabs.find((tab) => tab.id === id);
  }

  function activate(id: number): void {
    if (!find(id)) return;
    activeId = id;
    layout();
    send();
    find(id)?.view.webContents.focus();
  }

  function show(): void {
    window.show();
    window.focus();
    app.focus({ steal: true });
  }

  function openUserTab(url?: string): void {
    const view = new WebContentsView({ webPreferences: TAB_PREFERENCES });
    const tab = adopt(view, "user", true);
    if (url) void view.webContents.loadURL(normaliseAddress(url)).catch(() => {});
    else focusAddress();
    show();
    if (url) tab.view.webContents.focus();
  }

  function focusAddress(): void {
    if (window.webContents.isLoading()) focusAddressOnLoad = true;
    window.webContents.focus();
    window.webContents.send("focus-address");
  }
  window.webContents.on("did-finish-load", () => {
    send();
    if (focusAddressOnLoad) window.webContents.send("focus-address");
    focusAddressOnLoad = false;
  });

  function closeTab(id: number | undefined): void {
    const tab = find(id);
    if (!tab) return;
    tab.view.webContents.close();
  }

  function cycle(step: number): void {
    if (tabs.length === 0) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    activate(tabs[(index + step + tabs.length) % tabs.length]!.id);
  }

  function active(): WebContents | undefined {
    return find(activeId)?.view.webContents;
  }

  function installContextMenu(contents: WebContents): void {
    contents.on("context-menu", (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      const history = contents.navigationHistory;
      if (isWebUrl(params.linkURL)) {
        template.push(
          { label: "Open Link in New Tab", click: () => openUserTab(params.linkURL) },
          { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
          { type: "separator" }
        );
      }
      if (params.isEditable || params.selectionText) {
        template.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
          { type: "separator" }
        );
      }
      template.push(
        { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
        { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
        { label: "Reload", click: () => contents.reload() },
        { type: "separator" },
        { label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) }
      );
      Menu.buildFromTemplate(template).popup({ window });
    });
  }

  function installMenu(): void {
    const withActive = (fn: (contents: WebContents) => void) => () => {
      const contents = active();
      if (contents) fn(contents);
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        {
          label: "File",
          submenu: [
            { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => openUserTab() },
            { label: "Open Location…", accelerator: "CmdOrCtrl+L", click: () => (show(), focusAddress()) },
            { type: "separator" },
            { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => closeTab(activeId) },
            { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => window.hide() },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { label: "Reload", accelerator: "CmdOrCtrl+R", click: withActive((c) => c.reload()) },
            {
              label: "Hard Reload",
              accelerator: "CmdOrCtrl+Shift+R",
              click: withActive((c) => c.reloadIgnoringCache()),
            },
            { type: "separator" },
            {
              label: "Developer Tools",
              accelerator: "Alt+CmdOrCtrl+I",
              click: withActive((c) => c.toggleDevTools()),
            },
            { label: "Lenses Developer Tools", click: () => window.webContents.toggleDevTools() },
            { type: "separator" },
            { label: "Toggle Status Panel", accelerator: "CmdOrCtrl+Shift+S", click: () => togglePanel() },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "History",
          submenu: [
            {
              label: "Back",
              accelerator: "CmdOrCtrl+[",
              click: withActive((c) => c.navigationHistory.goBack()),
            },
            {
              label: "Forward",
              accelerator: "CmdOrCtrl+]",
              click: withActive((c) => c.navigationHistory.goForward()),
            },
          ],
        },
        {
          role: "windowMenu",
          submenu: [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", click: () => cycle(1) },
            { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", click: () => cycle(-1) },
            ...Array.from({ length: 9 }, (_, index) => ({
              label: `Tab ${index + 1}`,
              accelerator: `CmdOrCtrl+${index + 1}`,
              visible: false,
              click: () => {
                const tab = index === 8 ? tabs.at(-1) : tabs[index];
                if (tab) activate(tab.id);
              },
            })),
          ],
        },
      ])
    );
  }

  /** The broker status panel beside the tabs; `open` forces it either way. */
  function togglePanel(open?: boolean): void {
    show();
    window.webContents.send("toggle-panel", open);
  }

  installMenu();

  const fromRenderer = (event: Electron.IpcMainEvent) => event.sender === window.webContents;
  ipcMain.on("browser:viewport", (event, next: Insets) => {
    if (!fromRenderer(event)) return;
    const round = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));
    insets = { top: round(next.top), right: round(next.right), bottom: round(next.bottom), left: round(next.left) };
    layout();
  });
  ipcMain.on("browser:command", (event, command: string, id?: number, arg?: string) => {
    if (!fromRenderer(event)) return;
    const tab = find(id ?? activeId);
    const contents = tab?.view.webContents;
    switch (command) {
      case "new-tab":
        return openUserTab(arg);
      case "activate":
        return id !== undefined ? activate(id) : undefined;
      case "close":
        return closeTab(tab?.id);
      case "navigate":
        if (!arg) return;
        if (!contents) return openUserTab(arg);
        void contents.loadURL(normaliseAddress(arg)).catch(() => {});
        contents.focus();
        return;
      case "back":
        return contents?.navigationHistory.goBack();
      case "forward":
        return contents?.navigationHistory.goForward();
      case "reload":
        return contents?.reload();
      case "stop":
        return contents?.stop();
      case "devtools":
        return contents?.toggleDevTools();
    }
  });

  return {
    window,
    show,
    togglePanel,
    openUserTab,
    /** A background tab for the broker. */
    openLensTab(url = "about:blank"): WebContents {
      const view = new WebContentsView({ webPreferences: TAB_PREFERENCES });
      adopt(view, "lens", false);
      void view.webContents.loadURL(url).catch(() => {});
      return view.webContents;
    },
    /** Bring a lens tab or popup forward, for a sign-in. */
    reveal(contents: WebContents): void {
      const tab = byContents.get(contents.id);
      if (tab) {
        activate(tab.id);
        show();
        return;
      }
      const popup = BrowserWindow.fromWebContents(contents);
      if (!popup || popup === window) return;
      popup.show();
      popup.focus();
      app.focus({ steal: true });
    },
    tabs: () => tabs.map(state),
    activeId: () => activeId,
    resend: send,
  };
}

export type Browser = ReturnType<typeof createBrowser>;
