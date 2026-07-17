import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/validate.js";

const validSpec = {
  lens: "example/page",
  version: 1,
  accepts: ["https://example.com/*"],
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom", fields: { title: { selector: "h1" } } }],
};

describe("validateSpec", () => {
  it("returns a fully validated lens document", () => {
    expect(validateSpec(validSpec)).toEqual(validSpec);
  });

  it("rejects malformed nested resolver fields before execution", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        resolve: [{ kind: "dom", fields: { title: { selector: 42 } } }],
      })
    ).toThrow(/selector/);
  });

  it("rejects ambiguous intercept inputs", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        resolve: [{
          kind: "intercept",
          request: "GET https://example.com/api",
          sources: { page: { request: "GET https://example.com/api" } },
        }],
      })
    ).toThrow(/either.*request.*sources/i);
  });

  it("rejects return contracts the engine cannot enforce", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        returns: { type: "list", items: { title: "string" } },
      })
    ).toThrow(/returns/);
  });
});
