/**
 * The Lenses app: the broker runs in this main process and drives the app's
 * own Chromium. Lens tabs are background tabs in the app's browser window,
 * brought forward when a sign-in needs the user. CLI, MCP, and library
 * clients reach the broker on its usual port.
 */
import { app, ipcMain, Menu, nativeImage, Tray } from "electron";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createLensClient } from "@djgrant/lenses-client";
import { setElectronHost } from "@djgrant/lenses-client/electron-host";
import { createBrowser, prepareChromium, type Browser } from "./browser.js";
import { createLensTabs } from "./lens-tabs.js";

const BROKER_PORT = Number(process.env.LENS_BROKER_PORT ?? 4319);
const staticDir = fileURLToPath(new URL("../static/", import.meta.url));

app.setName("Lenses");
prepareChromium();
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
// No remote debugging port: the broker drives lens tabs through their own
// debuggers (see lens-tabs.ts). A port would let any local process drive the
// user's signed-in tabs, and it sets navigator.webdriver on every page, which
// Google's sign-in refuses.
// Keep Electron's own User-Agent, as T3 Code does. Google's sign-in rejects a
// User-Agent rewritten to pass for plain Chrome ("This browser or app may not
// be secure"), likely because the client hints still name Chromium alone, and
// T3 Code found rewriting it breaks Cloudflare Turnstile.

let browser: Browser | undefined;
const lensTabs = createLensTabs({
  open: (url) => browser!.openLensTab(url),
  reveal: (contents) => browser?.reveal(contents),
});
let tray: Tray | undefined;
let brokerStatus: unknown;
let readStatus: (() => unknown) | undefined;
let brokerError: string | undefined;

app.on("second-instance", () => browser?.show());
app.on("activate", () => browser?.show());
// A menu bar app: closing every window leaves it running.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!primary) return;
  app.dock?.hide();
  browser = createBrowser({ staticDir, changed: () => refresh(), lensOpened: lensTabs.add });
  createTray();
  try {
    await startBroker();
  } catch (error) {
    brokerError = error instanceof Error ? error.message : String(error);
    console.error("broker failed to start:", error);
  }
  refresh();
  setInterval(refresh, 1_000);
});

async function startBroker(): Promise<void> {
  if (await portInUse(BROKER_PORT)) await retireBroker();
  setElectronHost({
    port: BROKER_PORT,
    tabs: lensTabs.tabs,
    status: (frame) => {
      brokerStatus = frame;
      refresh();
    },
    started: (broker) => {
      readStatus = broker.status;
    },
  });
  await import("@djgrant/lenses-client/broker-daemon");
}

/** A broker from a CLI or library client holds the port: ask it to go. */
async function retireBroker(): Promise<void> {
  const client = createLensClient({ port: BROKER_PORT });
  try {
    await client.shutdownBroker(10_000);
  } finally {
    await client.close();
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await portInUse(BROKER_PORT))) return;
    await sleep(100);
  }
  throw new Error(`another lens broker still holds port ${BROKER_PORT}; run \`lens broker shutdown\``);
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("◎ Lenses");
  tray.setToolTip("Lenses");
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const status = currentStatus();
  const active = status?.diagnostics?.activeCall;
  tray.setTitle(active ? "◉ Lenses" : "◎ Lenses");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine(status), enabled: false },
      { type: "separator" },
      { label: "Show Browser", click: () => browser?.show() },
      { label: "New Tab", click: () => browser?.openUserTab() },
      { label: "Broker Status…", click: () => browser?.togglePanel(true) },
      { type: "separator" },
      { label: "Quit Lenses", role: "quit" },
    ])
  );
}

function statusLine(status: BrokerStatus | undefined): string {
  if (brokerError) return `Broker failed: ${brokerError}`;
  if (!status) return "Starting…";
  const active = status.diagnostics?.activeCall;
  if (active) return `Running ${active.lens ?? active.type}`;
  return status.connected ? "Ready" : "Browser not connected";
}

interface BrokerStatus {
  connected?: boolean;
  backend?: string;
  ua?: string;
  diagnostics?: {
    activeCall?: { id: string; type: string; lens?: string; startedAt: number };
    queuedCalls?: number;
    lastBackendError?: string;
  };
}

function currentStatus(): BrokerStatus | undefined {
  return (readStatus?.() ?? brokerStatus) as BrokerStatus | undefined;
}

function refresh(): void {
  updateTrayMenu();
  if (!browser || browser.window.isDestroyed()) return;
  browser.window.webContents.send("status", {
    port: BROKER_PORT,
    brokerError,
    status: currentStatus(),
    userAgent: app.userAgentFallback,
  });
}

ipcMain.on("ready", () => {
  refresh();
  browser?.resend();
});
