import puppeteer from "puppeteer-core";
import { createCdpBackend, type CdpBackend, type CdpTransport } from "./cdp-host.js";
import { openUrlInChrome } from "./launch-browser.js";
import { browserProfile } from "./user-config.js";
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

export function playwrightConnectPageUrl(
  relayEndpoint: string,
  protocolVersion = PLAYWRIGHT_EXTENSION_PROTOCOL
): string {
  const url = new URL(`chrome-extension://${PLAYWRIGHT_EXTENSION_ID}/connect.html`);
  url.searchParams.set("mcpRelayUrl", relayEndpoint);
  url.searchParams.set("client", JSON.stringify({ name: CLIENT_NAME }));
  url.searchParams.set("protocolVersion", String(protocolVersion));
  const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export interface PlaywrightExtensionHooks {
  openConnectPage?: (url: string) => Promise<void>;
}

export function createPlaywrightExtensionBackend(
  log: (message: string) => void = () => {},
  hooks: PlaywrightExtensionHooks = {}
): CdpBackend {
  return createCdpBackend(log, undefined, createPlaywrightExtensionTransport(log, hooks));
}

function createPlaywrightExtensionTransport(
  log: (message: string) => void,
  hooks: PlaywrightExtensionHooks
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
        const connectUrl = playwrightConnectPageUrl(next.extensionEndpoint(), next.protocolVersion());
        progress(
          "opening the Playwright Extension connect page — pick tabs for the Lenses group"
        );
        const open =
          hooks.openConnectPage ??
          (async (href: string) => {
            if (!(await openUrlInChrome(href, browserProfile()))) {
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
