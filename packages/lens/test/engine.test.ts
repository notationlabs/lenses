import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import { validateSpec } from "../src/validate.js";
import type { DomResolver, EngineIO, InterceptedResponse } from "../src/types.js";

function io(overrides: Partial<EngineIO> = {}): EngineIO {
  return {
    getIntercepted: async () => [],
    domExtract: async () => ({ url: "https://example.com", title: "t", value: null }),
    snapshot: async () => ({ url: "https://example.com", title: "t", text: "" }),
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

const spec = validateSpec({
  name: "@example/web/things",
  url: "https://example.com/things",
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
  it("reports resolver progress when the host supplies a logger", async () => {
    const messages: string[] = [];
    await executeLens(spec, {}, io({
      getIntercepted: async () => [captured({})],
      log: (message) => messages.push(message),
    }));

    expect(messages).toEqual([
      "trying intercept resolver",
      "intercept resolver contributed a value",
      "return contract satisfied",
    ]);
  });

  it("rejects unknown parameters", async () => {
    const r = await executeLens(spec, { page: "other" }, io());
    expect(r).toEqual({
      kind: "error",
      message: 'unknown parameter "page" for @example/web/things',
    });
  });

  it("rejects a value outside a parameter's enum", async () => {
    const enumSpec = validateSpec({
      ...spec,
      params: { order: { type: "string", enum: ["byPopularity", "byDate"] } },
    });
    const r = await executeLens(enumSpec, { order: "byMagic" }, io());
    expect(r).toEqual({
      kind: "error",
      message:
        'parameter "order" for @example/web/things must be one of: byPopularity, byDate',
    });
  });

  it("serves from the intercept tier when a capture matches", async () => {
    const r = await executeLens(spec, {}, io({
      getIntercepted: async () => [captured({})],
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "intercept",
      observed: "https://api.example.com/things",
      value: [
        { title: "a", count: 1 },
        { title: "b", count: 2 },
      ],
    });
  });

  it("returns a detected outcome instead of a value", async () => {
    const r = await executeLens(spec, {}, io({
      getIntercepted: async () => [captured({ status: 401, body: "{}" })],
    }));
    expect(r.kind).toBe("outcome");
    if (r.kind === "outcome") expect(r.name).toBe("needs_auth");
  });

  it("falls through to the DOM tier on intercept miss", async () => {
    const r = await executeLens(spec, {}, io({
      domExtract: async () => ({
        url: "https://example.com/home",
        title: "t",
        value: [{ title: "from-dom" }],
      }),
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "dom" });
  });

  it("falls through to the LLM tier when DOM is empty", async () => {
    const r = await executeLens(spec, {}, io({
      snapshot: async () => ({ url: "https://example.com/home", title: "Things", text: "thing a" }),
    }));
    expect(r).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: { prompt: "Extract the things.", text: "thing a" },
    });
  });

  // A signed-out redirect misses every selector. Without the landed URL the
  // error is indistinguishable from a typo in the selector.
  it("names the landed URL when a DOM tier misses", async () => {
    const domOnly = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "dom", item: ".thing", fields: { title: { selector: ".t" } } }],
    });
    const r = await executeLens(domOnly, {}, io({
      domExtract: async () => ({ url: "https://example.com/sign-in", title: "Sign in", value: null }),
    }));
    expect(r).toEqual({
      kind: "error",
      message: "all resolvers exhausted (dom resolver missed at https://example.com/sign-in)",
    });
  });

  it("names the unmatched request when an intercept tier captures nothing", async () => {
    const interceptOnly = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "intercept", request: "GET https://api.example.com/things*", items: "things" }],
    });
    const r = await executeLens(interceptOnly, {}, io());
    expect(r).toMatchObject({
      kind: "error",
      message:
        "all resolvers exhausted (intercept resolver missed at no response matched GET https://api.example.com/things*)",
    });
  });

  it("names the status when an intercept tier captures a non-2xx response", async () => {
    const interceptOnly = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "intercept", request: "GET https://api.example.com/things*", items: "things" }],
    });
    const r = await executeLens(interceptOnly, {}, io({
      getIntercepted: async () => [captured({ status: 401, body: "{}" })],
    }));
    expect(r).toMatchObject({
      kind: "error",
      message:
        "all resolvers exhausted (intercept resolver missed at HTTP 401 from https://api.example.com/things)",
    });
  });

  // Detection was per-resolver, so an expired-session check had to be pasted
  // into every tier. A spec-level detect is evaluated against each tier's own
  // context instead.
  describe("spec-level detect", () => {
    const shared = {
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      outcomes: { needs_auth: { hint: "Sign in and retry." } },
      detect: { needs_auth: "$contains(url, '/sign-in') or status = 401" },
    };

    it("fires from a dom tier's {url, title} context", async () => {
      const s = validateSpec({
        ...shared,
        resolve: [{ kind: "dom", item: ".thing", fields: { title: { selector: ".t" } } }],
      });
      const r = await executeLens(s, {}, io({
        domExtract: async () => ({ url: "https://example.com/sign-in", title: "Sign in", value: null }),
      }));
      expect(r).toMatchObject({ kind: "outcome", name: "needs_auth", resolver: "dom" });
    });

    it("fires from an intercept tier's {status, url, body} context", async () => {
      const s = validateSpec({
        ...shared,
        resolve: [{ kind: "intercept", request: "GET https://api.example.com/things*", items: "things" }],
      });
      const r = await executeLens(s, {}, io({
        getIntercepted: async () => [captured({ status: 401, body: "{}" })],
      }));
      expect(r).toMatchObject({ kind: "outcome", name: "needs_auth", resolver: "intercept" });
    });

    it("lets a resolver's own detect override the spec's for the same outcome", async () => {
      const s = validateSpec({
        ...shared,
        resolve: [
          {
            kind: "dom",
            // narrower than the spec's: this page's sign-in lives elsewhere
            detect: { needs_auth: "$contains(url, '/login')" },
            item: ".thing",
            fields: { title: { selector: ".t" } },
          },
        ],
      });
      const r = await executeLens(s, {}, io({
        domExtract: async () => ({ url: "https://example.com/sign-in", title: "Sign in", value: null }),
      }));
      expect(r).toMatchObject({ kind: "error" });
    });
  });

  // Templating stopped at spec.url, so a lens wanting "#past-payments-{year}"
  // had to read every panel and recover the year from row text.
  describe("param-templated selectors", () => {
    const yearly = validateSpec({
      name: "@example/web/payments",
      url: "https://example.com/payments",
      params: { year: "integer" },
      effects: { reads: ["example.com"], writes: [] },
      resolve: [
        {
          kind: "dom",
          item: "#past-payments-{year} .row",
          fields: { amount: { selector: ".amount-{year}" } },
        },
      ],
    });

    it("substitutes params into item and field selectors", async () => {
      const seen: DomResolver[] = [];
      await executeLens(yearly, { year: 2024 }, io({
        domExtract: async (r) => {
          seen.push(r);
          return { url: "u", title: "t", value: [{ amount: "1" }] };
        },
      }));
      expect(seen[0].item).toBe("#past-payments-2024 .row");
      expect(seen[0].fields?.amount.selector).toBe(".amount-2024");
    });

    // Percent-encoding is a URL's escape and would corrupt a selector.
    it("substitutes verbatim rather than percent-encoding", async () => {
      const spaced = validateSpec({
        name: "@example/web/payments",
        url: "https://example.com/payments",
        params: { label: "string" },
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { v: { selector: "[aria-label='{label}']" } } }],
      });
      const seen: DomResolver[] = [];
      await executeLens(spaced, { label: "Tax year" }, io({
        domExtract: async (r) => {
          seen.push(r);
          return { url: "u", title: "t", value: { v: "1" } };
        },
      }));
      expect(seen[0].fields?.v.selector).toBe("[aria-label='Tax year']");
    });

    it("rejects a selector hole that names no declared param", () => {
      expect(() =>
        validateSpec({
          name: "@example/web/payments",
          url: "https://example.com/payments",
          effects: { reads: ["example.com"], writes: [] },
          resolve: [{ kind: "dom", fields: { v: { selector: "#row-{year}" } } }],
        })
      ).toThrow(/selector parameter "year" is not declared/);
    });
  });

  it("binds declared parameters in JSONata", async () => {
    const s = validateSpec({
      name: "@example/web/echo",
      url: "https://example.com/{page}",
      params: { page: "string" },
      effects: { reads: [], writes: [] },
      resolve: [
        {
          kind: "intercept",
          request: "GET https://api.example.com/things*",
          map: "{ 'page': $page }",
        },
      ],
    });
    const r = await executeLens(s, { page: "hello" }, io({
      getIntercepted: async () => [captured({ body: "{}" })],
    }));
    expect(r).toMatchObject({ kind: "value", value: { page: "hello" } });
  });

  it("reloads on miss and picks up a late capture", async () => {
    let reloaded = false;
    const buffer: InterceptedResponse[] = [];
    const r = await executeLens(spec, {}, io({
      getIntercepted: async () => buffer,
      reload: async () => {
        reloaded = true;
        buffer.push(captured({}));
      },
    }));
    // reloadOnMiss not set on this resolver, so it should fall through instead
    expect(reloaded).toBe(false);

    const s2 = { ...spec, resolve: [{ ...spec.resolve[0], reloadOnMiss: true, waitMs: 500 } as never] };
    const r2 = await executeLens(s2, {}, io({
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

describe("results are lenses too", () => {
  it("materialises a declared $lens outcome", async () => {
    const s = validateSpec({
      name: "@example/claude/usage",
      url: "https://claude.ai/settings/usage",
      effects: { reads: [], writes: [] },
      outcomes: {
        needs_auth: { $lens: "@example/claude/login", hint: "Sign in, then retry." },
      },
      resolve: [
        {
          kind: "intercept",
          request: "GET https://claude.ai/api/*/usage*",
          detect: { needs_auth: "status = 401 or status = 403" },
        },
      ],
    });
    const r = await executeLens(s, {}, io({
      getIntercepted: async () => [captured({ url: "https://claude.ai/api/x/usage", status: 401, body: "{}" })],
    }));
    expect(r).toEqual({
      kind: "outcome",
      name: "needs_auth",
      resolver: "intercept",
      value: {
        $lens: "@example/claude/login",
        hint: "Sign in, then retry.",
      },
    });
  });

  it("keeps the raw detect ctx when the outcome is declared null", async () => {
    const s = validateSpec({
      name: "@example/web/maybe",
      url: "https://example.com/maybe",
      effects: { reads: [], writes: [] },
      outcomes: { not_found: null },
      resolve: [
        {
          kind: "intercept",
          request: "GET https://api.example.com/things*",
          detect: { not_found: "status = 404" },
        },
      ],
    });
    const r = await executeLens(s, {}, io({
      getIntercepted: async () => [captured({ status: 404, body: "{}" })],
    }));
    expect(r.kind).toBe("outcome");
    if (r.kind === "outcome") {
      expect(r.name).toBe("not_found");
      expect(r.value).toMatchObject({ status: 404, url: expect.any(String) });
    }
  });

  it("binds $lens result fields on every row of an array return", async () => {
    const s = validateSpec({
      name: "@example/hn/top",
      url: "https://news.ycombinator.com/news",
      effects: { reads: [], writes: [] },
      returns: {
        type: "object",
        fields: {
          stories: {
            type: "array",
            items: {
              id: "string",
              item_url: { $lens: "@example/hn/item", params: { id: "id" } },
            },
          },
          next_page: { $lens: "@example/hn/top", params: { p: "next_page" } },
        },
      },
      resolve: [
        {
          kind: "dom",
          item: ".athing",
          fields: { id: { selector: ":self", attr: "id" } },
          post: "{ 'stories': $map($, function($v) { $merge([$v, {'item_url': $v.id}]) }), 'next_page': 2 }",
        },
      ],
    });
    const r = await executeLens(s, {}, io({
      domExtract: async () => ({ url: "u", title: "t", value: [{ id: "1" }, { id: "2" }] }),
    }));
    expect(r.kind).toBe("value");
    if (r.kind === "value") {
      const v = r.value as { stories: Array<{ item_url: unknown }>; next_page: unknown };
      expect(v.stories[0].item_url).toEqual({ $lens: "@example/hn/item", params: { id: "1" } });
      expect(v.stories[1].item_url).toEqual({ $lens: "@example/hn/item", params: { id: "2" } });
      expect(v.next_page).toEqual({ $lens: "@example/hn/top", params: { p: 2 } });
    }
  });
});

describe("intercept sources composition", () => {
  const composed = validateSpec({
    name: "@example/web/usage",
    url: "https://example.com/usage",
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
    body: JSON.stringify({ plan_label: "Max (20x)", quota: 200 }),
    timestamp: Date.now(),
    ...over,
  });

  it("composes two responses via $-bound source names and an object map", async () => {
    const r = await executeLens(composed, {}, io({
      getIntercepted: async () => [usageResp(), subResp()],
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "intercept",
      observed: "https://api.example.com/usage, https://api.example.com/subscription_details",
      value: {
        plan: "Max (20x)",
        limits: [
          { name: "session", percent: "1%" },
          { name: "weekly", percent: "65%" },
        ],
      },
    });
  });

  it("joins across bodies in a single expression", async () => {
    const joined = validateSpec({
      ...composed,
      resolve: [
        {
          kind: "intercept",
          sources: {
            usage: { request: "GET https://api.example.com/usage*", items: "limits[kind='weekly']" },
            sub: { request: "GET https://api.example.com/subscription*" },
          },
          map: { weekly_used: "$usage.percent * $sub.quota / 100" },
        },
      ],
    });
    const r = await executeLens(joined, {}, io({
      getIntercepted: async () => [usageResp(), subResp()],
    }));
    expect(r).toMatchObject({ kind: "value", value: { weekly_used: 130 } });
  });

  it("falls through to llm when one source is missing", async () => {
    const r = await executeLens(composed, {}, io({
      getIntercepted: async () => [usageResp()], // no subscription response
    }));
    expect(r).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: { prompt: "Read the whole page." },
    });
  });

  it("detects an outcome across source metas", async () => {
    const r = await executeLens(composed, {}, io({
      getIntercepted: async () => [usageResp({ status: 401, body: "{}" }), subResp()],
    }));
    expect(r.kind).toBe("outcome");
    if (r.kind === "outcome") expect(r.name).toBe("needs_auth");
  });
});

describe("cross-tier reconciliation", () => {
  // intercept supplies {limits, renews_at} but omits plan; a cheap dom tier fills plan.
  const reconciled = validateSpec({
    name: "@example/web/reconcile",
    url: "https://example.com/reconcile",
    effects: { reads: [], writes: [] },
    returns: { type: "object", fields: { plan: "string", renews_at: "string", limits: { type: "array" } } },
    resolve: [
      {
        kind: "intercept",
        request: "GET https://api.example.com/usage*",
        map: { renews_at: "'2026-08-06'", limits: "limits" },
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
    const r = await executeLens(reconciled, {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: { plan: "Max (20x)" } }),
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "reconciled",
      // the last contributing tier, i.e. the dom one that supplied `plan`
      observed: "u",
      value: { renews_at: "2026-08-06", limits: [{ kind: "session" }], plan: "Max (20x)" },
    });
  });

  it("does not clobber a field an earlier tier already supplied", async () => {
    const r = await executeLens(reconciled, {}, io({
      getIntercepted: async () => [usage()],
      // dom returns a stale/empty limits too — must not overwrite intercept's
      domExtract: async () => ({ url: "u", title: "t", value: { plan: "Pro", limits: [] } }),
    }));
    expect(r).toMatchObject({ kind: "value", value: { limits: [{ kind: "session" }], plan: "Pro" } });
  });

  it("hands agent_extract the fields gathered so far when dom also misses", async () => {
    const r = await executeLens(reconciled, {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: null }),
    }));
    // intercept's limits/renews_at ride along; the agent only extracts plan
    expect(r).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: {
        prompt: "Read the whole page.",
        gathered: { renews_at: "2026-08-06", limits: [{ kind: "session" }] },
      },
    });
  });

  it("flags an incomplete reconciliation as partial (so the host won't cache it)", async () => {
    // no llm tier: intercept omits plan, dom misses → plan absent.
    const noLlm = { ...reconciled, resolve: reconciled.resolve.slice(0, 2) };
    const r = await executeLens(noLlm, {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: null }),
    }));
    expect(r).toMatchObject({ kind: "value", partial: true });
    if (r.kind === "value") expect(r.value).not.toHaveProperty("plan");
  });

  it("does not flag a complete reconciliation as partial", async () => {
    const r = await executeLens(reconciled, {}, io({
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
    await executeLens(spec, {}, io({
      domExtract: async (r) => {
        received = r;
        return { url: "u", title: "t", value: [{ title: "x" }] };
      },
    }));
    expect(received?.item).toBe(".thing");
    expect(received?.fields?.title.selector).toBe(".t");
  });
});

describe("llm tier", () => {
  it("hands an incomplete array result to the agent instead of reporting success", async () => {
    const arraySpec = validateSpec({
      name: "@example/web/list",
      url: "https://example.com/list",
      returns: { type: "array", items: { title: "string", reason: "string" } },
      effects: { reads: [], writes: [] },
      resolve: [
        { kind: "dom", item: ".item", fields: { title: { selector: ".title" } } },
        { kind: "llm", prompt: "Complete the list." },
      ],
    });
    const r = await executeLens(arraySpec, {}, io({
      domExtract: async () => ({ url: "u", title: "t", value: [{ title: "One" }] }),
    }));
    expect(r).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      value: { gathered: [{ title: "One" }] },
    });
  });

  it("returns an agent_extract outcome carrying the prompt and snapshot", async () => {
    const r = await executeLens(spec, {}, io({
      snapshot: async () => ({ url: "https://example.com/home", title: "Things", text: "thing a\nthing b" }),
    }));
    expect(r).toEqual({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: {
        prompt: "Extract the things.",
        url: "https://example.com/home",
        title: "Things",
        text: "thing a\nthing b",
      },
    });
  });

  it("propagates snapshot failures", async () => {
    const execution = executeLens(spec, {}, io({
      snapshot: async () => {
        throw new Error("tab closed");
      },
    }));
    await expect(execution).rejects.toThrow("tab closed");
  });
});

describe("shared JSONata helpers", () => {
  const withHelpers = (helpers: Record<string, string>, post: string, params?: unknown) =>
    validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      ...(params ? { params } : {}),
      effects: { reads: ["example.com"], writes: [] },
      helpers,
      resolve: [{ kind: "dom", fields: { raw: { selector: ".raw" } }, post }],
    });

  const domValue = (value: unknown) =>
    io({ domExtract: async () => ({ url: "u", title: "t", value }) });

  it("binds a helper lambda as $name in an expression", async () => {
    const spec = withHelpers(
      { money: 'function($s) { $number($replace($s, /[^0-9.]/, "")) }' },
      "{ 'amount': $money(raw) }"
    );
    const r = await executeLens(spec, {}, domValue({ raw: "£1,234.50" }));
    expect(r).toMatchObject({ kind: "value", value: { amount: 1234.5 } });
  });

  // A catalogue must not be able to change what an expression means by adding a
  // helper whose name a document already declares as a param.
  it("lets a declared param shadow a helper of the same name", async () => {
    const spec = withHelpers(
      { limit: "function() { 99 }" },
      "{ 'v': $limit }",
      { limit: { type: "integer", default: 5 } }
    );
    const r = await executeLens(spec, {}, domValue({ raw: "x" }));
    expect(r).toMatchObject({ kind: "value", value: { v: 5 } });
  });

  it("makes helpers available to detect as well as post", async () => {
    const spec = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      outcomes: { needs_auth: { hint: "Sign in." } },
      helpers: { isLogin: "function($u) { $contains($u, '/sign-in') }" },
      detect: { needs_auth: "$isLogin(url)" },
      resolve: [{ kind: "dom", fields: { raw: { selector: ".raw" } } }],
    });
    const r = await executeLens(spec, {}, io({
      domExtract: async () => ({ url: "https://example.com/sign-in", title: "t", value: null }),
    }));
    expect(r).toMatchObject({ kind: "outcome", name: "needs_auth" });
  });
});

describe("http tier", () => {
  const body = JSON.stringify({ things: [{ name: "a" }, { name: "b" }] });
  const httpSpec = validateSpec({
    name: "@example/api/things",
    url: "https://example.com/things/{id}",
    params: { id: "string" },
    effects: { reads: ["example.com"], writes: [] },
    resolve: [
      {
        kind: "http",
        request: "GET https://api.example.com/things/{id}",
        items: "things",
        map: "{ 'title': name }",
        detect: { needs_auth: "status = 401" },
      },
    ],
  });

  it("serves from httpFetch without touching the page", async () => {
    const requests: unknown[] = [];
    const r = await executeLens(httpSpec, { id: "42" }, io({
      httpFetch: async (request) => {
        requests.push(request);
        return { url: request.url, method: request.method, status: 200, body, timestamp: Date.now() };
      },
      domExtract: async () => {
        throw new Error("http tier must not bind a page");
      },
    }));
    expect(requests).toEqual([
      { method: "GET", url: "https://api.example.com/things/42", headers: undefined, credentials: false },
    ]);
    expect(r).toEqual({
      kind: "value",
      resolver: "http",
      observed: "https://api.example.com/things/42",
      value: [{ title: "a" }, { title: "b" }],
    });
  });

  it("defaults to a GET of the lens's canonical url", async () => {
    const urls: string[] = [];
    const bare = validateSpec({ ...httpSpec, resolve: [{ kind: "http", items: "things" }] });
    await executeLens(bare, { id: "42" }, io({
      httpFetch: async (request) => {
        urls.push(`${request.method} ${request.url}`);
        return { url: request.url, method: request.method, status: 200, body, timestamp: Date.now() };
      },
    }));
    expect(urls).toEqual(["GET https://example.com/things/42"]);
  });

  it("misses when the host cannot make http requests", async () => {
    const r = await executeLens(httpSpec, { id: "42" }, io());
    expect(r).toEqual({
      kind: "error",
      message: "all resolvers exhausted (http resolver missed at host cannot perform http requests)",
    });
  });

  it("misses when a credentialed request is unsupported", async () => {
    const credentialed = validateSpec({
      ...httpSpec,
      resolve: [{ kind: "http", credentials: true, items: "things" }],
    });
    const r = await executeLens(credentialed, { id: "42" }, io({
      httpFetch: async () => undefined,
    }));
    expect(r).toEqual({
      kind: "error",
      message:
        "all resolvers exhausted (http resolver missed at host cannot perform credentialed http requests)",
    });
  });

  it("misses on a non-2xx response and names the status", async () => {
    const r = await executeLens(httpSpec, { id: "42" }, io({
      httpFetch: async (request) => ({
        url: request.url, method: request.method, status: 503, body: "down", timestamp: Date.now(),
      }),
    }));
    expect(r).toEqual({
      kind: "error",
      message:
        "all resolvers exhausted (http resolver missed at HTTP 503 from https://api.example.com/things/42)",
    });
  });

  it("turns a network failure into a miss rather than an error", async () => {
    const r = await executeLens(httpSpec, { id: "42" }, io({
      httpFetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.example.com");
      },
    }));
    expect(r).toEqual({
      kind: "error",
      message:
        "all resolvers exhausted (http resolver missed at http request failed: getaddrinfo ENOTFOUND api.example.com)",
    });
  });

  it("returns a detected outcome before the status check", async () => {
    const r = await executeLens(httpSpec, { id: "42" }, io({
      httpFetch: async (request) => ({
        url: request.url, method: request.method, status: 401, body: "{}", timestamp: Date.now(),
      }),
    }));
    expect(r).toMatchObject({ kind: "outcome", name: "needs_auth", resolver: "http" });
  });

  it("falls through to the page tiers on a miss", async () => {
    const layered = validateSpec({
      ...httpSpec,
      resolve: [
        { kind: "http", items: "things" },
        { kind: "dom", item: ".thing", fields: { title: { selector: ".t" } } },
      ],
    });
    const r = await executeLens(layered, { id: "42" }, io({
      domExtract: async () => ({
        url: "https://example.com/things/42",
        title: "t",
        value: [{ title: "from-dom" }],
      }),
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "dom" });
  });
});

describe("http tier chained sources", () => {
  const chained = validateSpec({
    name: "@example/api/usage",
    url: "https://example.com/usage",
    effects: { reads: ["example.com"], writes: [] },
    resolve: [
      {
        kind: "http",
        credentials: true,
        sources: {
          orgs: { request: "GET https://api.example.com/organizations" },
          usage: { request: "GET https://api.example.com/organizations/{orgs.0.uuid}/usage" },
        },
        detect: { needs_auth: "$orgs.status = 401" },
        map: { plan: "$orgs[0].plan", used: "$usage.used" },
      },
    ],
  });

  function respond(byUrl: Record<string, { status: number; body: unknown }>) {
    return async (request: { url: string; method: string }) => {
      const match = byUrl[request.url];
      if (!match) throw new Error(`unexpected request ${request.url}`);
      return {
        url: request.url,
        method: request.method,
        status: match.status,
        body: JSON.stringify(match.body),
        timestamp: Date.now(),
      };
    };
  }

  it("threads an earlier body into a later request through a dotted hole", async () => {
    const r = await executeLens(chained, {}, io({
      httpFetch: respond({
        "https://api.example.com/organizations": {
          status: 200,
          body: [{ uuid: "org-1", plan: "max" }],
        },
        "https://api.example.com/organizations/org-1/usage": {
          status: 200,
          body: { used: 42 },
        },
      }),
    }));
    expect(r).toEqual({
      kind: "value",
      resolver: "http",
      observed:
        "https://api.example.com/organizations, https://api.example.com/organizations/org-1/usage",
      value: { plan: "max", used: 42 },
    });
  });

  it("stops the chain on a detected outcome from the first source", async () => {
    const requested: string[] = [];
    const r = await executeLens(chained, {}, io({
      httpFetch: async (request) => {
        requested.push(request.url);
        return { url: request.url, method: request.method, status: 401, body: "{}", timestamp: Date.now() };
      },
    }));
    expect(r).toMatchObject({ kind: "outcome", name: "needs_auth", resolver: "http" });
    expect(requested).toEqual(["https://api.example.com/organizations"]);
  });

  it("misses when a dotted hole cannot resolve to a scalar", async () => {
    const r = await executeLens(chained, {}, io({
      httpFetch: respond({
        "https://api.example.com/organizations": { status: 200, body: [] },
      }),
    }));
    expect(r).toMatchObject({
      kind: "error",
      message:
        'all resolvers exhausted (http resolver missed at http request failed: hole "{orgs.0.uuid}" did not resolve to a scalar)',
    });
  });

  it("rejects a source request naming an undeclared hole", () => {
    expect(() =>
      validateSpec({
        name: "@example/api/usage",
        url: "https://example.com/usage",
        effects: { reads: ["example.com"], writes: [] },
        resolve: [
          {
            kind: "http",
            sources: {
              usage: { request: "GET https://api.example.com/{orgs.0.uuid}/usage" },
            },
          },
        ],
      })
    ).toThrow('http parameter "orgs" is not declared');
  });
});
