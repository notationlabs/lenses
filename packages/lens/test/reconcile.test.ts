import { describe, expect, it } from "vitest";
import { fillAbsent, satisfiesReturns } from "../src/reconcile.js";

describe("resolver result reconciliation", () => {
  it("accepts null for a nullable primitive", () => {
    expect(satisfiesReturns(null, { type: "string", nullable: true })).toBe(true);
    expect(satisfiesReturns("tomorrow", { type: "string", nullable: true })).toBe(true);
  });

  it("fills nested fields without replacing earlier values", () => {
    expect(fillAbsent(
      { story: { id: "1", title: "original" } },
      { story: { title: "later", score: "42 points" } }
    )).toEqual({ story: { id: "1", title: "original", score: "42 points" } });
  });

  it("does not consider a nested object complete when declared fields are absent", () => {
    const returns = {
      type: "object",
      fields: {
        story: { type: "object", fields: { title: "string", score: "string" } },
      },
    };
    expect(satisfiesReturns({ story: { title: "hello" } }, returns)).toBe(false);
    expect(satisfiesReturns({ story: { title: "hello", score: null } }, returns)).toBe(false);
    expect(satisfiesReturns({ story: { title: "hello", score: "42 points" } }, returns)).toBe(true);
  });

  it("follows a $ref through $defs at every depth of the value", () => {
    const defs = {
      comment: {
        type: "object",
        fields: { text: "string", replies: { type: "array", items: { $ref: "comment" } } },
      },
    };
    const returns = { type: "array", items: { $ref: "comment" } };
    const nested = [{ text: "a", replies: [{ text: "b", replies: [] }] }];
    expect(satisfiesReturns(nested, returns, defs)).toBe(true);
    expect(satisfiesReturns([{ text: "a", replies: [{ replies: [] }] }], returns, defs)).toBe(false);
    // an unresolvable ref does not veto the value
    expect(satisfiesReturns(nested, { type: "array", items: { $ref: "missing" } }, defs)).toBe(true);
  });

  it("checks every object in a declared array", () => {
    const returns = {
      type: "array",
      items: { title: "string", url: "string" },
    };
    expect(satisfiesReturns([{ title: "one", url: "/1" }, { title: "two" }], returns)).toBe(false);
  });

  it("checks primitive field types", () => {
    expect(satisfiesReturns({ count: "2" }, { type: "object", fields: { count: "number" } })).toBe(false);
    expect(satisfiesReturns({ count: 2 }, { type: "object", fields: { count: "number" } })).toBe(true);
  });
});
