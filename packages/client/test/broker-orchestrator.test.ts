import { describe, expect, it, vi } from "vitest";
import type {
  DomResolver,
  InterceptedResponse,
  LensBridgeRequest,
  LensResult,
  LensSpec,
  PageSnapshot,
  PerformResult,
  PerformStep,
} from "@djgrant/lenses-core";
import {
  createBrokerOrchestrator,
  createSessionEngineIO,
  type BrokerFrame,
} from "../src/broker-orchestrator.js";
import type {
  BindRequest,
  BrowserBackend,
  BrowserSession,
  FinishDisposition,
  InterceptDelta,
  SnapshotOptions,
} from "../src/browser-backend.js";

const capture = (body: string): InterceptedResponse => ({
  url: `https://example.com/${body}`,
  method: "GET",
  status: 200,
  body: JSON.stringify({ body }),
  timestamp: Date.now(),
});

class FakeSession implements BrowserSession {
  readonly id = "fake_session";
  readonly created = true;
  readonly navigated = true;
  reads: InterceptDelta[] = [];
  deadlines: number[] = [];
  reloads = 0;
  domResult = { url: "https://example.com", title: "Example", value: { title: "ok" } };
  snapshotResult: PageSnapshot = {
    url: "https://example.com",
    title: "Example",
    text: "page text",
  };
  failDom?: Error;

  async reload(): Promise<void> {
    this.reloads += 1;
  }

  async readIntercepts(_cursor: number, deadline: number): Promise<InterceptDelta> {
    this.deadlines.push(deadline);
    return this.reads.shift() ?? { captures: [], nextCursor: 0, truncated: false };
  }

  async domExtract(_resolver: DomResolver) {
    if (this.failDom) throw this.failDom;
    return this.domResult;
  }

  performCalls: PerformStep[][] = [];
  performResult: PerformResult | undefined;

  async perform(steps: PerformStep[]): Promise<PerformResult> {
    this.performCalls.push(steps);
    return (
      this.performResult ?? { url: this.domResult.url, title: this.domResult.title }
    );
  }

  async snapshot(_options: SnapshotOptions): Promise<PageSnapshot> {
    return this.snapshotResult;
  }
}

class FakeBackend implements BrowserBackend {
  readonly name: string;
  isAvailable: boolean;
  readonly session: FakeSession;
  binds: BindRequest[] = [];
  finishes: FinishDisposition[] = [];
  /** Set by a keep finish, the way a real backend records a kept tab. */
  authGate?: { url: string; target: string };
  onBind?: () => void;
  httpFetch?: BrowserBackend["httpFetch"];

  constructor(name: string, available = true, session = new FakeSession()) {
    this.name = name;
    this.isAvailable = available;
    this.session = session;
  }

  available(): boolean {
    return this.isAvailable;
  }

  info() {
    return { name: this.name };
  }

  onStatusChange(): () => void {
    return () => {};
  }

  async findAuthGate(origin: string) {
    if (!this.authGate) return undefined;
    return new URL(this.authGate.target).origin === origin
      ? this.authGate
      : undefined;
  }

  async bind(request: BindRequest): Promise<BrowserSession> {
    this.binds.push(request);
    this.onBind?.();
    return this.session;
  }

  async finish(_session: BrowserSession, disposition: FinishDisposition): Promise<void> {
    this.finishes.push(disposition);
    if (disposition === "keep" && this.binds.length > 0) {
      this.authGate = {
        url: this.session.snapshotResult.url,
        target: this.binds[this.binds.length - 1].target,
      };
    }
  }
}

function domSpec(overrides: Partial<LensSpec> = {}): LensSpec {
  return {
    name: "@example/page",
    url: "https://example.com",
    effects: { reads: ["example.com"], writes: [] },
    resolve: [{ kind: "dom", fields: { title: { selector: "h1" } } }],
    ...overrides,
  };
}

async function request(
  orchestrator: ReturnType<typeof createBrokerOrchestrator>,
  message: Exclude<LensBridgeRequest, { type: "control" }>
): Promise<LensResult> {
  const frames: BrokerFrame[] = [];
  await orchestrator.handle(message, (frame) => frames.push(frame));
  const result = frames.find(
    (frame): frame is Extract<BrokerFrame, { type: "result" }> =>
      frame.type === "result"
  );
  if (!result) throw new Error("orchestrator emitted no result");
  return result.result;
}

describe("broker orchestration", () => {
  it("pins a selected backend for the whole call", async () => {
    const preferred = new FakeBackend("extension");
    const fallback = new FakeBackend("cdp");
    preferred.onBind = () => {
      preferred.isAvailable = false;
    };
    const orchestrator = createBrokerOrchestrator([preferred, fallback]);

    const result = await request(orchestrator, {
      type: "call",
      id: "one",
      spec: domSpec(),
      params: {},
      timeoutMs: 1000,
    });

    expect(result.kind).toBe("value");
    expect(preferred.binds).toHaveLength(1);
    expect(preferred.finishes).toEqual(["close-if-created"]);
    expect(fallback.binds).toHaveLength(0);
  });

  it("keeps created pages for needs_ outcomes and closes other results", async () => {
    const session = new FakeSession();
    session.domResult = {
      url: "https://example.com/login",
      title: "Login",
      value: null,
    };
    const backend = new FakeBackend("cdp", true, session);
    const orchestrator = createBrokerOrchestrator([backend]);
    const spec = domSpec({
      outcomes: { needs_auth: null },
      resolve: [
        {
          kind: "dom",
          detect: { needs_auth: "title = 'Login'" },
          fields: { title: { selector: "h1" } },
        },
      ],
    });

    expect(
      await request(orchestrator, {
        type: "call",
        id: "needs",
        spec,
        params: {},
        timeoutMs: 1000,
      })
    ).toMatchObject({ kind: "outcome", name: "needs_auth" });
    expect(backend.finishes).toEqual(["keep"]);
  });

  it("short-circuits calls to a gated site while its sign-in tab stays open", async () => {
    const loginUrl = "https://example.com/login?next=/orders";
    const session = new FakeSession();
    session.domResult = { url: loginUrl, title: "Login", value: null };
    session.snapshotResult = { url: loginUrl, title: "Login", text: "" };
    const backend = new FakeBackend("cdp", true, session);
    const orchestrator = createBrokerOrchestrator([backend]);
    const gatedSpec = (url: string) =>
      domSpec({
        url,
        outcomes: { needs_auth: null },
        resolve: [
          {
            kind: "dom",
            detect: { needs_auth: "title = 'Login'" },
            fields: { title: { selector: "h1" } },
          },
        ],
      });

    expect(
      await request(orchestrator, {
        type: "call",
        id: "first",
        spec: gatedSpec("https://example.com/orders"),
        params: {},
        timeoutMs: 1000,
      })
    ).toMatchObject({ kind: "outcome", name: "needs_auth" });
    expect(backend.authGate).toEqual({
      url: loginUrl,
      target: "https://example.com/orders",
    });

    const second = await request(orchestrator, {
      type: "call",
      id: "second",
      spec: gatedSpec("https://example.com/invoices"),
      params: {},
      timeoutMs: 1000,
    });

    // Synthesised: named after the spec's needs_ outcome, valued with the
    // sign-in URL the caller must complete.
    expect(second).toEqual({
      kind: "outcome",
      name: "needs_auth",
      value: { url: loginUrl },
      resolver: "dom",
    });
    expect(backend.binds).toHaveLength(1);

    // Completing (or closing) the sign-in dissolves the gate.
    backend.authGate = undefined;
    session.domResult = {
      url: "https://example.com/invoices",
      title: "Invoices",
      value: { title: "Invoices" },
    };
    const third = await request(orchestrator, {
      type: "call",
      id: "third",
      spec: gatedSpec("https://example.com/invoices"),
      params: {},
      timeoutMs: 1000,
    });

    expect(third).toMatchObject({ kind: "value" });
    expect(backend.binds).toHaveLength(2);
  });

  it("gates only the sign-in tab's own site", async () => {
    const loginUrl = "https://example.com/login";
    const session = new FakeSession();
    session.domResult = { url: loginUrl, title: "Login", value: null };
    session.snapshotResult = { url: loginUrl, title: "Login", text: "" };
    const backend = new FakeBackend("cdp", true, session);
    const orchestrator = createBrokerOrchestrator([backend]);

    await request(orchestrator, {
      type: "call",
      id: "gated",
      spec: domSpec({
        outcomes: { needs_auth: null },
        resolve: [
          {
            kind: "dom",
            detect: { needs_auth: "title = 'Login'" },
            fields: { title: { selector: "h1" } },
          },
        ],
      }),
      params: {},
      timeoutMs: 1000,
    });
    expect(backend.authGate).toMatchObject({ url: loginUrl });
    session.domResult = {
      url: "https://other.com",
      title: "Other",
      value: { title: "Other" },
    };

    const other = await request(orchestrator, {
      type: "call",
      id: "other",
      spec: domSpec({ url: "https://other.com" }),
      params: {},
      timeoutMs: 1000,
    });

    expect(other).toMatchObject({ kind: "value" });
    expect(backend.binds).toHaveLength(2);
  });

  it("observes through a fresh session and includes HTML snapshots", async () => {
    const session = new FakeSession();
    session.reads.push({
      captures: [capture("observed")],
      nextCursor: 1,
      truncated: false,
    });
    session.snapshotResult = {
      url: "https://example.com",
      title: "Example",
      text: "text",
      html: "<body>text</body>",
    };
    const backend = new FakeBackend("cdp", true, session);
    const result = await request(createBrokerOrchestrator([backend]), {
      type: "observe",
      id: "observe",
      target: "https://example.com",
      waitMs: 0,
      html: true,
    });

    expect(backend.binds[0]).toMatchObject({ navigation: "fresh" });
    expect(result).toMatchObject({
      kind: "value",
      value: {
        snapshot: { html: "<body>text</body>" },
        requests: [{ url: "https://example.com/observed" }],
      },
    });
    expect(backend.finishes).toEqual(["close-if-created"]);
  });

  it("caches complete values in the shared orchestrator", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend("cdp");
    const orchestrator = createBrokerOrchestrator([backend]);
    const spec = domSpec({ effects: { reads: ["example.com"], writes: [], cache: 60 } });
    const call = (id: string) =>
      request(orchestrator, { type: "call", id, spec, params: {}, timeoutMs: 1000 });

    await call("first");
    const second = await call("second");

    expect(backend.binds).toHaveLength(1);
    expect(second).toMatchObject({ kind: "value", cached: true });
    vi.useRealTimers();
  });

  it("fails on backend loss without switching backend mid-call", async () => {
    const session = new FakeSession();
    session.failDom = new Error("extension disconnected");
    const extension = new FakeBackend("extension", true, session);
    const cdp = new FakeBackend("cdp");
    const result = await request(createBrokerOrchestrator([extension, cdp]), {
      type: "call",
      id: "loss",
      spec: domSpec(),
      params: {},
      timeoutMs: 1000,
    });

    expect(result).toEqual({ kind: "error", message: "extension disconnected" });
    expect(extension.finishes).toEqual(["close-if-created"]);
    expect(cdp.binds).toHaveLength(0);
  });

  it("uses an available fallback without waiting for a preferred backend", async () => {
    vi.useFakeTimers();
    const extension = new FakeBackend("extension", false);
    const cdp = new FakeBackend("cdp", true);
    const result = request(
      createBrokerOrchestrator([extension, cdp], {
        preferredWaitMs: 2000,
      }),
      {
        type: "call",
        id: "fallback",
        spec: domSpec(),
        params: {},
        timeoutMs: 1000,
      }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.binds).toHaveLength(1);
    await expect(result).resolves.toMatchObject({ kind: "value" });
    vi.useRealTimers();
  });
});

describe("perform consent and execution", () => {
  const performSpec = (overrides: Partial<LensSpec> = {}): LensSpec =>
    domSpec({
      name: "@example/send",
      effects: { reads: ["example.com"], writes: ["example.com"] },
      perform: [{ click: "#send" }],
      ...overrides,
    });

  it("denies a perform spec without allowWrites, before any page bind", async () => {
    const backend = new FakeBackend("cdp");
    const result = await request(createBrokerOrchestrator([backend]), {
      type: "call",
      id: "denied",
      spec: performSpec(),
      params: {},
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "writes_not_allowed",
    });
    expect((result as { message: string }).message).toContain("@example/send");
    expect((result as { message: string }).message).toContain("allowWrites");
    expect(backend.binds).toHaveLength(0);
    expect(backend.finishes).toHaveLength(0);
    expect(backend.session.performCalls).toHaveLength(0);
  });

  it("runs perform with allowWrites, binding with reuse navigation", async () => {
    const backend = new FakeBackend("cdp");
    const result = await request(createBrokerOrchestrator([backend]), {
      type: "call",
      id: "allowed",
      spec: performSpec({
        // An intercept tier alone would force a fresh bind; perform must win,
        // so a send never reloads the page out from under itself.
        resolve: [
          { kind: "intercept", request: "GET https://example.com/api/*", waitMs: 0 },
          { kind: "dom", fields: { title: { selector: "h1" } } },
        ],
      }),
      params: {},
      timeoutMs: 1000,
      allowWrites: true,
    });

    expect(result).toMatchObject({ kind: "value", performed: true });
    expect(backend.binds).toHaveLength(1);
    expect(backend.binds[0]).toMatchObject({ navigation: "reuse" });
    expect(backend.session.performCalls).toEqual([[{ click: "#send" }]]);
  });

  it("bypasses the result cache for perform specs, whatever effects.cache claims", async () => {
    const backend = new FakeBackend("cdp");
    const orchestrator = createBrokerOrchestrator([backend]);
    const spec = performSpec({
      effects: { reads: ["example.com"], writes: ["example.com"], cache: 60 },
    });
    const call = (id: string) =>
      request(orchestrator, {
        type: "call",
        id,
        spec,
        params: {},
        timeoutMs: 1000,
        allowWrites: true,
      });

    await call("first");
    const second = await call("second");

    expect(backend.binds).toHaveLength(2);
    expect(backend.session.performCalls).toHaveLength(2);
    expect(second).not.toHaveProperty("cached");
  });

  it("aborts the call on a failed step without running any tier", async () => {
    const backend = new FakeBackend("cdp");
    backend.session.performResult = {
      failedStep: 0,
      message: 'click "#send" matched nothing',
      url: "https://example.com",
      title: "Example",
    };
    const result = await request(createBrokerOrchestrator([backend]), {
      type: "call",
      id: "failed",
      spec: performSpec(),
      params: {},
      timeoutMs: 1000,
      allowWrites: true,
    });

    expect(result).toMatchObject({
      kind: "error",
      code: "perform_failed",
      step: 0,
      message: 'click "#send" matched nothing',
    });
    expect(result).not.toHaveProperty("performed");
  });
});

describe("session cursor adapter", () => {
  it("accumulates capture deltas", async () => {
    const session = new FakeSession();
    session.reads.push(
      { captures: [capture("one")], nextCursor: 1, truncated: false },
      { captures: [capture("two")], nextCursor: 2, truncated: false }
    );
    const io = createSessionEngineIO(async () => session, 1000);

    expect((await io.getIntercepted()).map((item) => item.url)).toEqual([
      "https://example.com/one",
    ]);
    expect((await io.getIntercepted()).map((item) => item.url)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ]);
  });

  it("recovers from a truncated cursor by discarding stale accumulation", async () => {
    const session = new FakeSession();
    session.reads.push(
      { captures: [capture("stale")], nextCursor: 1, truncated: false },
      { captures: [capture("fresh")], nextCursor: 9, truncated: true }
    );
    const io = createSessionEngineIO(async () => session, 1000);

    await io.getIntercepted();
    expect((await io.getIntercepted()).map((item) => item.url)).toEqual([
      "https://example.com/fresh",
    ]);
  });

  it("turns engine sleeps into long-poll deadlines", async () => {
    const session = new FakeSession();
    const io = createSessionEngineIO(async () => session, 1000);
    const before = Date.now();

    await io.sleep(250);
    await io.getIntercepted();

    expect(session.deadlines[0]).toBeGreaterThanOrEqual(before + 240);
    expect(session.deadlines[0]).toBeLessThanOrEqual(Date.now() + 260);
  });
});

describe("http tiers", () => {
  const apiBody = JSON.stringify({ things: [{ name: "a" }] });

  function httpSpec(overrides: Partial<LensSpec> = {}): LensSpec {
    return domSpec({
      resolve: [
        { kind: "http", request: "GET https://api.example.com/things", items: "things" },
      ],
      ...overrides,
    });
  }

  it("serves a credential-free http call without binding a page", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(apiBody, { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const backend = new FakeBackend("cdp");
      const orchestrator = createBrokerOrchestrator([backend]);
      const result = await request(orchestrator, {
        type: "call",
        id: "one",
        spec: httpSpec(),
        params: {},
        timeoutMs: 1000,
      });

      expect(result).toMatchObject({
        kind: "value",
        resolver: "http",
        value: [{ name: "a" }],
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(backend.binds).toHaveLength(0);
      expect(backend.finishes).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("routes a credentialed http tier through the backend's httpFetch", async () => {
    const backend = new FakeBackend("extension");
    const seen: string[] = [];
    backend.httpFetch = async (req) => {
      seen.push(`${req.method} ${req.url}`);
      // The engine's credentials flag must not leak into the backend request:
      // the extension's strict protocol schema rejects unknown keys.
      expect(req).not.toHaveProperty("credentials");
      return {
        url: req.url,
        method: req.method,
        status: 200,
        body: apiBody,
        timestamp: Date.now(),
      };
    };
    const orchestrator = createBrokerOrchestrator([backend]);
    const result = await request(orchestrator, {
      type: "call",
      id: "one",
      spec: httpSpec({
        resolve: [
          {
            kind: "http",
            request: "GET https://api.example.com/things",
            credentials: true,
            items: "things",
          },
        ],
      }),
      params: {},
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ kind: "value", resolver: "http" });
    expect(seen).toEqual(["GET https://api.example.com/things"]);
    expect(backend.binds).toHaveLength(0);
  });

  it("falls through to the page tiers when the backend cannot fetch with cookies", async () => {
    const backend = new FakeBackend("cdp");
    const orchestrator = createBrokerOrchestrator([backend]);
    const result = await request(orchestrator, {
      type: "call",
      id: "one",
      spec: httpSpec({
        resolve: [
          {
            kind: "http",
            request: "GET https://api.example.com/things",
            credentials: true,
            items: "things",
          },
          { kind: "dom", fields: { title: { selector: "h1" } } },
        ],
      }),
      params: {},
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({ kind: "value", resolver: "dom" });
    expect(backend.binds).toHaveLength(1);
    expect(backend.finishes).toEqual(["close-if-created"]);
  });
});
