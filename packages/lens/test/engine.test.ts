import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import { defineLens } from "../src/index.js";
import type { DomResolver, EngineIO, InterceptedResponse } from "../src/types.js";

function io(overrides: Partial<EngineIO> = {}): EngineIO {
  return {
    getIntercepted: async () => [],
    domExtract: async () => ({ url: "https://example.com", title: "t", value: null }),
    snapshot: async () => ({ url: "https://example.com", title: "t", text: "" }),
    llmExtract: async () => "null",
    sleep: async () => {},
    ...overrides,
  };
}

const captured = (over: Partial<InterceptedResponse>): InterceptedResponse => ({
  url: "https://api.example.com/things",
  method: "GET",
  status: 200,
  body: JSON.stringify({ things: [{ name: "a", n: 1 }, { name: "b", n: 2 }] }),
  timestamp: Date.now(),
  ...over,
});

const spec = defineLens({
  lens: "example/things",
  version: 1,
  accepts: ["https://example.com/{page}"],
  effects: { reads: ["example.com"], writes: [] },
  resolve: [
    {
      kind: "intercept",
      request: "GET https://api.example.com/things*",
      items: "things",
      map: "{ 'title': name, 'count': n }",
      detect: { needs_auth: "status = 401" },
    },
    {
      kind: "dom",
      item: ".thing",
      fields: { title: { selector: ".t" } },
    },
    { kind: "llm", prompt: "Extract the things." },
  ],
});

describe("executeLens", () => {
  it("rejects targets outside accepts", async () => {
    const r = await executeLens(spec, "https://other.com/x", {}, io());
    expect(r.kind).toBe("error");
  });

  it("serves from the intercept tier when a capture matches", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      getIntercepted: async () => [captured({})],
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "intercept",
      value: [
        { title: "a", count: 1 },
        { title: "b", count: 2 },
      ],
    });
  });

  it("returns a detected outcome instead of a value", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      getIntercepted: async () => [captured({ status: 401, body: "{}" })],
    }));
    expect(r.kind).toBe("outcome");
    if (r.kind === "outcome") expect(r.name).toBe("needs_auth");
  });

  it("falls through to the DOM tier on intercept miss", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      domExtract: async () => ({
        url: "https://example.com/home",
        title: "t",
        value: [{ title: "from-dom" }],
      }),
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "dom" });
  });

  it("falls through to the LLM tier when DOM is empty", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      llmExtract: async () => '```json\n[{"title": "from-llm"}]\n```',
    }));
    expect(r).toMatchObject({
      kind: "value",
      resolver: "llm",
      value: [{ title: "from-llm" }],
    });
  });

  it("binds URL holes as JSONata params", async () => {
    const s = defineLens({
      lens: "example/echo",
      version: 1,
      accepts: ["https://example.com/{page}"],
      effects: { reads: [], writes: [] },
      resolve: [
        {
          kind: "intercept",
          request: "GET https://api.example.com/things*",
          map: "{ 'page': $page }",
        },
      ],
    });
    const r = await executeLens(s, "https://example.com/hello", {}, io({
      getIntercepted: async () => [captured({ body: "{}" })],
    }));
    expect(r).toMatchObject({ kind: "value", value: { page: "hello" } });
  });

  it("supports write lenses via fire", async () => {
    const s = defineLens({
      lens: "example/like",
      version: 1,
      accepts: ["https://example.com/post/{id}"],
      effects: { reads: [], writes: ["example.com/like"] },
      resolve: [
        {
          kind: "intercept",
          request: "POST https://api.example.com/like",
          fire: { request: "POST https://api.example.com/like", body: "{ 'post_id': $id }" },
          map: "{ 'liked': true }",
        },
      ],
    });
    let sent: unknown;
    const r = await executeLens(s, "https://example.com/post/42", {}, io({
      fireRequest: async (_m, _u, body) => {
        sent = body;
        return captured({ method: "POST", url: "https://api.example.com/like", body: "{}" });
      },
    }));
    expect(sent).toEqual({ post_id: "42" });
    expect(r).toMatchObject({ kind: "value", value: { liked: true } });
  });

  it("reloads on miss and picks up a late capture", async () => {
    let reloaded = false;
    const buffer: InterceptedResponse[] = [];
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      getIntercepted: async () => buffer,
      reload: async () => {
        reloaded = true;
        buffer.push(captured({}));
      },
    }));
    // reloadOnMiss not set on this resolver, so it should fall through instead
    expect(reloaded).toBe(false);

    const s2 = { ...spec, resolve: [{ ...spec.resolve[0], reloadOnMiss: true, waitMs: 500 } as never] };
    const r2 = await executeLens(s2, "https://example.com/home", {}, io({
      getIntercepted: async () => buffer,
      reload: async () => {
        reloaded = true;
        buffer.push(captured({}));
      },
    }));
    expect(reloaded).toBe(true);
    expect(r2.kind).toBe("value");
    expect(r.kind).not.toBe("value"); // first call had nothing to serve at intercept tier
  });
});

describe("intercept sources composition", () => {
  const composed = defineLens({
    lens: "example/usage",
    version: 1,
    accepts: ["https://example.com/{page}"],
    effects: { reads: ["example.com"], writes: [] },
    resolve: [
      {
        kind: "intercept",
        sources: {
          usage: { request: "GET https://api.example.com/usage*" },
          sub: { request: "GET https://api.example.com/subscription*" },
        },
        detect: { needs_auth: "$usage.status = 401 or $sub.status = 401" },
        map: {
          plan: "$sub.plan_label",
          limits: "$usage.limits.{ 'name': kind, 'percent': $string(percent) & '%' }",
        },
      },
      { kind: "llm", prompt: "Read the whole page." },
    ],
  });

  const usageResp = (over: Partial<InterceptedResponse> = {}): InterceptedResponse => ({
    url: "https://api.example.com/usage",
    method: "GET",
    status: 200,
    body: JSON.stringify({ limits: [{ kind: "session", percent: 1 }, { kind: "weekly", percent: 65 }] }),
    timestamp: Date.now(),
    ...over,
  });
  const subResp = (over: Partial<InterceptedResponse> = {}): InterceptedResponse => ({
    url: "https://api.example.com/subscription_details",
    method: "GET",
    status: 200,
    body: JSON.stringify({ plan_label: "Max (20x)" }),
    timestamp: Date.now(),
    ...over,
  });

  it("composes two responses via $-bound source names and an object map", async () => {
    const r = await executeLens(composed, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usageResp(), subResp()],
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "intercept",
      value: {
        plan: "Max (20x)",
        limits: [
          { name: "session", percent: "1%" },
          { name: "weekly", percent: "65%" },
        ],
      },
    });
  });

  it("falls through to llm when one source is missing", async () => {
    const r = await executeLens(composed, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usageResp()], // no subscription response
      llmExtract: async () => '{"plan":"from-llm","limits":[]}',
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "llm", value: { plan: "from-llm" } });
  });

  it("detects an outcome across source metas", async () => {
    const r = await executeLens(composed, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usageResp({ status: 401, body: "{}" }), subResp()],
    }));
    expect(r.kind).toBe("outcome");
    if (r.kind === "outcome") expect(r.name).toBe("needs_auth");
  });
});

describe("cross-tier reconciliation", () => {
  // intercept supplies {limits, renews_at} but omits plan; a cheap dom tier fills plan.
  const reconciled = defineLens({
    lens: "example/reconcile",
    version: 1,
    accepts: ["https://example.com/{page}"],
    effects: { reads: [], writes: [] },
    returns: { type: "object", fields: { plan: "string", renews_at: "string", limits: { type: "array" } } },
    resolve: [
      {
        kind: "intercept",
        sources: { usage: { request: "GET https://api.example.com/usage*" } },
        map: { renews_at: "'2026-08-06'", limits: "$usage.limits" },
      },
      { kind: "dom", fields: { plan: { selector: ".plan" } }, post: "{ 'plan': plan }" },
      { kind: "llm", prompt: "Read the whole page." },
    ],
  });

  const usage = (): InterceptedResponse => ({
    url: "https://api.example.com/usage",
    method: "GET",
    status: 200,
    body: JSON.stringify({ limits: [{ kind: "session" }] }),
    timestamp: Date.now(),
  });

  it("fills the missing field from dom and reports 'reconciled'", async () => {
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: { plan: "Max (20x)" } }),
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "reconciled",
      value: { renews_at: "2026-08-06", limits: [{ kind: "session" }], plan: "Max (20x)" },
    });
  });

  it("does not clobber a field an earlier tier already supplied", async () => {
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      // dom returns a stale/empty limits too — must not overwrite intercept's
      domExtract: async () => ({ url: "u", title: "t", value: { plan: "Pro", limits: [] } }),
    }));
    expect(r).toMatchObject({ kind: "value", value: { limits: [{ kind: "session" }], plan: "Pro" } });
  });

  it("falls to llm for the missing field when dom also misses", async () => {
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: null }),
      llmExtract: async () => '{"plan":"Team","renews_at":"x","limits":[]}',
    }));
    // intercept's limits/renews_at survive; llm only fills the absent plan
    expect(r).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: { plan: "Team", renews_at: "2026-08-06", limits: [{ kind: "session" }] },
    });
  });

  it("flags an incomplete reconciliation as partial (so the host won't cache it)", async () => {
    // intercept omits plan, dom misses, llm returns nothing usable → plan absent.
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: null }),
      llmExtract: async () => "null",
    }));
    expect(r).toMatchObject({ kind: "value", partial: true });
    if (r.kind === "value") expect(r.value).not.toHaveProperty("plan");
  });

  it("does not flag a complete reconciliation as partial", async () => {
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: { plan: "Max (20x)" } }),
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "reconciled" });
    if (r.kind === "value") expect(r.partial).toBeUndefined();
  });
});

describe("dom extraction spec shape", () => {
  it("passes the resolver spec through to the content-script adapter", async () => {
    let received: DomResolver | undefined;
    await executeLens(spec, "https://example.com/home", {}, io({
      domExtract: async (r) => {
        received = r;
        return { url: "u", title: "t", value: [{ title: "x" }] };
      },
    }));
    expect(received?.item).toBe(".thing");
    expect(received?.fields?.title.selector).toBe(".t");
  });
});

describe("llm tier without sampling support", () => {
  it("returns an agent_extract outcome carrying the snapshot", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      snapshot: async () => ({ url: "https://example.com/home", title: "Things", text: "thing a\nthing b" }),
      llmExtract: async () => {
        throw new Error("sampling_unsupported");
      },
    }));
    expect(r).toEqual({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: { url: "https://example.com/home", title: "Things", text: "thing a\nthing b", returns: undefined },
    });
  });

  it("still errors on other llm failures", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      llmExtract: async () => {
        throw new Error("sampling timed out");
      },
    }));
    expect(r.kind).toBe("error");
  });
});
