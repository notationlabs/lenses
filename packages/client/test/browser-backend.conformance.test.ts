import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
import {
  createCdpBackend,
  createDirectCdpTransport,
  type CdpTransport,
} from "../src/cdp-host.js";
import { CDPRelayServer } from "../src/playwright-relay/cdp-relay.js";
import { FakePlaywrightExtension } from "./playwright-relay-fake.js";

interface BackendFixture {
  backend: BrowserBackend;
  emitCapture(capture: InterceptedResponse): Promise<void>;
  closed(): boolean;
  reloads(): number;
  disconnect?(): void;
  backgroundCreates?(): number;
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

describe("Playwright relay BrowserBackend contract", () => {
  let fixture: BackendFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("runs shared session, page, HTTP, cleanup, and disconnect primitives", async () => {
    fixture = await createPlaywrightRelayFixture();
    const backend = fixture.backend;
    const session = await backend.bind({
      target: "https://example.com/shared",
      loadTimeoutMs: 1000,
      navigation: "fresh",
    });
    expect(session).toMatchObject({ created: true, navigated: true });
    expect(fixture.backgroundCreates?.()).toBe(1);

    await fixture.emitCapture(captured("relay"));
    await expectCapture(session, "https://example.com/api/relay");
    await expect(session.domExtract(domSpec.resolve[0] as never)).resolves.toMatchObject({
      value: { title: "Shared" },
    });
    await expect(session.perform([
      { fill: "#input", value: "hello" },
      { click: "#send" },
      { wait: { appears: "#done", timeoutMs: 100 } },
    ])).resolves.toMatchObject({
      url: "https://example.com/shared",
    });
    await expect(session.snapshot({ maxChars: 6000, html: true })).resolves.toMatchObject({
      title: "Shared",
      text: "Shared page",
    });
    await expect(session.recordingState()).resolves.toMatchObject({
      url: "https://example.com/shared",
      loading: false,
    });
    await expect(session.recordingScreenshot()).resolves.toBe(
      Buffer.from("fake png").toString("base64")
    );
    await expect(backend.httpFetch!({
      method: "GET",
      url: "https://api.example.com/api/me",
    })).resolves.toMatchObject({ status: 200, body: '{"me":true}' });

    await backend.finish(session, "close-if-created");
    expect(fixture.closed()).toBe(true);

    const reused = await backend.bind({
      target: "https://example.com/",
      loadTimeoutMs: 1000,
      navigation: "reuse",
    });
    expect(reused).toMatchObject({ created: false, navigated: false });
    await backend.finish(reused, "close-if-created");
    const fresh = await backend.bind({
      target: "https://example.com/",
      loadTimeoutMs: 1000,
      navigation: "fresh",
    });
    expect(fresh).toMatchObject({ created: false, navigated: true });
    await backend.finish(fresh, "close-if-created");

    fixture.disconnect?.();
    await vi.waitFor(() => expect(backend.available()).toBe(false));
    expect(backend.info().diagnostic).toContain("disconnected");
  }, 10_000);
});

describe("backend httpFetch", () => {
  function stubFetch(body: string) {
    const init: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      init.push(options);
      return new Response(body, { status: 200 });
    });
    return init;
  }

  it("uses a temporary same-origin page when no matching page is open", async () => {
    const fixture = await createCdpFixture();
    try {
      const request = { method: "GET", url: "https://example.com/api/me" };
      await fixture.backend.bind({
        target: "https://other.com/",
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
      expect(fixture.closed()).toBe(true);

      await fixture.backend.bind({
        target: "https://example.com/shared",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      await expect(fixture.backend.httpFetch!(request)).resolves.toMatchObject({
        method: "GET",
        url: "https://example.com/api/me",
        status: 200,
        body: '{"me":true}',
      });
      expect(init).toEqual([
        expect.objectContaining({ credentials: "include" }),
        expect.objectContaining({ credentials: "include" }),
      ]);
    } finally {
      vi.unstubAllGlobals();
      await fixture.close();
    }
  });

  it("opens a temporary tab for explicit same-origin-page fetches", async () => {
    const fixture = await createCdpFixture();
    try {
      await fixture.backend.bind({
        target: "https://other.com/",
        loadTimeoutMs: 1000,
        navigation: "fresh",
      });
      const init = stubFetch('{"me":true}');
      await expect(
        fixture.backend.httpFetch!({
          method: "GET",
          url: "https://example.com/api/me",
          context: "same-origin-page",
        })
      ).resolves.toMatchObject({
        method: "GET",
        url: "https://example.com/api/me",
        status: 200,
        body: '{"me":true}',
      });
      expect(init).toEqual([expect.objectContaining({ credentials: "include" })]);
      expect(fixture.closed()).toBe(true);
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

async function createPlaywrightRelayFixture(): Promise<BackendFixture> {
  const relay = new CDPRelayServer();
  await relay.start();
  const extension = new FakePlaywrightExtension();
  await extension.attach(relay.extensionEndpoint(), "https://example.com/");
  await relay.waitForExtension();
  const realPuppeteer = await vi.importActual<typeof import("puppeteer-core")>(
    "puppeteer-core"
  );
  let connected: import("puppeteer-core").Browser | undefined;
  const transport: CdpTransport = {
    name: "playwright-extension",
    pollForConnection: false,
    retryConnect: false,
    looksReady: () => true,
    probeLive: async () => true,
    connectHint: () => "connect test relay",
    staleHint: () => "test relay unavailable",
    async connect() {
      connected = await realPuppeteer.default.connect({
        browserWSEndpoint: relay.cdpEndpoint(),
        defaultViewport: null,
      });
      return connected;
    },
  };
  const backend = createCdpBackend(() => {}, transport);
  return {
    backend,
    async emitCapture(capture) {
      extension.emitJsonResponse(capture);
      await Promise.resolve();
    },
    closed: () =>
      extension.commands.some((command) => command.method === "chrome.tabs.remove"),
    reloads: () =>
      extension.commands.filter((command) => {
        if (command.method !== "chrome.debugger.sendCommand") return false;
        return (command.params as unknown[])?.[1] === "Page.reload";
      }).length,
    backgroundCreates: () =>
      extension.commands.filter((command) =>
        command.method === "chrome.tabs.create" &&
        (command.params as [{ active?: boolean }])[0]?.active === false
      ).length,
    disconnect() {
      extension.close("controlled group closed");
    },
    async close() {
      backend.stop();
      await backend.release();
      connected = undefined;
      extension.close();
      relay.stop();
    },
  };
}

async function createCdpFixture(): Promise<BackendFixture> {
  const browser = new FakeBrowser();
  cdpState.browser = browser;
  const backend = createCdpBackend(
    () => {},
    createDirectCdpTransport(async () => true)
  );
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

