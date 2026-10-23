/**
 * The app's parts, wired together: lens pages for the broker, the inbox of
 * pages that need the user, the notice that tells them, and the window they
 * open to deal with it. The app never comes forward on its own; only the
 * user's Open does that.
 */
import type { Rectangle } from "electron";
import { createAppWindow } from "./window.js";
import { createInbox } from "./inbox.js";
import { createLensTabs } from "./lens-tabs.js";
import { createNotice } from "./notice.js";
import { createPages, siteOf } from "./pages.js";

export interface LensesAppOptions {
  staticDir: string;
  /** The menu bar icon's bounds, for the notice to sit under. */
  anchor(): Rectangle | undefined;
  /** Broker status, for the window. */
  status(): unknown;
  /** Anything changed: inbox, pages, notice. */
  changed?(): void;
}

export function createLensesApp(options: LensesAppOptions) {
  const changed = () => {
    updateNotice();
    appWindow.send();
    options.changed?.();
  };
  const inbox = createInbox({ changed });
  const lensTabs = createLensTabs({
    open: (url) => pages.open(url),
    attention: (contents, need) => {
      // Already in front of the user (a sign-in that needs another step):
      // no notice for what they are looking at.
      const looking = pages.shown() === contents.id && appWindow.window.isVisible();
      inbox.raise(contents.id, siteOf(contents.getURL()), need);
      if (looking) inbox.ignore(contents.id);
    },
    settled: (contents) => inbox.remove(contents.id),
  });
  const pages = createPages({
    opened: (contents) => {
      lensTabs.add(contents);
      const id = contents.id;
      contents.once("destroyed", () => inbox.remove(id));
    },
    changed,
  });
  const appWindow = createAppWindow({
    staticDir: options.staticDir,
    pages,
    inbox,
    done: (page) => inbox.remove(page),
    status: options.status,
  });
  const notice = createNotice({
    staticDir: options.staticDir,
    anchor: options.anchor,
    ignore: (page) => inbox.ignore(page),
    open: (page) => open(page),
  });

  /** The newest item the user has not dismissed or opened. */
  function updateNotice(): void {
    const items = inbox.items();
    const next = [...items].reverse().find((item) => !item.ignored);
    notice.present(next, next ? items.length - 1 : 0);
  }

  /** The user asked to deal with an item, or just to see the window. */
  function open(page?: number): void {
    if (page !== undefined) inbox.ignore(page);
    appWindow.open(page);
  }

  return { lensTabs, pages, inbox, notice, appWindow, open };
}

export type LensesApp = ReturnType<typeof createLensesApp>;
