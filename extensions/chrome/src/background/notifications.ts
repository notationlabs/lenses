import { focusTab } from "./tabs.js";

const GATE_NOTIFICATION_PREFIX = "lens-gate:";

/**
 * Whether any Chrome window holds OS-level focus. When it does, raising the
 * kept tab is signal enough; a notification on top would be noise. When the
 * user is in another application, macOS forbids stealing focus, so the
 * notification is the only signal that crosses that boundary.
 */
export async function chromeHasOsFocus(): Promise<boolean> {
  try {
    const window = await chrome.windows.getLastFocused();
    return window.focused === true;
  } catch {
    return false;
  }
}

export async function notifySignInNeeded(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = tab.url ? new URL(tab.url).host : "a site";
    await chrome.notifications.create(
      `${GATE_NOTIFICATION_PREFIX}${tabId}`,
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Sign-in needed",
        message: `A lens call is waiting for you to sign in to ${host}. Click to open the tab.`,
      }
    );
  } catch {
    // A missing tab or denied notification must not fail the lens call.
  }
}

/** Register at service-worker top level so clicks survive SW restarts. */
export function watchGateNotifications(): void {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(GATE_NOTIFICATION_PREFIX)) return;
    void chrome.notifications.clear(notificationId);
    const tabId = Number(
      notificationId.slice(GATE_NOTIFICATION_PREFIX.length)
    );
    // The click grants activation, so this focus crosses applications.
    void focusTab(tabId);
  });
}
