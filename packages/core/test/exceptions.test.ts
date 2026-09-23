import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/validate.js";
import { executeLens } from "../src/engine.js";
import type { EngineIO } from "../src/types.js";

const raw = {
  name: "@test/site/read",
  url: "https://a.example/items",
  effects: { reads: ["items"], writes: [] },
  exceptions: { needs_auth: { matches: "status = 401 or $contains(url, '/login')", hint: "Sign in" } },
  resolve: [{ kind: "http", sources: {
    first: { request: "GET https://a.example/first" },
    second: { request: "GET https://a.example/second" },
  } }],
};

function io(fetch: NonNullable<EngineIO["httpFetch"]>): EngineIO {
  return { httpFetch: fetch, getIntercepted: async () => [], domExtract: async () => ({ url: "", title: "", value: null }), snapshot: async () => ({ url: "", title: "", text: "" }), sleep: async () => {} };
}

describe("exceptions", () => {
  it("checks each named response before the next request", async () => {
    const calls: string[] = [];
    const result = await executeLens(validateSpec(raw), {}, io(async (request) => {
      calls.push(request.url);
      return { url: request.url, method: "GET", status: 401, body: "{}", timestamp: 0 };
    }));
    expect(result).toMatchObject({ kind: "outcome", name: "needs_auth", hint: "Sign in" });
    expect(calls).toEqual(["https://a.example/first"]);
  });

  it("runs tier matchers before page matchers without replacing inherited ones", async () => {
    const spec = validateSpec({ ...raw, resolve: [{ ...raw.resolve[0], exceptions: {
      rejected: { matches: "$first.status = 401", hint: "Rejected" },
    } }] });
    const result = await executeLens(spec, {}, io(async (request) => ({
      url: request.url, method: "GET", status: 401, body: "{}", timestamp: 0,
    })));
    expect(result).toMatchObject({ kind: "outcome", name: "rejected", hint: "Rejected" });
  });

  it("inherits recovery advice when a tier matcher of the same name fires", async () => {
    const spec = validateSpec({ ...raw, resolve: [{ ...raw.resolve[0], exceptions: {
      needs_auth: { matches: "$first.status = 403" },
    } }] });
    const result = await executeLens(spec, {}, io(async (request) => ({
      url: request.url, method: "GET", status: 403, body: "{}", timestamp: 0,
    })));
    expect(result).toMatchObject({ kind: "outcome", name: "needs_auth", hint: "Sign in" });
  });

  it("rejects the legacy fields", () => {
    expect(() => validateSpec({ ...raw, detect: { needs_auth: "true" } })).toThrow('"detect"');
    expect(() => validateSpec({ ...raw, outcomes: { needs_auth: null } })).toThrow('"outcomes"');
  });
});
