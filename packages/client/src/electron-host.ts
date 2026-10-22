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
  /** Open a hidden window and resolve its CDP target id. */
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

/**
 * Electron's CDP does not support Target.createTarget, so new tabs come from
 * the app, which opens a window and names its target.
 */
export function createElectronTransport(host: ElectronHost): CdpTransport {
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
      return puppeteer.connect({ browserURL: host.browserURL, defaultViewport: null });
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
