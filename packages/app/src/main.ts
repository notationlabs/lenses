/**
 * The Lenses app: the broker runs in this main process and drives the app's
 * own Chromium. Lens tabs are hidden windows, shown when a sign-in needs the
 * user. CLI, MCP, and library clients reach the broker on its usual port.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, type WebContents } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createLensClient } from "@djgrant/lenses-client";
import { setElectronHost } from "@djgrant/lenses-client/electron-host";

const BROKER_PORT = Number(process.env.LENS_BROKER_PORT ?? 4319);
const staticDir = fileURLToPath(new URL("../static/", import.meta.url));

app.setName("Lenses");
// Before the debugging switch: a second launch must not overwrite the first
// one's DevToolsActivePort on its way out.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);
// The app's own debugging endpoint, which the broker connects to. Port 0
// picks a free port and records it in DevToolsActivePort.
else app.commandLine.appendSwitch("remote-debugging-port", "0");
// Present as plain Chrome: some sign-in pages refuse embedded browsers.
app.userAgentFallback = app.userAgentFallback
  .replace(/ Electron\/\S+/, "")
  .replace(new RegExp(` ${app.getName()}/\\S+`, "i"), "")
  .replace(/ lenses-app\/\S+/i, "");

/** Windows the broker opened, by CDP target id. */
const lensTabs = new Map<string, BrowserWindow>();
let panel: BrowserWindow | undefined;
let hostPage: BrowserWindow | undefined;
let tray: Tray | undefined;
let brokerStatus: unknown;
let readStatus: (() => unknown) | undefined;
let brokerError: string | undefined;

app.on("second-instance", () => showPanel());
// A menu bar app: closing every window leaves it running.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!primary) return;
  app.dock?.hide();
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
  const browserURL = `http://127.0.0.1:${await debuggingPort()}`;
  hostPage = await createHostPage();
  setElectronHost({
    browserURL,
    port: BROKER_PORT,
    hostTargetId: await targetId(hostPage.webContents),
    openWindow,
    reveal,
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

async function debuggingPort(): Promise<number> {
  const file = join(app.getPath("userData"), "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (Number.isSafeInteger(port) && port > 0) return port;
    }
    await sleep(50);
  }
  throw new Error("the app's remote debugging endpoint did not start");
}

/**
 * A hidden page that opens every lens tab, so the broker can tell lens tabs
 * (and their popups) from windows the user opened: CDP names each page's
 * opener.
 */
async function createHostPage(): Promise<BrowserWindow> {
  const window = new BrowserWindow({ show: false });
  window.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { backgroundThrottling: false },
    },
  }));
  await window.loadURL("data:text/html,<title>Lenses host</title>");
  return window;
}

let opening = Promise.resolve();

/** One at a time: each window.open is matched to the next window created. */
function openWindow(): Promise<string> {
  const next = opening.then(openLensTab);
  opening = next.then(
    () => {},
    () => {}
  );
  return next;
}

async function openLensTab(): Promise<string> {
  const host = hostPage!.webContents;
  const created = new Promise<BrowserWindow>((resolve) =>
    host.once("did-create-window", (window) => resolve(window))
  );
  await host.executeJavaScript(`window.open("about:blank", "_blank", "noopener")`, true);
  const window = await created;
  const id = await targetId(window.webContents);
  lensTabs.set(id, window);
  window.on("closed", () => {
    lensTabs.delete(id);
    refresh();
  });
  window.webContents.on("page-title-updated", refresh);
  window.webContents.on("did-navigate", refresh);
  refresh();
  return id;
}

/** The CDP target id the broker's Puppeteer connection knows this page by. */
async function targetId(contents: WebContents): Promise<string> {
  contents.debugger.attach("1.3");
  try {
    const { targetInfo } = await contents.debugger.sendCommand("Target.getTargetInfo");
    return targetInfo.targetId as string;
  } finally {
    contents.debugger.detach();
  }
}

function reveal(id: string): void {
  const window = lensTabs.get(id);
  if (!window || window.isDestroyed()) return;
  window.show();
  window.focus();
  app.focus({ steal: true });
}

/**
 * A window for signing in to a site by hand; its cookies serve later calls.
 * The broker never attaches to it (see createHostPage).
 */
function openSite(url: string): void {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const window = new BrowserWindow({ width: 1180, height: 860 });
  window.webContents.on("page-title-updated", refresh);
  window.webContents.on("did-navigate", refresh);
  window.on("closed", refresh);
  void window.loadURL(target);
  refresh();
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
      { label: "Control Panel…", click: showPanel },
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

function showPanel(): void {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
    app.focus({ steal: true });
    return;
  }
  panel = new BrowserWindow({
    width: 720,
    height: 640,
    title: "Lenses",
    webPreferences: { preload: join(staticDir, "preload.cjs") },
  });
  void panel.loadFile(join(staticDir, "panel.html"));
  panel.on("closed", () => {
    panel = undefined;
  });
  app.focus({ steal: true });
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

function windows() {
  return BrowserWindow.getAllWindows()
    .filter((window) => window !== panel && window !== hostPage && !window.isDestroyed())
    .map((window) => {
      const lensTab = [...lensTabs].find(([, candidate]) => candidate === window);
      return {
        id: window.id,
        lensTab: !!lensTab,
        title: window.webContents.getTitle(),
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      };
    });
}

function refresh(): void {
  updateTrayMenu();
  if (!panel || panel.isDestroyed()) return;
  panel.webContents.send("state", {
    port: BROKER_PORT,
    brokerError,
    status: currentStatus(),
    windows: windows(),
    userAgent: app.userAgentFallback,
  });
}

ipcMain.on("open-site", (_event, url: string) => openSite(url));
ipcMain.on("window", (_event, id: number, action: "show" | "hide" | "close") => {
  const window = BrowserWindow.fromId(id);
  if (!window || window === panel || window === hostPage) return;
  if (action === "show") {
    window.show();
    window.focus();
    app.focus({ steal: true });
  }
  if (action === "hide") window.hide();
  if (action === "close") window.close();
  refresh();
});
ipcMain.on("ready", refresh);
