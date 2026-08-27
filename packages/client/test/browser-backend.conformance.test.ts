import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_PROTOCOL_MAJOR,
  decodeBrokerExtensionMessage,
  decodeExtensionRpcRequest,
  pageDomExtract,
  pagePerformClick,
  pagePerformCount,
  pagePerformFill,
  pagePerformPress,
  pagePerformSubmit,
  pageSnapshot,
  type InterceptedResponse,
  type LensResult,
  type LensSpec,
} from "@djgrant/lenses-core";

const cdpState = vi.hoisted(() => ({
  browser: undefined as FakeBrowser | undefined,
}));

// existsSync is stubbed for the Chrome-binary probe; the rest must stay real,
// since the extension backend hashes the page-functions module off disk.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => true,
}));

vi.mock("puppeteer-core", () => ({
  default: {
    connect: async () => cdpState.browser,
  },
}));

import { createBrokerOrchestrator } from "../src/broker-orchestrator.js";
import type {
  BrowserBackend,
  BrowserSession,
} from "../src/browser-backend.js";
import { createCdpBackend } from "../src/cdp-host.js";
import { createExtensionBackend } from "../src/extension-backend.js";
import {
  createExtensionSessionBackend,
  type ExtensionSessionBackend,
} from "../../../extensions/chrome/src/background/session-backend.js";
import { listenForIntercepts } from "../../../extensions/chrome/src/background/intercepts.js";

interface BackendFixture {
  backend: BrowserBackend;
  emitCapture(capture: InterceptedResponse): Promise<void>;
  closed(): boolean;
  reloads(): number;
  close(): Promise<void>;
}

const captured = (suffix: string): InterceptedResponse => ({
  url: `https://example.com/api/${suffix}`,
  method: "GET",
  status: 200,
  body: JSON.stringify({ suffix }),
  timestamp: Date.now(),
});

/**
 * Shared perform state both fake pages read: recorded fill/click/press
 * actions, and primed count sequences for the wait probe (successive polls
 * shift the queue; the last value repeats).
 */
const performActions: string[] = [];
const performCounts = new Map<string, number[]>();

function resetPerformState(): void {
  performActions.length = 0;
  performCounts.clear();
}

function nextPerformCount(selector: string): number {
  const queue = performCounts.get(selector);
  if (!queue || queue.length === 0) return 0;
  return queue.length > 1 ? (queue.shift() as number) : queue[0];
}

const domSpec: LensSpec = {
  name: "@example/web/shared",
  url: "https://example.com/shared",
  effects: { reads: ["example.com"], writes: [] },
  resolve: [
    {
      kind: "dom",
      fields: { title: { selector: "h1" } },
    },
  ],
};

for (const [name, createFixture] of [
  ["CDP", createCdpFixture],
  ["extension", createExtensionFixture],
] as const) {
  describe(`${name} browser backend conformance`, () => {
    let fixture: BackendFixture | undefined;

    afterEach(async () => {
      await fixture?.close();
      fixture = undefined;
    });

    it("implements the bound-session primitive contract", async () => {
      fixture = await createFixture();
      const session = await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });

      expect(session).toMatchObject({
        created: true,
        navigated: true,
      });
      await fixture.emitCapture(captured("one"));
      await expectCapture(session, "https://example.com/api/one");
      await expect(session.domExtract(domSpec.resolve[0] as never)).resolves.toEqual({
        url: "https://example.com/shared",
        title: "Shared",
        value: { title: "Shared" },
      });
      await expect(session.recordingState()).resolves.toMatchObject({
        url: "https://example.com/shared",
        documentRevision: 0,
        loading: false,
      });
      await expect(session.recordingScreenshot()).resolves.toBe(
        Buffer.from("fake png").toString("base64")
      );
      await expect(
        session.snapshot({ maxChars: 6000, html: true })
      ).resolves.toEqual({
        url: "https://example.com/shared",
        title: "Shared",
        text: "Shared page",
        html: "<body>Shared page</body>",
      });

      await session.reload(1000);
      expect(fixture.reloads()).toBe(1);
      await expect(
        session.readIntercepts(0, Date.now())
      ).resolves.toEqual({
        captures: [],
        nextCursor: 1,
        truncated: true,
      });
      await fixture.emitCapture(captured("two"));
      const afterReload = await session.readIntercepts(1, Date.now());
      expect(afterReload).toMatchObject({
        nextCursor: 2,
        truncated: false,
      });
      expect(afterReload.captures).toContainEqual(
        expect.objectContaining({
          url: "https://example.com/api/two",
        })
      );
      await fixture.backend.finish(session, "close-if-created");
      expect(fixture.closed()).toBe(true);
    });

    it("performs steps through the shared page primitives", async () => {
      fixture = await createFixture();
      resetPerformState();
      performCounts.set("#done", [0, 1]);
      const session = await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "reuse",
      });

      const result = await session.perform([
        { fill: "#input", value: "hello" },
        { click: "#send" },
        { submit: "#composer", form: { description: "published" } },
        { press: "Enter" },
        { wait: { appears: "#done" } },
        { navigate: "fresh" },
      ]);

      expect(result).toEqual({ url: "https://example.com/shared", title: "" });
      expect(performActions).toEqual([
        "fill #input hello",
        "click #send",
        "submit #composer {\"description\":\"published\"}",
        "press Enter",
      ]);
      expect(fixture.reloads()).toBe(1);

      const failed = await session.perform([
        { wait: { appears: "#never", timeoutMs: 1 } },
      ]);
      expect(failed).toMatchObject({
        failedStep: 0,
        message: expect.stringContaining('appears "#never"'),
        url: "https://example.com/shared",
      });
      await fixture.backend.finish(session, "close-if-created");
    });

    it("derives a sign-in gate from a kept session", async () => {
      fixture = await createFixture();
      const target = "https://example.com/shared";

      await expect(
        fixture.backend.findAuthGate("https://example.com")
      ).resolves.toBeUndefined();

      const session = await fixture.backend.bind({
        target,
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      await fixture.backend.finish(session, "keep");

      await expect(
        fixture.backend.findAuthGate("https://example.com")
      ).resolves.toEqual({ url: target, target });
      await expect(
        fixture.backend.findAuthGate("https://other.com")
      ).resolves.toBeUndefined();
    });

    it("runs shared call and observe orchestration over the backend", async () => {
      fixture = await createFixture();
      const orchestrator = createBrokerOrchestrator([fixture.backend]);

      const call = await orchestrate(orchestrator, {
        type: "call",
        id: "call",
        spec: domSpec,
        params: {},
        timeoutMs: 5000,
      });
      expect(call).toEqual({
        kind: "value",
        value: { title: "Shared" },
        resolver: "dom",
        observed: "https://example.com/shared",
      });

      const observation = await orchestrate(orchestrator, {
        type: "observe",
        id: "observe",
        target: "https://example.com/shared",
        waitMs: 0,
        html: true,
      });
      expect(observation).toMatchObject({
        kind: "value",
        value: {
          snapshot: {
            title: "Shared",
            text: "Shared page",
            html: "<body>Shared page</body>",
          },
          requests: [],
        },
      });
    });
  });
}

describe("backend httpFetch", () => {
  function stubFetch(body: string) {
    const init: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      init.push(options);
      return new Response(body, { status: 200 });
    });
    return init;
  }

  it("CDP evaluates the fetch in an existing same-origin page, and answers undefined without one", async () => {
    const fixture = await createCdpFixture();
    try {
      const request = { method: "GET", url: "https://example.com/api/me" };
      await fixture.backend.bind({
        target: "https://other.com/",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      await expect(fixture.backend.httpFetch!(request)).resolves.toBeUndefined();

      await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      const init = stubFetch('{"me":true}');
      await expect(fixture.backend.httpFetch!(request)).resolves.toMatchObject({
        method: "GET",
        url: "https://example.com/api/me",
        status: 200,
        body: '{"me":true}',
      });
      expect(init).toEqual([expect.objectContaining({ credentials: "include" })]);
    } finally {
      vi.unstubAllGlobals();
      await fixture.close();
    }
  });

  it("CDP materialises JSON bodies in the page fetch", async () => {
    const fixture = await createCdpFixture();
    try {
      await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      const init = stubFetch('{"ok":true}');
      await fixture.backend.httpFetch!({
        method: "POST",
        url: "https://example.com/api/items",
        body: { kind: "json", value: '{"name":"new"}' },
      });
      expect(init).toEqual([expect.objectContaining({
        credentials: "include",
        body: '{"name":"new"}',
        headers: { "content-type": "application/json" },
      })]);
    } finally {
      vi.unstubAllGlobals();
      await fixture.close();
    }
  });

  it("extension executes same-origin requests in an existing tab's MAIN world", async () => {
    const fixture = await createExtensionFixture();
    try {
      const request = {
        method: "POST",
        url: "https://example.com/api/items",
        context: "same-origin-page" as const,
        body: { kind: "search" as const, entries: [["_method", "delete"]] as [string, string][] },
      };
      const init = stubFetch('<html>deleted</html>');
      await expect(fixture.backend.httpFetch!(request)).resolves.toBeUndefined();
      expect(init).toHaveLength(0);

      await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      await expect(fixture.backend.httpFetch!(request)).resolves.toMatchObject({
        method: "POST",
        url: "https://example.com/api/items",
        status: 200,
        body: "<html>deleted</html>",
      });
      expect(init[0]).toMatchObject({
        credentials: "include",
        redirect: "follow",
      });
      expect(String(init[0].body)).toBe("_method=delete");
      expect(fixture.backend.info().sameOriginPageRequests).toBe(true);
      expect(fixture.backend.supports?.("same-origin-page-http")).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("extension fetches through the service worker without binding a tab", async () => {
    const fixture = await createExtensionFixture();
    try {
      const init = stubFetch('{"me":true}');
      await expect(
        fixture.backend.httpFetch!({ method: "GET", url: "https://example.com/api/me" })
      ).resolves.toMatchObject({
        method: "GET",
        url: "https://example.com/api/me",
        status: 200,
        body: '{"me":true}',
      });
      expect(init).toEqual([expect.objectContaining({ credentials: "include" })]);
    } finally {
      await fixture.close();
    }
  });

  it("extension materialises URLSearchParams bodies", async () => {
    const fixture = await createExtensionFixture();
    try {
      const init = stubFetch('{"ok":true}');
      await fixture.backend.httpFetch!({
        method: "PATCH",
        url: "https://example.com/api/items",
        body: { kind: "search", entries: [["tag", "a"], ["tag", "b"]] },
      });
      expect(init[0]).toMatchObject({ credentials: "include" });
      expect(String(init[0].body)).toBe("tag=a&tag=b");
    } finally {
      await fixture.close();
    }
  });
});

async function expectCapture(
  session: BrowserSession,
  url: string
): Promise<void> {
  await vi.waitFor(async () => {
    const delta = await session.readIntercepts(0, Date.now());
    expect(delta.captures).toContainEqual(
      expect.objectContaining({ url })
    );
    expect(delta.nextCursor).toBe(1);
    expect(delta.truncated).toBe(false);
  });
}

async function orchestrate(
  orchestrator: ReturnType<typeof createBrokerOrchestrator>,
  message: Parameters<typeof orchestrator.handle>[0]
): Promise<LensResult> {
  let result: LensResult | undefined;
  await orchestrator.handle(message, (frame) => {
    if (frame.type === "result") result = frame.result;
  });
  if (!result) throw new Error("orchestrator emitted no result");
  return result;
}

class FakePage {
  currentUrl = "about:blank";
  closed = false;
  reloadCount = 0;
  private responseListener?: (response: FakeResponse) => void;

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  on(event: string, listener: (response: FakeResponse) => void): void {
    if (event === "response") this.responseListener = listener;
  }

  mainFrame(): this {
    return this;
  }

  async title(): Promise<string> {
    return "";
  }

  async screenshot(options: { fullPage?: boolean }): Promise<string> {
    expect(options).toMatchObject({ fullPage: true });
    return Buffer.from("fake png").toString("base64");
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  async evaluate(
    fn: typeof pageDomExtract | typeof pageSnapshot | ((arg: never) => unknown),
    options: unknown
  ): Promise<unknown> {
    // The perform primitives need a DOM, so the fake answers for them.
    if (fn === pagePerformFill) {
      const spec = options as { selector: string; value: string };
      performActions.push(`fill ${spec.selector} ${spec.value}`);
      return { ok: true };
    }
    if (fn === pagePerformClick) {
      const spec = options as { selector: string };
      performActions.push(`click ${spec.selector}`);
      return { ok: true };
    }
    if (fn === pagePerformSubmit) {
      const spec = options as { selector: string; form?: Record<string, string> };
      performActions.push(`submit ${spec.selector} ${JSON.stringify(spec.form)}`);
      return { ok: true };
    }
    if (fn === pagePerformPress) {
      const spec = options as { key: string };
      performActions.push(`press ${spec.key}`);
      return { ok: true };
    }
    if (fn === pagePerformCount) {
      return nextPerformCount((options as { selector: string }).selector);
    }
    // An inline function (the httpFetch page script) runs as-is against the
    // test's stubbed fetch, exercising its real body.
    if (fn !== pageDomExtract && fn !== pageSnapshot) {
      return (fn as (arg: unknown) => unknown)(options);
    }
    if (fn === pageDomExtract) {
      return {
        url: this.currentUrl,
        title: "Shared",
        value: { title: "Shared" },
      };
    }
    expect(options).toMatchObject({ maxChars: expect.any(Number) });
    return {
      url: this.currentUrl,
      title: "Shared",
      text: "Shared page",
      ...((options as { html?: boolean }).html
        ? { html: "<body>Shared page</body>" }
        : {}),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitCapture(capture: InterceptedResponse): void {
    this.responseListener?.(new FakeResponse(capture));
  }
}

class FakeResponse {
  constructor(private readonly capture: InterceptedResponse) {}

  headers(): Record<string, string> {
    return { "content-type": "application/json" };
  }

  async text(): Promise<string> {
    return this.capture.body;
  }

  url(): string {
    return this.capture.url;
  }

  request() {
    return { method: () => this.capture.method };
  }

  status(): number {
    return this.capture.status;
  }
}

class FakeBrowser {
  connected = true;
  pagesCreated: FakePage[] = [];
  private disconnected?: () => void;

  async version(): Promise<string> {
    return "Chrome/144.0.0.0";
  }

  on(event: string, listener: () => void): void {
    if (event === "disconnected") this.disconnected = listener;
  }

  async pages(): Promise<FakePage[]> {
    return this.pagesCreated.filter((page) => !page.closed);
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pagesCreated.push(page);
    return page;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnected?.();
  }
}

async function createCdpFixture(): Promise<BackendFixture> {
  const browser = new FakeBrowser();
  cdpState.browser = browser;
  const backend = createCdpBackend(() => {}, async () => true);
  return {
    backend,
    async emitCapture(capture) {
      browser.pagesCreated.at(-1)?.emitCapture(capture);
      await Promise.resolve();
    },
    closed: () => browser.pagesCreated.at(-1)?.closed ?? false,
    reloads: () =>
      browser.pagesCreated.reduce(
        (total, page) => total + page.reloadCount,
        0
      ),
    async close() {
      backend.stop();
      await backend.release();
      cdpState.browser = undefined;
    },
  };
}

class ChromeEvent {
  private listeners = new Set<(...args: any[]) => void>();

  addListener(listener: (...args: any[]) => void): void {
    this.listeners.add(listener);
  }

  removeListener(listener: (...args: any[]) => void): void {
    this.listeners.delete(listener);
  }

  emit(...args: any[]): void {
    for (const listener of this.listeners) listener(...args);
  }
}

async function createExtensionFixture(): Promise<BackendFixture> {
  const chrome = createChromeMock();
  vi.stubGlobal("chrome", chrome.api);
  listenForIntercepts();
  const sessionBackend = createExtensionSessionBackend();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("test WebSocket server has no TCP address");
  }
  const accepted = new Promise<WebSocket>((resolve) =>
    server.once("connection", resolve)
  );
  const extensionSocket = new WebSocket(
    `ws://127.0.0.1:${address.port}`
  );
  const brokerSocket = await accepted;
  await new Promise<void>((resolve) => {
    if (extensionSocket.readyState === WebSocket.OPEN) resolve();
    else extensionSocket.once("open", resolve);
  });

  const epoch = "extension_conformance_epoch";
  wireExtension(extensionSocket, sessionBackend, epoch);
  const backend = createExtensionBackend();
  expect(
    backend.attach(brokerSocket, {
      type: "extension-hello",
      protocolMajor: EXTENSION_PROTOCOL_MAJOR,
      extensionVersion: "0.1.0",
      capabilities: [...EXTENSION_CAPABILITIES],
      epoch,
      ua: "Chrome/144",
    })
  ).toBe(true);

  return {
    backend,
    async emitCapture(capture) {
      chrome.runtimeMessages.emit(
        { type: "intercepted", token: chrome.interceptToken, response: capture },
        { tab: { id: 1 } }
      );
    },
    closed: () => chrome.removedTabs.includes(1),
    reloads: () => chrome.reloadCount,
    async close() {
      backend.stop();
      extensionSocket.close();
      await sessionBackend.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllGlobals();
    },
  };
}

function wireExtension(
  socket: WebSocket,
  backend: ExtensionSessionBackend,
  epoch: string
): void {
  socket.on("message", (data) => {
    void (async () => {
      const value = JSON.parse(data.toString());
      const message = decodeBrokerExtensionMessage(value);
      if (message.type === "extension-hello-result") return;
      if (message.type === "extension-ping") {
        socket.send(
          JSON.stringify({
            type: "extension-pong",
            nonce: message.nonce,
            epoch,
          })
        );
        return;
      }
      const request = decodeExtensionRpcRequest(message, epoch);
      try {
        const result = await backend.handle(request);
        socket.send(
          JSON.stringify({
            type: "extension-rpc-result",
            requestId: request.requestId,
            epoch,
            ok: true,
            result,
          })
        );
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "extension-rpc-result",
            requestId: request.requestId,
            epoch,
            ok: false,
            error: {
              code: "backend-error",
              message:
                error instanceof Error ? error.message : String(error),
            },
          })
        );
      }
    })();
  });
}

function createChromeMock() {
  const tabUpdates = new ChromeEvent();
  const tabRemovals = new ChromeEvent();
  const runtimeMessages = new ChromeEvent();
  const storage = new Map<string, unknown>();
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const removedTabs: number[] = [];
  let reloadCount = 0;
  let interceptToken: string | undefined;

  return {
    runtimeMessages,
    get interceptToken() {
      return interceptToken;
    },
    removedTabs,
    get reloadCount() {
      return reloadCount;
    },
    api: {
      runtime: {
        onMessage: runtimeMessages,
      },
      scripting: {
        async executeScript(injection: {
          target: { tabId: number };
          world: string;
          func: (...args: any[]) => unknown;
          args: any[];
        }) {
          expect(injection.world).toBe("MAIN");
          const tab = tabs.get(injection.target.tabId);
          if (!tab) throw new Error("missing injection tab");
          if (injection.args[0] === "install" || injection.args[0] === "remove") {
            return [{ frameId: 0, result: undefined }];
          }
          vi.stubGlobal("location", new URL(tab.url));
          return [{ frameId: 0, result: await injection.func(...injection.args) }];
        },
      },
      debugger: {
        async attach() {},
        async sendCommand(_target: unknown, command: string, params?: unknown) {
          if (command === "Page.getLayoutMetrics") {
            return { cssContentSize: { width: 1200, height: 3400 } };
          }
          expect(command).toBe("Page.captureScreenshot");
          expect(params).toMatchObject({
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: 1200, height: 3400, scale: 1 },
          });
          return { data: Buffer.from("fake png").toString("base64") };
        },
        async detach() {},
      },
      tabs: {
        onUpdated: tabUpdates,
        onRemoved: tabRemovals,
        async query() {
          return [...tabs.values()].map((tab) => ({ ...tab }));
        },
        async create({ url }: { url: string }) {
          const tab = { id: 1, url, status: "complete" };
          tabs.set(tab.id, tab);
          return { ...tab };
        },
        async get(tabId: number) {
          return { ...(tabs.get(tabId) ?? { id: tabId, status: "complete" }) };
        },
        async reload(tabId: number) {
          reloadCount += 1;
          queueMicrotask(() =>
            tabUpdates.emit(tabId, { status: "complete" })
          );
        },
        async remove(tabId: number) {
          removedTabs.push(tabId);
          tabs.delete(tabId);
          tabRemovals.emit(tabId);
        },
        async sendMessage(_tabId: number, message: any) {
          if (message.type === "ping") return { ok: true };
          if (message.type === "intercepts-enable") {
            interceptToken = message.token;
            return { ok: true };
          }
          if (message.type === "intercepts-disable") {
            if (message.token === interceptToken) interceptToken = undefined;
            return { ok: true };
          }
          if (message.type === "perform_fill") {
            performActions.push(`fill ${message.selector} ${message.value}`);
            return { ok: true };
          }
          if (message.type === "perform_click") {
            performActions.push(`click ${message.selector}`);
            return { ok: true };
          }
          if (message.type === "perform_submit") {
            performActions.push(`submit ${message.selector} ${JSON.stringify(message.form)}`);
            return { ok: true };
          }
          if (message.type === "perform_press") {
            performActions.push(`press ${message.key}`);
            return { ok: true };
          }
          if (message.type === "perform_count") {
            return { count: nextPerformCount(message.selector) };
          }
          if (message.type === "dom_extract") {
            return {
              url: "https://example.com/shared",
              title: "Shared",
              value: { title: "Shared" },
            };
          }
          if (message.type === "snapshot") {
            return {
              url: "https://example.com/shared",
              title: "Shared",
              text: "Shared page",
              ...(message.html
                ? { html: "<body>Shared page</body>" }
                : {}),
            };
          }
          throw new Error(`unexpected tab message ${message.type}`);
        },
      },
      storage: {
        session: {
          async get(key: string) {
            return { [key]: storage.get(key) };
          },
          async set(values: Record<string, unknown>) {
            for (const [key, value] of Object.entries(values)) {
              storage.set(key, value);
            }
          },
          async remove(key: string) {
            storage.delete(key);
          },
        },
      },
    },
  };
}
