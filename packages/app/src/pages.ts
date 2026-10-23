/**
 * Lens pages: every page the broker drives, and the popups and new tabs they
 * open. Each is a WebContentsView kept in a host window that is never shown,
 * so the user never sees a page until they ask to. The app's window borrows
 * one to display it (show) and gives it back (park).
 */
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  session,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type HandlerDetails,
  type Rectangle,
  type WebContents,
  type WindowOpenHandlerResponse,
} from "electron";

export interface PageState {
  id: number;
  site: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** A popup, in a window of its own. */
  popup: boolean;
  /** For a popup, the page that opened it. */
  opener?: number;
  /** On show in the app's window. */
  shown: boolean;
}

export interface PagesOptions {
  /** A page, popup, or new tab opened: the broker's to drive. */
  opened(contents: WebContents): void;
  /** Any page's URL, title, or loading state changed, or a page closed. */
  changed(): void;
}

/** The size pages lay out at while parked. */
const HOST_SIZE = { width: 1280, height: 860 };

/**
 * As T3 Code: clipboard writes need `clipboard-sanitized-write` in both
 * handlers, and fullscreen fills the view rather than the window. Not
 * notifications (pages would post them as Lenses) nor local fonts.
 */
const ALLOWED_PERMISSIONS = new Set(["clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

const PAGE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // No DevTools: opening them on a lens page would take its debugger from the broker.
  devTools: false,
  // Pages run in the hidden host window.
  backgroundThrottling: false,
  disableHtmlFullscreenWindowResize: true,
} as const;

/** A real window for scripted popups: OAuth needs `window.opener` to post its result back. */
const POPUP_OPTIONS: BrowserWindowConstructorOptions = {
  // Shown only when the user asked for it (see adoptPopup).
  show: false,
  width: 520,
  height: 680,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
};

const isWebUrl = (raw: string) => {
  try {
    return ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
};

/**
 * What the user typed in the address bar, as a URL: a web URL as it is, a
 * bare host given https, anything else a search.
 */
export function addressToUrl(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (isWebUrl(text)) return text;
  // example.com, example.com/path, localhost:3000
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(text)) {
    return `${/^(localhost|127\.)/.test(text) ? "http" : "https"}://${text}`;
  }
  // Not some other scheme (javascript:, file:).
  if (/^[a-z][a-z0-9+.-]*:\S/i.test(text)) return undefined;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/** A page's site: its host, without www. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * T3 Code's split: `new-window` is a scripted popup, a link to a new tab
 * becomes a new page, and anything a new page could not carry (a POST body,
 * an odd scheme) loads in place. Unlike T3 Code, a blank popup is allowed:
 * OAuth libraries open the popup blank inside the click, so no popup blocker
 * stops it, then point it at the provider.
 */
function windowOpenAction(details: HandlerDetails): "popup" | "page" | "navigate" | "deny" {
  const blank = details.url === "" || details.url === "about:blank";
  if (blank) return details.disposition === "new-window" ? "popup" : "deny";
  if (!isWebUrl(details.url)) return "navigate";
  if (details.disposition === "new-window") return "popup";
  if (details.postBody) return "navigate";
  return details.disposition === "foreground-tab" || details.disposition === "background-tab"
    ? "page"
    : "navigate";
}

/**
 * Before the app is ready. Chromium stops drawing a page it judges covered,
 * or in a hidden window, while the page still reports itself visible: lens
 * pages, always hidden, would never run an animation frame or
 * IntersectionObserver, so feeds would never load more and lazy images
 * never load. backgroundThrottling alone does not stop it.
 */
export function prepareChromium(): void {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

export function createPages(options: PagesOptions) {
  const host = new BrowserWindow({
    show: false,
    ...HOST_SIZE,
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, devTools: false, backgroundThrottling: false },
  });
  const views = new Map<number, WebContentsView>();
  /** Popups, each with the page that opened it. */
  const popups = new Map<number, { window: BrowserWindow; opener: number }>();
  /** The page on show, and where. */
  let shown: { id: number; window: BrowserWindow } | undefined;

  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  );
  defaultSession.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));

  const hostBounds = (): Rectangle => ({ x: 0, y: 0, ...HOST_SIZE });

  function watch(contents: WebContents): void {
    const update = () => options.changed();
    for (const event of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
      contents.on(event as "did-stop-loading", update);
    }
    installContextMenu(contents);
  }

  /** A page in the host window, the broker's from the start. */
  function adopt(view: WebContentsView): WebContents {
    const contents = view.webContents;
    const id = contents.id;
    views.set(id, view);
    view.setBackgroundColor("#ffffff");
    host.contentView.addChildView(view);
    view.setBounds(hostBounds());
    watch(contents);
    contents.setWindowOpenHandler((details) => openFrom(id, details));
    contents.on("did-create-window", (popup) => adoptPopup(id, popup));
    contents.once("destroyed", () => {
      views.delete(id);
      if (shown?.id === id) shown = undefined;
      if (!host.isDestroyed()) host.contentView.removeChildView(view);
      options.changed();
    });
    options.opened(contents);
    options.changed();
    return contents;
  }

  function adoptPopup(opener: number, popup: BrowserWindow): void {
    const contents = popup.webContents;
    const id = contents.id;
    popups.set(id, { window: popup, opener });
    // As T3 Code: one popup deep. Nothing in an OAuth flow opens a second.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    watch(contents);
    contents.once("destroyed", () => {
      popups.delete(id);
      options.changed();
    });
    // The user asked for it from the page on show; otherwise the broker did,
    // and it stays out of sight like any lens page.
    if (shown?.id === opener && shown.window.isVisible()) popup.show();
    options.opened(contents);
    options.changed();
  }

  function openFrom(opener: number, details: HandlerDetails): WindowOpenHandlerResponse {
    const action = windowOpenAction(details);
    if (action === "popup") return { action: "allow", overrideBrowserWindowOptions: POPUP_OPTIONS };
    if (action === "navigate") {
      void webContentsOf(opener)?.loadURL(details.url).catch(() => {});
      return { action: "deny" };
    }
    if (action === "deny") return { action: "deny" };
    // A new page that keeps its opener, so it is the broker's too.
    return {
      action: "allow",
      outlivesOpener: true,
      createWindow: (windowOptions) => {
        const view = new WebContentsView({
          webContents: (windowOptions as { webContents?: WebContents }).webContents,
          webPreferences: { ...windowOptions.webPreferences, ...PAGE_PREFERENCES },
        });
        const contents = adopt(view);
        // A link the user followed from the page on show: show where it went.
        const target = shown?.id === opener ? shown.window : undefined;
        if (target?.isVisible() && details.disposition === "foreground-tab") {
          queueMicrotask(() => show(contents.id, target, currentBounds));
        }
        return contents;
      },
    };
  }

  function webContentsOf(id: number): WebContents | undefined {
    const contents = views.get(id)?.webContents ?? popups.get(id)?.window.webContents;
    return contents && !contents.isDestroyed() ? contents : undefined;
  }

  function installContextMenu(contents: WebContents): void {
    contents.on("context-menu", (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      const history = contents.navigationHistory;
      if (isWebUrl(params.linkURL)) {
        template.push({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
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
        { label: "Reload", click: () => contents.reload() }
      );
      Menu.buildFromTemplate(template).popup();
    });
  }

  let currentBounds: Rectangle = hostBounds();

  /** Display a page in `window`, at `bounds` of its content. A popup's own window comes forward instead. */
  function show(id: number, window: BrowserWindow, bounds: Rectangle): void {
    const popup = popups.get(id);
    if (popup) {
      popup.window.show();
      return;
    }
    const view = views.get(id);
    if (!view) return;
    if (shown && shown.id !== id) park();
    currentBounds = bounds;
    host.contentView.removeChildView(view);
    window.contentView.addChildView(view);
    view.setBounds(bounds);
    shown = { id, window };
    // Popups the page opened out of sight come with it.
    for (const entry of popups.values()) if (entry.opener === id) entry.window.show();
    options.changed();
  }

  /** Give the page on show back to the host window. */
  function park(): void {
    if (!shown) return;
    const view = views.get(shown.id);
    const { window } = shown;
    shown = undefined;
    if (view && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (view && !host.isDestroyed()) {
      host.contentView.addChildView(view);
      view.setBounds(hostBounds());
    }
    options.changed();
  }

  function state(id: number, contents: WebContents, popup: boolean): PageState {
    return {
      id,
      site: siteOf(contents.getURL()),
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      popup,
      ...(popup ? { opener: popups.get(id)?.opener } : {}),
      shown: shown?.id === id || (popup && !!popups.get(id)?.window.isVisible()),
    };
  }

  return {
    /** A background page for the broker. */
    open(url = "about:blank"): WebContents {
      const view = new WebContentsView({ webPreferences: PAGE_PREFERENCES });
      const contents = adopt(view);
      void contents.loadURL(url).catch(() => {});
      return contents;
    },
    show,
    park,
    /** Resize the page on show. */
    resize(bounds: Rectangle): void {
      currentBounds = bounds;
      if (shown) views.get(shown.id)?.setBounds(bounds);
    },
    shown: () => shown?.id,
    get: webContentsOf,
    /** The page a popup came from, for a popup. */
    openerOf: (id: number) => popups.get(id)?.opener,
    list(): PageState[] {
      return [
        ...[...views].filter(([, view]) => !view.webContents.isDestroyed()).map(([id, view]) => state(id, view.webContents, false)),
        ...[...popups].filter(([, entry]) => !entry.window.isDestroyed()).map(([id, entry]) => state(id, entry.window.webContents, true)),
      ];
    },
    host,
  };
}

export type Pages = ReturnType<typeof createPages>;
