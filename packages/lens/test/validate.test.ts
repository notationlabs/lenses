import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/validate.js";

const validSpec = {
  name: "@example/web/page",
  url: "https://example.com/{page}",
  params: { page: "string" },
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom", fields: { title: { selector: "h1" } } }],
};

describe("validateSpec", () => {
  it("returns a fully validated lens document", () => {
    expect(validateSpec(validSpec)).toEqual(validSpec);
  });

  it("accepts a positive page load timeout", () => {
    const spec = { ...validSpec, loadTimeoutMs: 45_000 };
    expect(validateSpec(spec)).toEqual(spec);
  });

  it("rejects undeclared URL parameters", () => {
    expect(() => validateSpec({ ...validSpec, params: undefined })).toThrow(/not declared/);
  });

  it("rejects an invalid canonical URL", () => {
    expect(() => validateSpec({ ...validSpec, url: "example/{page}" })).toThrow(/absolute URL/);
  });

  it("rejects a parameter default with the wrong type", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "integer", default: "one" } },
      })
    ).toThrow(/default.*page.*integer/);
  });

  it("rejects a non-positive page load timeout", () => {
    expect(() => validateSpec({ ...validSpec, loadTimeoutMs: 0 })).toThrow(/loadTimeoutMs/);
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
