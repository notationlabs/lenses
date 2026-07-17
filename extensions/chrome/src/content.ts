/**
 * Isolated-world content script. Two jobs:
 *  1. relay intercepted responses from the MAIN-world patch to the SW
 *  2. serve DOM extraction / snapshot requests from the SW
 */

export {};

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
  };
}

// 1 — relay intercepts up to the service worker
// After an extension reload this script is orphaned and sendMessage throws
// synchronously ("Extension context invalidated") — go permanently silent.
let orphaned = false;
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.source !== MARK || d.kind !== "intercepted" || orphaned) return;
  try {
    chrome.runtime
      .sendMessage({
        type: "intercepted",
        response: { url: d.url, method: d.method, status: d.status, body: d.body, timestamp: d.timestamp },
      })
      .catch(() => {});
  } catch {
    orphaned = true;
  }
});

// 2 — serve SW requests
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ping") {
    // liveness probe — the SW reloads the tab if this script never answers
    sendResponse({ ok: true });
    return false;
  }
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
  }

  return { url: location.href, title: document.title, value };
}
