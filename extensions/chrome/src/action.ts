import {
  getBridgeStatus,
  setBridgeEnabled,
} from "./background/bridge.js";

const CONSENT_KEY = "userConsentV1";

export interface ActionStatus {
  consented: boolean;
  connected: boolean;
  connectedPorts: number[];
  version: string;
}

async function consented(): Promise<boolean> {
  const stored = await chrome.storage.local.get(CONSENT_KEY);
  return stored[CONSENT_KEY] === true;
}

async function status(): Promise<ActionStatus> {
  const bridge = getBridgeStatus();
  return {
    consented: await consented(),
    connected: bridge.connectedPorts.length > 0,
    connectedPorts: bridge.connectedPorts,
    version: chrome.runtime.getManifest().version,
  };
}

async function setConsent(value: boolean): Promise<ActionStatus> {
  await chrome.storage.local.set({ [CONSENT_KEY]: value });
  setBridgeEnabled(value);
  await updateActionBadge(value);
  return status();
}

async function updateActionBadge(hasConsent = false): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
  await chrome.action.setBadgeText({ text: hasConsent ? "" : "!" });
  await chrome.action.setTitle({
    title: hasConsent
      ? "Lenses — view connection status"
      : "Lenses — setup required",
  });
}

/** Register at service-worker startup so the action popup can always respond. */
export function registerActionUi(): void {
  void consented().then((value) => updateActionBadge(value));

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "action:get-status") {
      void status().then(sendResponse);
      return true;
    }
    if (message?.type === "action:set-consent" && typeof message.value === "boolean") {
      void setConsent(message.value).then(sendResponse);
      return true;
    }
    return false;
  });
}

export async function loadBridgeConsent(): Promise<void> {
  setBridgeEnabled(await consented());
}
