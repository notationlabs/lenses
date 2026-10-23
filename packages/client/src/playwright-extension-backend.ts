import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import {
  createCdpBackend,
  pageTargetId,
  type CdpBackend,
  type CdpTransport,
} from "./cdp-host.js";
import { saveHandover, takeHandover, type HandedOverTab } from "./tab-handover.js";
import {
  foregroundApplication,
  openUrlInChrome,
  restoreForegroundApplication,
} from "./launch-browser.js";
import { browserProfile, playwrightExtensionToken } from "./user-config.js";
import { playwrightExtensionInstalledVersion } from "./chrome-paths.js";
import { CDPRelayServer } from "./playwright-relay/cdp-relay.js";
import type { TabLink } from "./playwright-relay/browser-model.js";
import {
  PLAYWRIGHT_EXTENSION_ID,
  PLAYWRIGHT_EXTENSION_INSTALL_URL,
  VERSION as PLAYWRIGHT_EXTENSION_PROTOCOL,
} from "./playwright-relay/protocol.js";

const CONNECT_MS = 45_000;
/** Outer connect budget: approval wait plus Puppeteer's handshake. */
const CONNECT_ATTEMPT_MS = CONNECT_MS + 10_000;
const CLIENT_NAME = "Lenses";

export function playwrightConnectPageUrl(relayEndpoint: string, token?: string): string {
  const url = new URL(`chrome-extension://${PLAYWRIGHT_EXTENSION_ID}/connect.html`);
  url.searchParams.set("mcpRelayUrl", relayEndpoint);
  url.searchParams.set("client", JSON.stringify({ name: CLIENT_NAME }));
  url.searchParams.set("protocolVersion", String(PLAYWRIGHT_EXTENSION_PROTOCOL));
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export interface PlaywrightExtensionOptions {
  profile?: string;
  token?: string;
  openConnectPage?: (url: string) => Promise<void>;
  /** Where a restarting broker leaves its tabs; tests point it elsewhere. */
  handoverPath?: string;
}

type ResolvedPlaywrightExtensionOptions = PlaywrightExtensionOptions & { profile: string };

export function createPlaywrightExtensionBackend(
  log: (message: string) => void = () => {},
  options: PlaywrightExtensionOptions = {}
): CdpBackend {
  const resolved = {
    profile: options.profile ?? browserProfile(),
    token: options.token ?? playwrightExtensionToken(),
    openConnectPage: options.openConnectPage,
    handoverPath: options.handoverPath,
  };
  return createCdpBackend(log, createPlaywrightExtensionTransport(log, resolved));
}

function createPlaywrightExtensionTransport(
  log: (message: string) => void,
  options: ResolvedPlaywrightExtensionOptions
): CdpTransport {
  let relay: CDPRelayServer | undefined;
  let installedVersion: string | undefined;
  let anchor: PlaywrightAnchor | undefined;
  let anchorTabId: string | undefined;
  const linkListeners = new Set<(key: string, link: TabLink) => void>();
  void playwrightExtensionInstalledVersion(undefined, options.profile).then((version) => {
    installedVersion = version;
  });

  const dispose = () => {
    anchor?.dispose();
    anchor = undefined;
    relay?.stop();
    relay = undefined;
  };

  /** The web pages in this broker's group, other than its own status page. */
  async function groupTabs(browser: Browser): Promise<HandedOverTab[]> {
    const tabs: HandedOverTab[] = [];
    for (const page of await browser.pages().catch(() => [])) {
      const targetId = pageTargetId(page);
      const tabId = targetId === undefined ? undefined : relay?.tabIdForTarget(targetId);
      if (targetId === undefined || tabId === undefined || String(tabId) === anchorTabId) continue;
      if (relay?.tabLink(tabId)?.state !== "connected") continue;
      const url = page.url();
      if (!/^https?:/.test(url)) continue;
      tabs.push({ tabId, targetId, url });
    }
    return tabs;
  }

  return {
    name: "playwright-extension",
    pollForConnection: false,
    retryConnect: false,
    connectAttemptMs: CONNECT_ATTEMPT_MS,
    looksReady: () => true,
    probeLive: async () => true,
    connectHint: () =>
      `connect Playwright Extension relay protocol ${PLAYWRIGHT_EXTENSION_PROTOCOL}: ` +
      "approve the connect page and select a tab for the Lenses group",
    staleHint: () =>
      `Playwright Extension is not connected. Install it from ${PLAYWRIGHT_EXTENSION_INSTALL_URL}, ` +
        "approve the connect page, and drag tabs into the Lenses tab group. " +
        "Set PLAYWRIGHT_MCP_EXTENSION_TOKEN to skip repeated approval.",
    info: () => ({
      protocolMajor: PLAYWRIGHT_EXTENSION_PROTOCOL,
      installedVersion,
    }),
    disconnectHint: () =>
      "Playwright Extension disconnected. Keep at least one tab in the Lenses group, " +
      "then retry to reopen the connect page.",
    recordEvent(message) {
      anchor?.record(message);
    },
    tabKey(page) {
      const targetId = pageTargetId(page);
      const tabId = targetId === undefined ? undefined : relay?.tabIdForTarget(targetId);
      return tabId === undefined ? undefined : String(tabId);
    },
    tabLink: (key) => relay?.tabLink(Number(key)),
    retryAttach: async (key) => relay?.retryAttach(Number(key)),
    refreshAttach: async (key) => relay?.refreshAttach(Number(key)),
    onTabLinkChange(listener) {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    async prepareLeaseRelease(browser, release) {
      if (release?.handOver) {
        const tabs = await groupTabs(browser);
        saveHandover(options.profile, tabs, options.handoverPath);
        if (tabs.length) log(`left ${tabs.length} tab(s) for the next broker: ${tabs.map((tab) => tab.tabId).join(", ")}`);
      }
      const current = anchor;
      anchor = undefined;
      anchorTabId = undefined;
      await current?.release();
    },
    dispose,
    async connect(progress, requestLeaseRelease) {
      dispose();
      const next = new CDPRelayServer(log);
      relay = next;
      next.onTabLinkChange((tabId, link) => {
        if (relay !== next) return;
        for (const listener of linkListeners) listener(String(tabId), link);
      });
      try {
        await next.start();
        const connectUrl = playwrightConnectPageUrl(next.extensionEndpoint(), options.token);
        progress(
          "opening the Playwright Extension connect page — pick tabs for the Lenses group"
        );
        const open =
          options.openConnectPage ??
          (async (href: string) => {
            if (!(await openUrlInChrome(href, options.profile))) {
              throw new Error("could not open the Playwright Extension connect page in Chrome");
            }
          });
        const foreground = options.token
          ? await foregroundApplication()
          : undefined;
        try {
          await open(connectUrl);
          const timeout = AbortSignal.timeout(CONNECT_MS);
          await Promise.race([
            next.waitForExtension().catch((error) => {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                `Playwright Extension relay protocol ${PLAYWRIGHT_EXTENSION_PROTOCOL} failed to initialize: ` +
                `${reason}. Update the extension if the connect page reports a protocol mismatch.`
              );
            }),
            new Promise<never>((_, reject) => {
              timeout.addEventListener("abort", () =>
                reject(
                  new Error(
                    "timed out waiting for the Playwright Extension; approve the connect page or set PLAYWRIGHT_MCP_EXTENSION_TOKEN"
                  )
                )
              );
            }),
          ]);
          const handedOver = takeHandover(options.profile, options.handoverPath);
          if (handedOver.length) {
            log(`adopting ${handedOver.length} tab(s) from the previous broker: ${handedOver.map((tab) => tab.tabId).join(", ")}`);
            // Attached when Puppeteer turns on auto-attach, below.
            await next.adoptTabs(handedOver);
          }
        } finally {
          // The stock extension explicitly activates its selected tab and
          // focuses Chrome. Restore immediately: delaying this makes the focus
          // steal visible on every lazy reconnection.
          await restoreForegroundApplication(foreground);
        }
        const connected = await puppeteer.connect({
          browserWSEndpoint: next.cdpEndpoint(),
          defaultViewport: null,
        });
        const connectPage = (await connected.pages()).find(isPlaywrightConnectPage);
        const anchorPage = await connected.newPage({ background: true });
        const anchorTarget = pageTargetId(anchorPage);
        const anchorTab = anchorTarget === undefined ? undefined : next.tabIdForTarget(anchorTarget);
        anchorTabId = anchorTab === undefined ? undefined : String(anchorTab);
        await renderPlaywrightAnchor(anchorPage, options.profile, installedVersion);
        anchor = retainPlaywrightAnchor(anchorPage, requestLeaseRelease);
        anchor.record("Connected");
        // The controlled status page is now the lease anchor; the extension's
        // one-shot connection UI is no longer needed.
        await connectPage?.close().catch(() => {});
        // The extension reports itself initialized before it activates the
        // connect tab and focuses Chrome, so the restore above can land first.
        // Nothing here needs the user: restore again once connected.
        await restoreForegroundApplication(foreground);
        return connected;
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}

interface PlaywrightAnchor {
  release(): Promise<void>;
  dispose(): void;
  record(message: string): void;
}

/** Keep the controlled connect page as the lease anchor and distinguish its
 * user-initiated closure from the broker's intentional release. */
export function retainPlaywrightAnchor(
  page: Pick<
    import("puppeteer-core").Page,
    "on" | "off" | "close" | "isClosed" | "evaluate"
  >,
  requestLeaseRelease: () => void
): PlaywrightAnchor {
  let watching = true;
  const closed = () => {
    if (!watching) return;
    watching = false;
    requestLeaseRelease();
  };
  page.on("close", closed);
  const dispose = () => {
    if (!watching) return;
    watching = false;
    page.off("close", closed);
  };
  return {
    dispose,
    record(message) {
      if (!watching || page.isClosed()) return;
      void page.evaluate(
        ({ message, time }) => {
          const events = document.querySelector("#events");
          if (!events) return;
          const item = document.createElement("li");
          const timestamp = document.createElement("time");
          timestamp.textContent = time;
          item.append(timestamp, document.createTextNode(message));
          events.prepend(item);
          while (events.children.length > 30) events.lastElementChild?.remove();
        },
        { message, time: new Date().toLocaleTimeString() }
      ).catch(() => {});
    },
    async release() {
      dispose();
      if (!page.isClosed()) await page.close().catch(() => {});
    },
  };
}

export async function renderPlaywrightAnchor(
  page: Pick<import("puppeteer-core").Page, "setContent">,
  profile: string,
  extensionVersion?: string
): Promise<void> {
  const version = extensionVersion ?? "Unknown";
  await page.setContent(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <title>Lenses</title>
  <style>
    body { font: 15px system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 24px; }
    h1 { font-size: 24px; margin: 0 0 24px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 32px; }
    dt { color: #777; }
    dd { margin: 0; }
    h2 { font-size: 15px; margin: 0 0 12px; }
    ol { list-style: none; margin: 0; padding: 0; }
    li { display: flex; gap: 12px; padding: 7px 0; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
    time { color: #777; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <h1>Lenses</h1>
  <dl>
    <dt>Status</dt><dd>Connected</dd>
    <dt>Profile</dt><dd>${escapeHtml(profile)}</dd>
    <dt>Extension</dt><dd>${escapeHtml(version)}</dd>
  </dl>
  <h2>Events</h2>
  <ol id="events"></ol>
</body>
</html>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function isPlaywrightConnectPage(
  page: Pick<import("puppeteer-core").Page, "url">
): boolean {
  try {
    const url = new URL(page.url());
    return url.protocol === "chrome-extension:" &&
      url.hostname === PLAYWRIGHT_EXTENSION_ID &&
      url.pathname === "/connect.html";
  } catch {
    return false;
  }
}

export { PLAYWRIGHT_EXTENSION_ID, PLAYWRIGHT_EXTENSION_INSTALL_URL, PLAYWRIGHT_EXTENSION_PROTOCOL };
