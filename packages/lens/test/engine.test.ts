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
