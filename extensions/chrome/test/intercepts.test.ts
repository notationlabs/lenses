import { describe, expect, it } from "vitest";
import { decodeInterceptMessage } from "../src/background/intercepts.js";

const response = {
  url: "https://example.com/api/items",
  method: "GET",
  status: 200,
  body: '{"ok":true}',
  timestamp: 123,
};

describe("intercept relay validation", () => {
  it("accepts a bounded HTTP response carrying the active token", () => {
    expect(decodeInterceptMessage(
      { type: "intercepted", token: "active", response },
      "active"
    )).toEqual(response);
  });

  it.each([
    [{ type: "intercepted", token: "wrong", response }],
    [{ type: "intercepted", token: "active", response: { ...response, url: "javascript:alert(1)" } }],
    [{ type: "intercepted", token: "active", response: { ...response, status: 200.5 } }],
    [{ type: "intercepted", token: "active", response: { ...response, method: "get" } }],
    [{ type: "intercepted", token: "active", response: { ...response, body: "x".repeat(512 * 1024 + 1) } }],
  ])("rejects malformed or unauthenticated relay data", (message) => {
    expect(decodeInterceptMessage(message, "active")).toBeUndefined();
  });
});
