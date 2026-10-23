/**
 * The notice: a small panel under the menu bar icon saying a page needs the
 * user, with Ignore and Open. It never takes focus and never brings the app
 * forward; only Open, the user's own click, does that.
 */
import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import { join } from "node:path";
import { needLabel, type InboxItem } from "./inbox.js";

const SIZE = { width: 360, height: 92 };
const MARGIN = 8;

export interface NoticeOptions {
  staticDir: string;
  /** The menu bar icon's bounds, to sit under. */
  anchor(): Rectangle | undefined;
  ignore(page: number): void;
  open(page: number): void;
}

export interface NoticeState {
  page: number;
  title: string;
  /** Other items still waiting. */
  more: number;
}

export function createNotice(options: NoticeOptions) {
  const window = new BrowserWindow({
    ...SIZE,
    type: "panel",
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Never key, never the active app: the user's typing stays where it was.
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(options.staticDir, "notice-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      devTools: false,
    },
  });
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(join(options.staticDir, "notice.html"));
  let current: NoticeState | undefined;

  const fromNotice = (event: Electron.IpcMainEvent) => event.sender === window.webContents;
  ipcMain.on("notice:ignore", (event, page: number) => {
    if (fromNotice(event)) options.ignore(page);
  });
  ipcMain.on("notice:open", (event, page: number) => {
    if (fromNotice(event)) options.open(page);
  });
  ipcMain.on("notice:ready", (event) => {
    if (fromNotice(event) && current) window.webContents.send("notice", current);
  });

  function place(): void {
    const anchor = options.anchor();
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const centre = anchor ? anchor.x + anchor.width / 2 : area.x + area.width;
    const x = Math.round(Math.min(Math.max(centre - SIZE.width / 2, area.x + MARGIN), area.x + area.width - SIZE.width - MARGIN));
    window.setBounds({ x, y: area.y + MARGIN, ...SIZE });
  }

  return {
    window,
    /** Show the item's notice, or hide the notice with nothing to say. */
    present(item: InboxItem | undefined, more = 0): void {
      if (window.isDestroyed()) return;
      if (!item) {
        current = undefined;
        window.hide();
        return;
      }
      current = { page: item.page, title: needLabel(item.need, item.site), more };
      window.webContents.send("notice", current);
      place();
      if (!window.isVisible()) window.showInactive();
    },
    state: (): NoticeState | undefined => (window.isVisible() ? current : undefined),
  };
}

export type Notice = ReturnType<typeof createNotice>;
