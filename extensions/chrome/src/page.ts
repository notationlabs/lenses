/**
 * MAIN-world script. Chrome MV3's webRequest API cannot read response
 * bodies, so the intercept tier is implemented by patching fetch/XHR in
 * the page's own JS world and relaying JSON responses to the content
 * script via postMessage.
 *
 * Also handles "fire" requests for write lenses — the request is made
 * from the page context, so it carries the page's cookies and origin.
 */

const MARK = "__lens_host__";
const MAX_BODY = 512 * 1024;

function looksLikeJson(text: string): boolean {
  const c = text.trimStart()[0];
  return c === "{" || c === "[";
}

function relay(method: string, url: string, status: number, body: string) {
  if (body.length > MAX_BODY || !looksLikeJson(body)) return;
  window.postMessage(
    { source: MARK, kind: "intercepted", method: method.toUpperCase(), url, status, body, timestamp: Date.now() },
    "*"
  );
}

// --- fetch ---
const origFetch = window.fetch.bind(window);
window.fetch = async (...fetchArgs: Parameters<typeof fetch>) => {
  const res = await origFetch(...fetchArgs);
  try {
    const input = fetchArgs[0];
    const method =
      fetchArgs[1]?.method ?? (input instanceof Request ? input.method : "GET");
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("json")) {
      res
        .clone()
        .text()
        .then((body) => relay(method, res.url, res.status, body))
        .catch(() => {});
    }
  } catch {
    /* never break the page */
  }
  return res;
};

// --- XHR ---
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __lensMeta?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
  this.__lensMeta = { method, url: String(url) };
  // @ts-expect-error variadic passthrough
  return origOpen.call(this, method, url, ...rest);
};
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __lensMeta?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
  this.addEventListener("load", () => {
    try {
      const meta = this.__lensMeta;
      if (!meta) return;
      const ct = this.getResponseHeader("content-type") ?? "";
      if (!ct.includes("json")) return;
      if (this.responseType !== "" && this.responseType !== "text") return;
      const abs = new URL(meta.url, location.href).href;
      relay(meta.method, abs, this.status, this.responseText);
    } catch {
      /* never break the page */
    }
  });
  return origSend.call(this, body);
};

// --- fire (write lenses) ---
window.addEventListener("message", async (ev) => {
  const d = ev.data;
  if (!d || d.source !== MARK || d.kind !== "fire") return;
  try {
    const res = await origFetch(d.url, {
      method: d.method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: d.body === undefined ? undefined : JSON.stringify(d.body),
    });
    const body = await res.text();
    window.postMessage(
      { source: MARK, kind: "fire_result", id: d.id, url: res.url, method: d.method, status: res.status, body, timestamp: Date.now() },
      "*"
    );
  } catch (err) {
    window.postMessage(
      { source: MARK, kind: "fire_result", id: d.id, error: err instanceof Error ? err.message : String(err) },
      "*"
    );
  }
});
