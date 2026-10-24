/**
 * The Lenses app: a menu bar app whose main process runs the broker, driving
 * lens pages in the app's own Chromium, out of sight. A page that needs the
 * user (a sign-in) goes in the inbox and raises a notice; the app never
 * comes forward on its own. CLI, MCP, and library clients reach the broker
 * on its usual port.
 */
import { app, Menu, nativeImage, Tray } from "electron";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createLensClient } from "@djgrant/lenses-client";
import { setElectronHost } from "@djgrant/lenses-client/electron-host";
import { needLabel } from "./inbox.js";
import { createLensesApp, type LensesApp } from "./lenses-app.js";
import { prepareChromium } from "./pages.js";

const BROKER_PORT = Number(process.env.LENS_BROKER_PORT ?? 4319);
const staticDir = fileURLToPath(new URL("../static/", import.meta.url));

app.setName("Lenses");
prepareChromium();
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
// No remote debugging port: the broker drives lens pages through their own
// debuggers (see lens-tabs.ts). A port would let any local process drive the
// user's signed-in pages, and it sets navigator.webdriver on every page, which
// Google's sign-in refuses.
// Keep Electron's own User-Agent, as T3 Code does. Google's sign-in rejects a
// User-Agent rewritten to pass for plain Chrome ("This browser or app may not
// be secure"), likely because the client hints still name Chromium alone, and
// T3 Code found rewriting it breaks Cloudflare Turnstile.

let lenses: LensesApp | undefined;
let tray: Tray | undefined;
let brokerStatus: unknown;
let readStatus: (() => unknown) | undefined;
let brokerError: string | undefined;

app.on("second-instance", () => lenses?.open());
app.on("activate", () => lenses?.open());
// A menu bar app: closing every window leaves it running.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!primary) return;
  app.dock?.hide();
  createTray();
  lenses = createLensesApp({
    staticDir,
    anchor: () => tray?.getBounds(),
    status: () => ({ line: statusLine(currentStatus()), error: brokerError }),
    changed: () => updateTrayMenu(),
  });
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
    tabs: lenses!.lensTabs.tabs,
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
  tray.setTitle("◎");
  tray.setToolTip("Lenses");
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray || !lenses) return;
  const items = lenses.inbox.items();
  tray.setTitle(items.length ? `◉ ${items.length}` : "◎");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine(currentStatus()), enabled: false },
      { type: "separator" },
      ...(items.length
        ? items.map((item) => ({ label: needLabel(item.need, item.site), click: () => lenses?.open(item.page) }))
        : [{ label: "Nothing needs you", enabled: false }]),
      { type: "separator" },
      { label: "Open Lenses", click: () => lenses?.open() },
      { type: "separator" },
      { label: "Quit Lenses", role: "quit" as const },
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
  lenses?.appWindow.send();
}
