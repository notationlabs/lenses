import { describe, expect, it } from "vitest";
import { executeLens, resolveParams } from "../src/engine.js";
import { evaluate, evaluateBool } from "../src/expr.js";
import { checkExpression } from "../src/expr-check.js";
import {
  createCaptureBuffer,
  pushCapture,
  readCaptures,
  wakeCaptureWaiters,
} from "../src/capture-buffer.js";
import { validateSpec } from "../src/validate.js";
import type { EngineIO, InterceptedResponse } from "../src/types.js";

function io(overrides: Partial<EngineIO> = {}): EngineIO {
  return {
    getIntercepted: async () => [],
    domExtract: async () => ({ url: "https://example.com", title: "t", value: null }),
    snapshot: async () => ({ url: "https://example.com", title: "t", text: "" }),
    sleep: async () => {},
    ...overrides,
  };
}

const response = (body: unknown): InterceptedResponse => ({
  url: "https://api.example.com/things",
  method: "GET",
  status: 200,
  body: JSON.stringify(body),
  timestamp: Date.now(),
});

describe("performed flag", () => {
  it("is kept when a tier throws after the perform steps ran", async () => {
    const spec = validateSpec({
      name: "@example/chat/send",
      url: "https://example.com/chat",
      effects: { reads: ["example.com"], writes: ["example.com"] },
      perform: [{ click: "#send" }],
      resolve: [{ kind: "dom", fields: { text: { selector: ".t" } } }],
    });
    const r = await executeLens(spec, {}, io({
      perform: async () => ({}),
      domExtract: async () => {
        throw new Error("tab went away");
      },
    }));
    expect(r).toEqual({ kind: "error", message: "tab went away", performed: true });
  });
});

describe("evaluateBool", () => {
  it.each([
    [[], false],
    [{}, false],
    [[0, ""], false],
    [[[]], false],
    [[{ message: "x" }], true],
    [{ message: "x" }, true],
    ["", false],
    [0, false],
  ])("matches $boolean for %j", async (value, expected) => {
    expect(await evaluateBool("$res.body.errors", { res: { body: { errors: value } } })).toBe(expected);
    expect(await evaluate("$boolean($v)", { v: value })).toBe(expected);
  });

  it("treats a lambda as false, as $boolean does", async () => {
    expect(await evaluateBool("function($x) { $x }")).toBe(false);
  });
});

describe("cross-tier arrays", () => {
  it("never replaces an array an earlier tier set", async () => {
    const spec = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      returns: { type: "array", items: { title: "string", url: "string" } },
      resolve: [
        {
          kind: "intercept",
          request: { method: "GET", url: "https://api.example.com/things*" },
          items: "$res.body.things",
          map: { title: "$item.name" },
        },
        { kind: "dom", item: ".thing", fields: { title: { selector: ".t" }, url: { selector: "a", attr: "href" } } },
      ],
    });
    const r = await executeLens(spec, {}, io({
      getIntercepted: async () => [response({ things: [{ name: "a" }] })],
      domExtract: async () => ({ url: "u", title: "t", value: [{ title: "z", url: "/z" }] }),
    }));
    expect(r).toMatchObject({ kind: "value", resolver: "intercept", partial: true, value: [{ title: "a" }] });
  });
});

describe("intercept single request", () => {
  it("misses when the map yields nothing", async () => {
    const spec = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      resolve: [
        {
          kind: "intercept",
          request: { method: "GET", url: "https://api.example.com/things*" },
          map: "$res.body.absent",
        },
      ],
    });
    const r = await executeLens(spec, {}, io({
      getIntercepted: async () => [response({ things: [] })],
    }));
    expect(r).toEqual({
      kind: "error",
      message: "all resolvers exhausted (intercept resolver missed at no value from https://api.example.com/things)",
    });
  });
});

describe("expression built-ins", () => {
  it.each(["$base64encode($value.a)", "$base64decode($value.a)"])("accepts %s", (expr) => {
    expect(checkExpression(expr, { label: "map", vars: ["value"] })).toBeUndefined();
  });
});

describe("readCaptures", () => {
  it("returns as soon as the waiters are woken", async () => {
    const buffer = createCaptureBuffer();
    const started = Date.now();
    const read = readCaptures(buffer, 0, started + 5000);
    setTimeout(() => wakeCaptureWaiters(buffer), 10);
    const delta = await read;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(delta).toEqual({ captures: [], nextCursor: 0, truncated: false });
  });

  it("returns a capture pushed while waiting", async () => {
    const buffer = createCaptureBuffer();
    const read = readCaptures(buffer, 0, Date.now() + 5000);
    const capture = response({});
    setTimeout(() => pushCapture(buffer, capture), 10);
    expect(await read).toEqual({ captures: [capture], nextCursor: 1, truncated: false });
  });
});

describe("resolveParams", () => {
  it.each(["toString", "constructor", "hasOwnProperty"])("rejects the inherited key %s", (key) => {
    const spec = validateSpec({
      name: "@example/web/things",
      url: "https://example.com/things",
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "llm", prompt: "Read." }],
    });
    expect(() => resolveParams(spec, { [key]: "x" })).toThrow(`unknown parameter "${key}"`);
  });
});
