/**
 * The inbox: pages that need the user, in the order they asked. A page joins
 * when a lens call stops at it with a needs_* outcome (a sign-in, say), and
 * leaves when a later call on it gets through or when it closes. Ignoring an
 * item only quiets its notice.
 */
export interface InboxItem {
  /** The page's id (its webContents id). */
  page: number;
  site: string;
  /** The needs_* outcome, e.g. needs_auth. */
  need: string;
  since: number;
  /** The user dismissed its notice. */
  ignored: boolean;
}

export interface InboxListener {
  /** A page joined the inbox: tell the user. */
  added?(item: InboxItem): void;
  changed?(): void;
}

export function createInbox(listener: InboxListener = {}) {
  const items = new Map<number, InboxItem>();
  const changed = () => listener.changed?.();
  return {
    /** The page needs the user. Asked again, it keeps its place and does not notify again. */
    raise(page: number, site: string, need: string, now = Date.now()): void {
      const existing = items.get(page);
      if (existing) {
        existing.need = need;
        existing.site = site;
        changed();
        return;
      }
      const item: InboxItem = { page, site, need, since: now, ignored: false };
      items.set(page, item);
      listener.added?.(item);
      changed();
    },
    /** The page no longer needs the user. */
    remove(page: number): void {
      if (items.delete(page)) changed();
    },
    ignore(page: number): void {
      const item = items.get(page);
      if (!item || item.ignored) return;
      item.ignored = true;
      changed();
    },
    get: (page: number) => items.get(page),
    /** Oldest first. */
    items: (): InboxItem[] => [...items.values()],
  };
}

export type Inbox = ReturnType<typeof createInbox>;

/** What the user is asked to do, for a needs_* outcome. */
export function needLabel(need: string, site: string): string {
  if (need === "needs_auth") return `Sign in to ${site}`;
  const what = need.replace(/^needs_/, "").replace(/_/g, " ");
  return `${site} needs ${what}`;
}
