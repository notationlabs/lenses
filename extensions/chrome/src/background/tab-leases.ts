const CREATED_TAB_LEASES_KEY = "createdTabLeases";

/**
 * A tab this extension opened, and the target it was opened for. The target is
 * what lets a later call find the tab again once the page has redirected away
 * from it — a URL match alone cannot.
 */
export interface TabLease {
  tabId: number;
  /** Absent on leases written before leases carried a target. */
  target?: string;
  /**
   * The URL the tab showed when a needs_* outcome kept it — usually a sign-in
   * page. While the tab stays at this place, calls to the target's site are
   * gated. Lives here rather than in the broker so a broker restart cannot
   * forget a gate whose tab is still open.
   */
  keptUrl?: string;
}

let leaseUpdate: Promise<void> = Promise.resolve();

export async function rememberCreatedTab(
  tabId: number,
  target: string
): Promise<void> {
  await writeLeases((leases) => [
    ...leases.filter((lease) => lease.tabId !== tabId),
    { tabId, target },
  ]);
}

/** No-op for a tab without a lease: only leased tabs can gate a site. */
export async function recordKeptUrl(
  tabId: number,
  keptUrl: string
): Promise<void> {
  await writeLeases((leases) =>
    leases.map((lease) =>
      lease.tabId === tabId ? { ...lease, keptUrl } : lease
    )
  );
}

export async function forgetCreatedTab(tabId: number): Promise<void> {
  await writeLeases((leases) =>
    leases.filter((lease) => lease.tabId !== tabId)
  );
}

export async function loadCreatedTabLeases(): Promise<TabLease[]> {
  const stored = await chrome.storage.session.get(
    CREATED_TAB_LEASES_KEY
  );
  const value = stored[CREATED_TAB_LEASES_KEY];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TabLease[] => {
    // chrome.storage.session outlives an extension reload, so a running
    // browser can hand this version the bare tab id array it wrote before.
    // Such a lease has no target and can only be reaped, never rebound.
    if (Number.isInteger(entry)) return [{ tabId: entry as number }];
    if (
      typeof entry === "object" &&
      entry !== null &&
      Number.isInteger((entry as TabLease).tabId)
    ) {
      const lease = entry as TabLease;
      const loaded: TabLease = { tabId: lease.tabId };
      if (typeof lease.target === "string") loaded.target = lease.target;
      if (typeof lease.keptUrl === "string") loaded.keptUrl = lease.keptUrl;
      return [loaded];
    }
    return [];
  });
}

export async function takeCreatedTabLeases(): Promise<TabLease[]> {
  const leases = await loadCreatedTabLeases();
  await chrome.storage.session.remove(CREATED_TAB_LEASES_KEY);
  return leases;
}

async function writeLeases(
  update: (leases: TabLease[]) => TabLease[]
): Promise<void> {
  leaseUpdate = leaseUpdate.then(async () => {
    await chrome.storage.session.set({
      [CREATED_TAB_LEASES_KEY]: update(await loadCreatedTabLeases()),
    });
  });
  await leaseUpdate;
}
