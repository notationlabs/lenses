/**
 * MAIN-world script. Chrome MV3's webRequest API cannot read response
 * bodies, so the intercept tier is implemented by patching fetch/XHR in
 * the page's own JS world and relaying JSON responses to the content
 * script via postMessage.
 */

export {};

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
const origSend = XMLHttpRequest.prototype.send as (
  this: XMLHttpRequest,
  body?: Document | XMLHttpRequestBodyInit | null
) => void;
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
