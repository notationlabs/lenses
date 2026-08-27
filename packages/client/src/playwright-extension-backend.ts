import puppeteer from "puppeteer-core";
import { createCdpBackend, type CdpBackend, type CdpTransport } from "./cdp-host.js";
import { openUrlInChrome } from "./launch-browser.js";
import { browserProfile, playwrightExtensionToken } from "./user-config.js";
import { CDPRelayServer } from "./playwright-relay/cdp-relay.js";
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
  };
  return createCdpBackend(log, createPlaywrightExtensionTransport(log, resolved));
}

function createPlaywrightExtensionTransport(
  log: (message: string) => void,
  options: ResolvedPlaywrightExtensionOptions
): CdpTransport {
  let relay: CDPRelayServer | undefined;

  const dispose = () => {
    relay?.stop();
    relay = undefined;
  };

  return {
    name: "playwright-extension",
    pollForConnection: false,
    retryConnect: false,
    connectAttemptMs: CONNECT_ATTEMPT_MS,
    looksReady: () => true,
    probeLive: async () => true,
    connectHint: () =>
      "select a tab in the Playwright Extension connect page (Chrome shows a debugger infobar on attached tabs)",
    staleHint: () =>
      `Playwright Extension is not connected. Install it from ${PLAYWRIGHT_EXTENSION_INSTALL_URL}, ` +
        "approve the connect page, and drag tabs into the Lenses tab group. " +
        "Set PLAYWRIGHT_MCP_EXTENSION_TOKEN to skip repeated approval.",
    dispose,
    async connect(progress) {
      dispose();
      const next = new CDPRelayServer(log);
      relay = next;
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
        await open(connectUrl);
        const timeout = AbortSignal.timeout(CONNECT_MS);
        await Promise.race([
          next.waitForExtension(),
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
        return await puppeteer.connect({
          browserWSEndpoint: next.cdpEndpoint(),
          defaultViewport: null,
        });
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}

export { PLAYWRIGHT_EXTENSION_ID, PLAYWRIGHT_EXTENSION_INSTALL_URL, PLAYWRIGHT_EXTENSION_PROTOCOL };
