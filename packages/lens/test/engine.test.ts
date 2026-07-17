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
      snapshot: async () => ({ url: "https://example.com/home", title: "Things", text: "thing a" }),
    }));
    expect(r).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      resolver: "llm",
      value: { prompt: "Extract the things.", text: "thing a" },
    });
  });

  it("binds URL holes as JSONata params", async () => {
    const s = validateSpec({
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

describe("results are lenses too", () => {
  it("materialises a declared $lens outcome with its target bound", async () => {
    const s = validateSpec({
      lens: "claude/usage",
      version: 1,
      accepts: ["https://claude.ai/settings/{page}"],
      effects: { reads: [], writes: [] },
      outcomes: {
        needs_auth: { $lens: "claude/login@v1", hint: "Sign in, then retry." },
      },
      resolve: [
        {
          kind: "intercept",
          request: "GET https://claude.ai/api/*/usage*",
          detect: { needs_auth: "status = 401 or status = 403" },
        },
      ],
    });
    const r = await executeLens(s, "https://claude.ai/settings/usage", {}, io({
      getIntercepted: async () => [captured({ url: "https://claude.ai/api/x/usage", status: 401, body: "{}" })],
    }));
    expect(r).toEqual({
      kind: "outcome",
      name: "needs_auth",
      resolver: "intercept",
      value: {
        $lens: "claude/login@v1",
        target: "https://claude.ai/settings/usage",
        hint: "Sign in, then retry.",
      },
    });
  });

  it("keeps the raw detect ctx when the outcome is declared null", async () => {
    const s = validateSpec({
      lens: "example/maybe",
      version: 1,
      accepts: ["https://example.com/{page}"],
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
    const r = await executeLens(s, "https://example.com/home", {}, io({
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
      lens: "hn/top",
      version: 1,
      accepts: ["https://news.ycombinator.com/{page}"],
      effects: { reads: [], writes: [] },
      returns: {
        type: "object",
        fields: {
          stories: {
            type: "array",
            items: { id: "string", item_url: { $lens: "hn/item@v1" } },
          },
          next_page: { $lens: "hn/top@v1" },
        },
      },
      resolve: [
        {
          kind: "dom",
          item: ".athing",
          fields: { id: { selector: ":self", attr: "id" } },
          post: "{ 'stories': $map($, function($v) { $merge([$v, {'item_url': 'https://news.ycombinator.com/item?id=' & $v.id}]) }), 'next_page': 'https://news.ycombinator.com/news?p=2' }",
        },
      ],
    });
    const r = await executeLens(s, "https://news.ycombinator.com/news", {}, io({
      domExtract: async () => ({ url: "u", title: "t", value: [{ id: "1" }, { id: "2" }] }),
    }));
    expect(r.kind).toBe("value");
    if (r.kind === "value") {
      const v = r.value as { stories: Array<{ item_url: unknown }>; next_page: unknown };
      expect(v.stories[0].item_url).toEqual({ $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=1" });
      expect(v.stories[1].item_url).toEqual({ $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=2" });
      expect(v.next_page).toEqual({ $lens: "hn/top@v1", target: "https://news.ycombinator.com/news?p=2" });
    }
  });
});

describe("cross-tier reconciliation", () => {
  // intercept supplies {limits, renews_at} but omits plan; a cheap dom tier fills plan.
  const reconciled = validateSpec({
    lens: "example/reconcile",
    version: 1,
    accepts: ["https://example.com/{page}"],
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

  it("hands agent_extract the fields gathered so far when dom also misses", async () => {
    const r = await executeLens(reconciled, "https://example.com/usage", {}, io({
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
    const r = await executeLens(noLlm, "https://example.com/usage", {}, io({
      getIntercepted: async () => [usage()],
      domExtract: async () => ({ url: "u", title: "t", value: null }),
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

describe("llm tier", () => {
  it("returns an agent_extract outcome carrying the prompt and snapshot", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
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

  it("errors when the snapshot itself fails", async () => {
    const r = await executeLens(spec, "https://example.com/home", {}, io({
      snapshot: async () => {
        throw new Error("tab closed");
      },
    }));
    expect(r.kind).toBe("error");
  });
});
