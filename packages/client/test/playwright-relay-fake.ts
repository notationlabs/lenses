import { WebSocket } from "ws";

/** Minimal stock Playwright Extension protocol peer used by relay tests. */
export class FakePlaywrightExtension {
  readonly commands: { method: string; params: unknown }[] = [];
  private socket: WebSocket | undefined;
  private nextTabId = 1;
  private tabs = new Map<number, string>();
  private responseBodies = new Map<string, string>();

  async attach(endpoint: string, initialUrl = "https://example.com/"): Promise<void> {
    this.socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("open", resolve);
      this.socket!.once("error", reject);
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (message.id === undefined || !message.method) return;
      this.commands.push({ method: message.method, params: message.params });
      const result = this.result(message.method, message.params);
      if (message.method === "chrome.tabs.create") {
        this.sendEvent("chrome.tabs.onCreated", [result]);
      }
      this.socket!.send(JSON.stringify({ id: message.id, result }));
      this.afterCommand(message.method, message.params);
      if (message.method === "chrome.tabs.remove") {
        const [tabId] = message.params as [number];
        this.tabs.delete(tabId);
        this.sendEvent("chrome.tabs.onRemoved", [tabId]);
      }
    });
    this.tabs.set(this.nextTabId, initialUrl);
    this.sendEvent("chrome.tabs.onCreated", [this.tab(this.nextTabId, initialUrl)]);
    this.sendEvent("extension.initialized", []);
  }

  close(reason?: string): void {
    this.socket?.close(1000, reason);
  }

  emitJsonResponse(capture: {
    url: string;
    method: string;
    status: number;
    body: string;
  }): void {
    const tabId = this.nextTabId;
    const requestId = `request-${Date.now()}-${Math.random()}`;
    this.responseBodies.set(requestId, capture.body);
    const source = { tabId };
    this.sendEvent("chrome.debugger.onEvent", [source, "Network.requestWillBeSent", {
      requestId,
      loaderId: "loader",
      documentURL: this.tabs.get(tabId),
      request: { url: capture.url, method: capture.method, headers: {} },
      timestamp: Date.now() / 1000,
      wallTime: Date.now() / 1000,
      initiator: { type: "other" },
      type: "Fetch",
    }]);
    this.sendEvent("chrome.debugger.onEvent", [source, "Network.responseReceived", {
      requestId,
      loaderId: "loader",
      timestamp: Date.now() / 1000,
      type: "Fetch",
      response: {
        url: capture.url,
        status: capture.status,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
        connectionReused: false,
        connectionId: 1,
        encodedDataLength: capture.body.length,
        securityState: "secure",
      },
    }]);
    this.sendEvent("chrome.debugger.onEvent", [source, "Network.loadingFinished", {
      requestId,
      timestamp: Date.now() / 1000,
      encodedDataLength: capture.body.length,
    }]);
  }

  private tab(id: number, url: string) {
    return { id, index: id - 1, windowId: 1, url, active: true, pinned: false };
  }

  private sendEvent(method: string, params: unknown[]): void {
    this.socket?.send(JSON.stringify({ method, params }));
  }

  private afterCommand(method: string, params: unknown): void {
    if (method !== "chrome.debugger.sendCommand") return;
    const [target, cdpMethod] = params as [{ tabId: number }, string];
    if (cdpMethod === "Runtime.enable" || cdpMethod === "Page.createIsolatedWorld") {
      const isolated = cdpMethod === "Page.createIsolatedWorld";
      queueMicrotask(() => this.sendEvent("chrome.debugger.onEvent", [
        target,
        "Runtime.executionContextCreated",
        {
          context: {
            id: isolated ? target.tabId + 100 : target.tabId,
            origin: origin(this.tabs.get(target.tabId) ?? ""),
            name: isolated ? String((params as any[])?.[2]?.worldName ?? "__puppeteer_utility_world__") : "",
            uniqueId: `context-${target.tabId}-${isolated ? "isolated" : "default"}`,
            auxData: {
              isDefault: !isolated,
              type: isolated ? "isolated" : "default",
              frameId: `frame-${target.tabId}`,
            },
          },
        },
      ]));
    }
    if (cdpMethod === "Page.reload" || cdpMethod === "Page.navigate") {
      const frameId = `frame-${target.tabId}`;
      const loaderId = `loader-${target.tabId}`;
      queueMicrotask(() => {
        this.sendEvent("chrome.debugger.onEvent", [target, "Page.frameNavigated", {
          frame: {
            id: frameId,
            loaderId,
            url: this.tabs.get(target.tabId),
            securityOrigin: origin(this.tabs.get(target.tabId) ?? ""),
            mimeType: "text/html",
          },
          type: "Navigation",
        }]);
        for (const name of ["init", "DOMContentLoaded", "load"]) {
          this.sendEvent("chrome.debugger.onEvent", [target, "Page.lifecycleEvent", {
            frameId,
            loaderId,
            name,
            timestamp: Date.now() / 1000,
          }]);
        }
        this.sendEvent("chrome.debugger.onEvent", [target, "Page.loadEventFired", {
          timestamp: Date.now() / 1000,
        }]);
      });
    }
  }

  private result(method: string, params: unknown): unknown {
    if (method === "chrome.tabs.create") {
      const [{ url }] = params as [{ url?: string }];
      const id = ++this.nextTabId;
      const createdUrl = url ?? "about:blank";
      this.tabs.set(id, createdUrl);
      return this.tab(id, createdUrl);
    }
    if (method === "chrome.tabs.remove") return {};
    if (method !== "chrome.debugger.sendCommand") return {};
    const [target, cdpMethod, cdpParams] = params as [
      { tabId: number },
      string,
      Record<string, any> | undefined,
    ];
    const url = this.tabs.get(target.tabId) ?? "";
    if (cdpMethod === "Target.getTargetInfo") {
      return { targetInfo: { targetId: `target-${target.tabId}`, type: "page", url } };
    }
    if (cdpMethod === "Page.getFrameTree") {
      return { frameTree: { frame: { id: `frame-${target.tabId}`, url, securityOrigin: origin(url), mimeType: "text/html" } } };
    }
    if (cdpMethod === "Page.createIsolatedWorld") {
      return { executionContextId: target.tabId + 100 };
    }
    if (cdpMethod === "Page.navigate") {
      const next = String(cdpParams?.url ?? url);
      this.tabs.set(target.tabId, next);
      return { frameId: `frame-${target.tabId}`, loaderId: `loader-${target.tabId}` };
    }
    if (cdpMethod === "Page.reload") return {};
    if (cdpMethod === "Runtime.evaluate") {
      const expression = String(cdpParams?.expression ?? "");
      return remote(expression.includes("document.title") ? "Shared" : undefined);
    }
    if (cdpMethod === "Runtime.callFunctionOn") {
      const declaration = String(cdpParams?.functionDeclaration ?? "");
      if (declaration.includes("pageDomExtract")) {
        return remote({ url, title: "Shared", value: { title: "Shared" } });
      }
      if (declaration.includes("pageSnapshot")) {
        return remote({ url, title: "Shared", text: "Shared page", html: "<body>Shared page</body>" });
      }
      if (declaration.includes("pagePerformCount")) return remote(1);
      if (/pagePerform(Fill|Click|Submit|Press)/.test(declaration)) return remote({ ok: true });
      if (declaration.includes("document.title")) return remote("Shared");
      if (declaration.includes("fetch(req.url")) {
        return remote({ url: `${origin(url)}/api/me`, status: 200, body: '{"me":true}' });
      }
      return remote(undefined);
    }
    if (cdpMethod === "Network.getResponseBody") {
      return { body: this.responseBodies.get(String(cdpParams?.requestId)) ?? "", base64Encoded: false };
    }
    if (cdpMethod === "Page.captureScreenshot") {
      return { data: Buffer.from("fake png").toString("base64") };
    }
    return {};
  }
}

function remote(value: unknown): { result: Record<string, unknown> } {
  if (value === undefined) return { result: { type: "undefined" } };
  return { result: { type: typeof value, value } };
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}
