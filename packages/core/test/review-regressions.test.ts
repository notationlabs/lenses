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
