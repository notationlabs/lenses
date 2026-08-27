/** Install or remove JSON response capture in the page's MAIN world. */

export type InterceptorAction = "install" | "remove";

/**
 * This function is passed to chrome.scripting.executeScript. Keep it entirely
 * self-contained: Chrome serialises the function rather than its module.
 */
export function configurePageInterceptor(action: InterceptorAction, token: string): void {
  const key = "__lensScopedInterceptor__";
  const root = window as typeof window & {
    [key]?: {
      token: string;
      fetch: typeof window.fetch;
      open: typeof XMLHttpRequest.prototype.open;
      send: typeof XMLHttpRequest.prototype.send;
      wrappedFetch: typeof window.fetch;
      wrappedOpen: typeof XMLHttpRequest.prototype.open;
      wrappedSend: typeof XMLHttpRequest.prototype.send;
    };
  };
  const existing = root[key];
  if (action === "remove") {
    if (!existing || existing.token !== token) return;
    // Do not erase a page/library patch installed after ours.
    if (window.fetch === existing.wrappedFetch) window.fetch = existing.fetch;
    if (XMLHttpRequest.prototype.open === existing.wrappedOpen) {
      XMLHttpRequest.prototype.open = existing.open;
    }
    if (XMLHttpRequest.prototype.send === existing.wrappedSend) {
      XMLHttpRequest.prototype.send = existing.send;
    }
    delete root[key];
    return;
  }
  if (existing?.token === token) return;
  if (existing) {
    if (window.fetch === existing.wrappedFetch) window.fetch = existing.fetch;
    if (XMLHttpRequest.prototype.open === existing.wrappedOpen) {
      XMLHttpRequest.prototype.open = existing.open;
    }
    if (XMLHttpRequest.prototype.send === existing.wrappedSend) {
      XMLHttpRequest.prototype.send = existing.send;
    }
  }

  const mark = "__lens_host__";
  const maxBody = 512 * 1024;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const relay = (method: string, url: string, status: number, body: string) => {
    const first = body.trimStart()[0];
    if (body.length > maxBody || (first !== "{" && first !== "[")) return;
    window.postMessage(
      {
        source: mark,
        kind: "intercepted",
        token,
        method: method.toUpperCase(),
        url,
        status,
        body,
        timestamp: Date.now(),
      },
      location.origin
    );
  };

  const wrappedFetch: typeof window.fetch = async (...args) => {
    const response = await originalFetch.apply(window, args);
    try {
      const input = args[0];
      const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
      if ((response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
        void response.clone().text().then((body) => relay(method, response.url, response.status, body)).catch(() => {});
      }
    } catch {
      // Observation must never affect page behaviour.
    }
    return response;
  };
  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & { __lensMeta?: { method: string; url: string } },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__lensMeta = { method, url: String(url) };
    // @ts-expect-error preserve every overload argument.
    return originalOpen.call(this, method, url, ...rest);
  };
  const wrappedSend: typeof XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & { __lensMeta?: { method: string; url: string } },
    body?: XMLHttpRequestBodyInit | null
  ) {
    this.addEventListener("load", () => {
      try {
        const meta = this.__lensMeta;
        if (!meta) return;
        if (!(this.getResponseHeader("content-type") ?? "").toLowerCase().includes("json")) return;
        if (this.responseType !== "" && this.responseType !== "text") return;
        relay(meta.method, new URL(meta.url, location.href).href, this.status, this.responseText);
      } catch {
        // Observation must never affect page behaviour.
      }
    }, { once: true });
    return originalSend.call(this, body);
  };

  window.fetch = wrappedFetch;
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.send = wrappedSend;
  root[key] = {
    token,
    fetch: originalFetch,
    open: originalOpen,
    send: originalSend,
    wrappedFetch,
    wrappedOpen,
    wrappedSend,
  };
}
