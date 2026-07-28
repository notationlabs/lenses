import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  EXTENSION_CAPABILITIES,
  EXTENSION_PROTOCOL_MAJOR,
  decodeBrokerExtensionMessage,
  decodeExtensionRpcRequest,
  pageDomExtract,
  pageSnapshot,
  type InterceptedResponse,
  type LensResult,
  type LensSpec,
} from "@djgrant/lens";

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

    it("reports open pages for the auth gate", async () => {
      fixture = await createFixture();
      const target = "https://example.com/shared";

      await expect(fixture.backend.hasPage(target)).resolves.toBe(false);
      const session = await fixture.backend.bind({
        target,
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      await expect(fixture.backend.hasPage(target)).resolves.toBe(true);
      await expect(
        fixture.backend.hasPage("https://example.com/elsewhere")
      ).resolves.toBe(false);

      await fixture.backend.finish(session, "close-if-created");
      await expect(fixture.backend.hasPage(target)).resolves.toBe(false);
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

  on(event: string, listener: (response: FakeResponse) => void): void {
    if (event === "response") this.responseListener = listener;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async reload(): Promise<void> {
    this.reloadCount += 1;
  }

  async evaluate(
    fn: typeof pageDomExtract | typeof pageSnapshot,
    options: unknown
  ): Promise<unknown> {
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
  const backend = createCdpBackend();
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
        { type: "intercepted", response: capture },
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

  return {
    runtimeMessages,
    removedTabs,
    get reloadCount() {
      return reloadCount;
    },
    api: {
      runtime: {
        onMessage: runtimeMessages,
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
