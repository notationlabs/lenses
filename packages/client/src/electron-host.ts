import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";
import { pageTargetId, type CdpTransport } from "./cdp-host.js";

/**
 * What the Lenses app provides when it runs the broker in its own main
 * process. The app's Chromium is the browser: tabs are app windows, hidden
 * until a sign-in needs the user.
 */
export interface ElectronHost {
  /** The app's remote debugging endpoint, e.g. http://127.0.0.1:9222. */
  browserURL: string;
  /** Broker port to listen on. */
  port: number;
  /**
   * The hidden page that opens lens tabs. The broker attaches only to pages
   * it opened, and their popups: windows the user opens to sign in are never
   * driven or instrumented.
   */
  hostTargetId: string;
  /** Open a hidden window from the host page and resolve its CDP target id. */
  openWindow(): Promise<string>;
  /** Show the window holding this target and bring the app forward. */
  reveal(targetId: string): void;
  /** Each broker status frame, for the app's control panel. */
  status?(frame: unknown): void;
  /** Called once the broker is listening, with a way to read its status. */
  started?(broker: { status(): unknown }): void;
}

const HOST = Symbol.for("lenses.electron-host");

/** The app host, when the broker runs inside the Lenses app. */
export function electronHost(): ElectronHost | undefined {
  return (globalThis as { [HOST]?: ElectronHost })[HOST];
}

export function setElectronHost(host: ElectronHost): void {
  (globalThis as { [HOST]?: ElectronHost })[HOST] = host;
}

const targetId = (target: Target) =>
  (target as unknown as { _targetId?: unknown })._targetId;
const openerId = (target: Target) =>
  (target as unknown as { _getTargetInfo(): { openerId?: string } })._getTargetInfo().openerId;

/**
 * Electron's CDP does not support Target.createTarget, so new tabs come from
 * the app, which opens a window and names its target.
 */
export function createElectronTransport(host: ElectronHost): CdpTransport {
  /** Lens tabs and the popups they opened, by target id. */
  const owned = new Set<string>();
  // Puppeteer attaches to each new target, asks this, and detaches from a
  // refused one before its page runs. Child targets (out-of-process frames)
  // are only found through an attached page, so they follow their page.
  const targetFilter = (target: Target): boolean => {
    if (target.type() === "shared_worker") return false;
    if (target.type() !== "page") return true;
    const id = targetId(target);
    if (typeof id === "string" && owned.has(id)) return true;
    const opener = openerId(target);
    if (opener === undefined || (opener !== host.hostTargetId && !owned.has(opener))) return false;
    if (typeof id === "string") owned.add(id);
    return true;
  };
  const probeLive = async () => {
    try {
      const response = await fetch(`${host.browserURL}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  return {
    name: "electron",
    pollForConnection: true,
    retryConnect: true,
    looksReady: () => true,
    probeLive,
    connectHint: () => "connecting to the Lenses app browser",
    staleHint: () => "The Lenses app browser is not responding; restart the app.",
    async connect() {
      return puppeteer.connect({ browserURL: host.browserURL, defaultViewport: null, targetFilter });
    },
    tabKey: pageTargetId,
    async newPage(browser: Browser): Promise<Page> {
      const id = await host.openWindow();
      const target = await browser.waitForTarget((candidate) => targetId(candidate) === id, {
        timeout: 10_000,
      });
      const page = await target.page();
      if (!page) throw new Error("the app window has no page");
      return page;
    },
    async reveal(page: Page) {
      const id = pageTargetId(page);
      if (id) host.reveal(id);
    },
  };
}
