/**
 * Service worker: connects out to the lens-host process over a local
 * WebSocket, receives lens calls, binds each call to a tab, and runs
 * the @actors/lens resolver engine against that tab.
 */
import { executeLens, matchUrl } from "@actors/lens";
import type { DomResolver, EngineIO, InterceptedResponse, LensSpec } from "@actors/lens";

const PORT_RANGE_START = 4319;
const PORT_RANGE_END = 4329;
const BUFFER_CAP = 200;

// ---------- intercept buffers ----------
const buffers = new Map<number, InterceptedResponse[]>();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "intercepted" && sender.tab?.id !== undefined) {
    const buf = buffers.get(sender.tab.id) ?? [];
    buf.push(msg.response as InterceptedResponse);
    if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
    buffers.set(sender.tab.id, buf);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));

// ---------- websocket bridge (multiplexed across all live hosts) ----------
// Every agent session runs its own lens-host bound to a port in the range; the
// extension keeps a socket open to each one and replies on the originating socket.
//
// Discovery is *lazy*. Chrome logs `WebSocket ... failed: ERR_CONNECTION_REFUSED`
// at the network layer for every probe of a dead port, and no JS handler can
// suppress it — so the only way to stay quiet is to not probe when we've no
// reason to expect a host. We therefore probe on startup and on page loads (the
// moments a lens might be wanted), not on a blind timer, and remember the ports
// we've reached so reconnects hit only real hosts. An idle browser with no host
// running stays silent.
const sockets = new Map<number, WebSocket>();
const pendingLlm = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void; ws: WebSocket }>();
let llmSeq = 0;

// Persisted in session storage so a revived SW reconnects to known hosts silently.
const KNOWN_PORTS_KEY = "livePorts";
const DISCOVER_COOLDOWN_MS = 10_000;
let lastDiscover = 0;

async function loadKnownPorts(): Promise<number[]> {
  const got = await chrome.storage.session.get(KNOWN_PORTS_KEY);
  const arr = got[KNOWN_PORTS_KEY];
  return Array.isArray(arr) ? (arr as number[]) : [];
}

async function rememberPort(port: number, live: boolean) {
  const set = new Set(await loadKnownPorts());
  if (live) set.add(port);
  else set.delete(port);
  await chrome.storage.session.set({ [KNOWN_PORTS_KEY]: [...set] });
}

function connectPort(port: number) {
  const existing = sockets.get(port);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.set(port, ws);
  ws.onopen = () => {
    void rememberPort(port, true);
    ws.send(JSON.stringify({ type: "hello", ua: navigator.userAgent }));
  };
  ws.onmessage = (ev) => void onBridgeMessage(ws, String(ev.data));
  ws.onclose = () => {
    if (sockets.get(port) === ws) sockets.delete(port);
    // The host is gone (or was never there); forget the port so keepalive won't
    // re-probe it. Rediscovery happens on the next page load or SW start.
    void rememberPort(port, false);
  };
  // Refused connections are expected (most ports have no host); Chrome logs them
  // regardless of this handler. Close quietly.
  ws.onerror = () => ws.close();
}

/** Probe the whole range for live hosts. Cooldown-gated unless forced. */
function discover(force = false) {
  if (nativeHealthy) return; // the native helper is authoritative and silent
  const now = Date.now();
  if (!force && now - lastDiscover < DISCOVER_COOLDOWN_MS) return;
  lastDiscover = now;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) connectPort(port);
}

/** Re-open sockets to hosts we've already reached (silent on success). */
async function reconnectKnown() {
  for (const port of await loadKnownPorts()) connectPort(port);
}

// ---------- native-messaging discovery (preferred) ----------
// A locally-installed helper (see `pok setup native`) watches the lens-host
// registry and *pushes* the live-port list over a stdio pipe. This channel never
// touches a dead TCP port, so discovery is instant and silent — even for a host
// that starts while the user is parked on a page with no navigation happening.
// When the helper isn't installed the port disconnects immediately; we read
// lastError (so Chrome logs nothing) and fall back to the lazy probing above.
const NATIVE_HOST = "com.actors.lens_host";
let nativePort: chrome.runtime.Port | null = null;
let nativeHealthy = false;

/** Reconcile live sockets against the authoritative set the helper reported. */
function syncPorts(ports: number[]) {
  const want = new Set(ports);
  for (const p of want) connectPort(p);
  for (const [p, ws] of sockets) {
    if (!want.has(p)) {
      ws.close();
      sockets.delete(p);
    }
  }
}

function connectNative() {
  if (nativePort) return;
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return; // permission missing; the lazy path covers us
  }
  nativePort = port;
  port.onMessage.addListener((msg: { ports?: number[] }) => {
    nativeHealthy = true;
    if (Array.isArray(msg?.ports)) syncPorts(msg.ports);
  });
  port.onDisconnect.addListener(() => {
    // Reading lastError suppresses Chrome's unchecked-error console warning.
    void chrome.runtime.lastError;
    nativePort = null;
    nativeHealthy = false;
  });
}

// Keep the native channel up and known hosts warm; keeps the SW alive too. None
// of this probes a dead port, so an idle browser with no host stays quiet.
chrome.alarms.create("lens-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  connectNative(); // reconnect the helper if it dropped (or got installed since)
  void reconnectKnown();
});

// Fallback discovery trigger: every completed page load — a no-op while the
// native helper is healthy, the safety net when it isn't installed.
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.url?.startsWith("http")) discover();
});

// SW spin-up (install, browser start, or revival): prefer the native channel;
// only fall back to a lazy probe if it hasn't come up shortly.
connectNative();
void reconnectKnown();
setTimeout(() => discover(true), 1500);

async function onBridgeMessage(ws: WebSocket, raw: string) {
  let msg: { type: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "llm_result") {
    const p = pendingLlm.get(msg.id as string);
    if (p) {
      pendingLlm.delete(msg.id as string);
      msg.ok ? p.resolve(msg.text as string) : p.reject(new Error((msg.error as string) ?? "sampling failed"));
    }
    return;
  }
  if (msg.type === "observe") {
    const { id, target, waitMs } = msg as unknown as { id: string; target: string; waitMs: number };
    let result;
    try {
      result = await handleObserve(target, waitMs ?? 4000);
    } catch (err) {
      result = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    ws.send(JSON.stringify({ type: "result", id, result }));
    return;
  }
  if (msg.type === "call") {
    const { id, spec, target, args } = msg as unknown as {
      id: string;
      spec: LensSpec;
      target: string;
      args: Record<string, unknown>;
    };
    let result;
    try {
      result = await handleCall(ws, id, spec, target, args);
    } catch (err) {
      result = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    ws.send(JSON.stringify({ type: "result", id, result }));
  }
}

// ---------- tab binding ----------
interface BoundTab {
  tabId: number;
  /** true when this call opened the tab — the caller may close it when done */
  created: boolean;
}

async function bindTab(spec: LensSpec, target: string): Promise<BoundTab> {
  const tabs = await chrome.tabs.query({});
  // prefer a tab already on the exact target, then any tab matching accepts
  const exact = tabs.find((t) => t.url === target || t.url === target.replace(/\/$/, ""));
  if (exact?.id !== undefined) {
    await ensureContentScript(exact.id);
    return { tabId: exact.id, created: false };
  }
  const accepted = tabs.find((t) => t.url && matchUrl(spec.accepts, t.url));
  if (accepted?.id !== undefined) {
    await ensureContentScript(accepted.id);
    return { tabId: accepted.id, created: false };
  }
  const created = await chrome.tabs.create({ url: target, active: false });
  if (created.id === undefined) throw new Error("could not create tab");
  await waitForLoad(created.id);
  return { tabId: created.id, created: true };
}

/**
 * A tab open before the extension (re)loaded holds an orphaned content script
 * that can't answer the SW — `chrome.tabs.sendMessage` then throws "Receiving
 * end does not exist". Ping it; if there's no live listener, reload the tab so
 * the current content + page scripts re-inject.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    buffers.set(tabId, []);
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitForLoad(tabId);
  }
}

/** Close a tab this call opened, unless the result needs the user to act in it. */
async function closeIfCreated(bound: BoundTab, result: { kind: string; name?: string }) {
  if (!bound.created) return;
  // Keep the tab for outcomes that require the user (sign-in, captcha, 2FA…).
  if (result.kind === "outcome" && typeof result.name === "string" && result.name.startsWith("needs_")) return;
  try {
    await chrome.tabs.remove(bound.tabId);
  } catch {
    /* already gone */
  }
}

function waitForLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // small grace period for the page's own API calls to land
      setTimeout(resolve, 500);
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") done();
    });
  });
}

function tabMessage<T>(tabId: number, payload: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, payload) as Promise<T>;
}

// ---------- observe (lens authoring) ----------
async function handleObserve(target: string, waitMs: number) {
  const tabs = await chrome.tabs.query({});
  const exact = tabs.find((t) => t.url === target || t.url === target.replace(/\/$/, ""));
  let tabId: number;
  let created = false;
  if (exact?.id !== undefined) {
    tabId = exact.id;
    // reload so the buffer captures the page's own requests from a cold start
    buffers.set(tabId, []);
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitForLoad(tabId);
  } else {
    const tab = await chrome.tabs.create({ url: target, active: false });
    if (tab.id === undefined) throw new Error("could not create tab");
    tabId = tab.id;
    created = true;
    await waitForLoad(tabId);
  }
  try {
    await new Promise((r) => setTimeout(r, waitMs));

    const captured = (buffers.get(tabId) ?? []).slice(-40).map((c) => ({
      method: c.method,
      url: c.url,
      status: c.status,
      bodyPreview: c.body.slice(0, 2000),
    }));
    const snapshot = await tabMessage<{ url: string; title: string; text: string }>(tabId, {
      type: "snapshot",
      maxChars: 6000,
    });
    return { kind: "value", value: { snapshot, requests: captured } };
  } finally {
    if (created) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* already gone */
      }
    }
  }
}

// ---------- call execution ----------
async function handleCall(
  ws: WebSocket,
  callId: string,
  spec: LensSpec,
  target: string,
  args: Record<string, unknown>
) {
  const bound = await bindTab(spec, target);
  const tabId = bound.tabId;

  const io: EngineIO = {
    getIntercepted: async () => buffers.get(tabId) ?? [],
    reload: async () => {
      buffers.set(tabId, []);
      await chrome.tabs.reload(tabId, { bypassCache: false });
      await waitForLoad(tabId);
    },
    domExtract: (domSpec: DomResolver) => tabMessage(tabId, { type: "dom_extract", spec: domSpec }),
    snapshot: (maxChars: number) => tabMessage(tabId, { type: "snapshot", maxChars }),
    fireRequest: async (method, url, body) => {
      const r = await tabMessage<InterceptedResponse & { error?: string }>(tabId, {
        type: "fire",
        method,
        url,
        body,
      });
      if (r.error) throw new Error(r.error);
      return r;
    },
    llmExtract: (prompt: string) =>
      new Promise<string>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error("bridge disconnected"));
        const id = `llm_${++llmSeq}`;
        pendingLlm.set(id, { resolve, reject, ws });
        ws.send(JSON.stringify({ type: "llm", id, callId, prompt }));
        setTimeout(() => {
          if (pendingLlm.delete(id)) reject(new Error("sampling timed out"));
        }, 60000);
      }),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };

  try {
    const result = await executeLens(spec, target, args, io);
    await closeIfCreated(bound, result);
    return result;
  } catch (err) {
    await closeIfCreated(bound, { kind: "error" });
    throw err;
  }
}
