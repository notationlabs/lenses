/**
 * Service worker: connects out to the lens-host process over a local
 * WebSocket, receives lens calls, binds each call to a tab, and runs
 * the @actors/lens resolver engine against that tab.
 */
import { executeLens, matchUrl } from "@actors/lens";
import type { DomResolver, EngineIO, InterceptedResponse, LensSpec } from "@actors/lens";

const BRIDGE_URL = "ws://127.0.0.1:4319";
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

// ---------- websocket bridge ----------
let ws: WebSocket | null = null;
let backoff = 1000;
const pendingLlm = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();
let llmSeq = 0;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(BRIDGE_URL);
  ws.onopen = () => {
    backoff = 1000;
    ws?.send(JSON.stringify({ type: "hello", ua: navigator.userAgent }));
  };
  ws.onmessage = (ev) => void onBridgeMessage(String(ev.data));
  ws.onclose = () => {
    ws = null;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => ws?.close();
}

chrome.alarms.create("lens-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();

async function onBridgeMessage(raw: string) {
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
    ws?.send(JSON.stringify({ type: "result", id, result }));
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
      result = await handleCall(id, spec, target, args);
    } catch (err) {
      result = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    ws?.send(JSON.stringify({ type: "result", id, result }));
  }
}

// ---------- tab binding ----------
async function bindTab(spec: LensSpec, target: string): Promise<number> {
  const tabs = await chrome.tabs.query({});
  // prefer a tab already on the exact target, then any tab matching accepts
  const exact = tabs.find((t) => t.url === target || t.url === target.replace(/\/$/, ""));
  if (exact?.id !== undefined) return exact.id;
  const accepted = tabs.find((t) => t.url && matchUrl(spec.accepts, t.url));
  if (accepted?.id !== undefined) return accepted.id;
  const created = await chrome.tabs.create({ url: target, active: false });
  if (created.id === undefined) throw new Error("could not create tab");
  await waitForLoad(created.id);
  return created.id;
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
  if (exact?.id !== undefined) {
    tabId = exact.id;
    // reload so the buffer captures the page's own requests from a cold start
    buffers.set(tabId, []);
    await chrome.tabs.reload(tabId, { bypassCache: false });
    await waitForLoad(tabId);
  } else {
    const created = await chrome.tabs.create({ url: target, active: false });
    if (created.id === undefined) throw new Error("could not create tab");
    tabId = created.id;
    await waitForLoad(tabId);
  }
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
}

// ---------- call execution ----------
async function handleCall(
  callId: string,
  spec: LensSpec,
  target: string,
  args: Record<string, unknown>
) {
  const tabId = await bindTab(spec, target);

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
        if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("bridge disconnected"));
        const id = `llm_${++llmSeq}`;
        pendingLlm.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: "llm", id, callId, prompt }));
        setTimeout(() => {
          if (pendingLlm.delete(id)) reject(new Error("sampling timed out"));
        }, 60000);
      }),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };

  return executeLens(spec, target, args, io);
}
