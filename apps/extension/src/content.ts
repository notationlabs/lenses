/**
 * Isolated-world content script. Two jobs:
 *  1. relay intercepted responses from the MAIN-world patch to the SW
 *  2. serve DOM extraction / snapshot / fire requests from the SW
 */

const MARK = "__lens_host__";

interface DomFieldSpec {
  selector: string;
  attr?: string;
  sibling?: boolean;
}
interface DomExtractRequest {
  type: "dom_extract";
  spec: {
    item?: string;
    fields?: Record<string, DomFieldSpec>;
    actions?: Array<{ click?: string; type?: { selector: string; text: string } }>;
  };
}

// 1 — relay intercepts (and fire results) up to the service worker
const pendingFires = new Map<string, (r: unknown) => void>();
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.source !== MARK) return;
  if (d.kind === "intercepted") {
    chrome.runtime
      .sendMessage({
        type: "intercepted",
        response: { url: d.url, method: d.method, status: d.status, body: d.body, timestamp: d.timestamp },
      })
      .catch(() => {});
  } else if (d.kind === "fire_result") {
    pendingFires.get(d.id)?.(d);
    pendingFires.delete(d.id);
  }
});

// 2 — serve SW requests
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "dom_extract") {
    runDomExtract(msg as DomExtractRequest)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === "snapshot") {
    sendResponse({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, msg.maxChars ?? 20000),
    });
    return false;
  }
  if (msg.type === "fire") {
    const id = `fire_${Math.random().toString(36).slice(2)}`;
    pendingFires.set(id, (r) => sendResponse(r));
    window.postMessage({ source: MARK, kind: "fire", id, method: msg.method, url: msg.url, body: msg.body }, "*");
    setTimeout(() => {
      if (pendingFires.delete(id)) sendResponse({ error: "fire timed out" });
    }, 30000);
    return true;
  }
  return false;
});

function extractField(root: Element, f: DomFieldSpec): string | null {
  const scope = f.sibling ? root.nextElementSibling : root;
  if (!scope) return null;
  const el = f.selector === ":self" ? scope : scope.querySelector(f.selector);
  if (!el) return null;
  if (f.attr) {
    const v = el.getAttribute(f.attr);
    // resolve relative URLs for href/src
    if (v && (f.attr === "href" || f.attr === "src")) {
      try {
        return new URL(v, location.href).href;
      } catch {
        return v;
      }
    }
    return v;
  }
  return (el.textContent ?? "").trim();
}

async function runDomExtract(req: DomExtractRequest) {
  const { spec } = req;

  if (spec.actions) {
    for (const action of spec.actions) {
      if (action.click) {
        const el = document.querySelector<HTMLElement>(action.click);
        if (!el) throw new Error(`click target not found: ${action.click}`);
        el.click();
      } else if (action.type) {
        const el = document.querySelector<HTMLInputElement>(action.type.selector);
        if (!el) throw new Error(`type target not found: ${action.type.selector}`);
        el.focus();
        el.value = action.type.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  let value: unknown = null;
  if (spec.item && spec.fields) {
    const items: Record<string, string | null>[] = [];
    for (const el of document.querySelectorAll(spec.item)) {
      const row: Record<string, string | null> = {};
      for (const [name, f] of Object.entries(spec.fields)) row[name] = extractField(el, f);
      items.push(row);
    }
    value = items;
  } else if (spec.fields) {
    const row: Record<string, string | null> = {};
    for (const [name, f] of Object.entries(spec.fields)) row[name] = extractField(document.documentElement, f);
    value = row;
  } else if (spec.actions) {
    value = { done: true };
  }

  return { url: location.href, title: document.title, value };
}
