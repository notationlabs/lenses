import { describe, expect, it } from "vitest";
import { applyCatalogSettings } from "../src/catalog.js";

const doc = { name: "@test/site/read", url: "https://foo.example.com/a/{id}", params: { id: "string" }, effects: { reads: [], writes: [] }, resolve: [{ kind: "dom" }] };
const catalog = { scopes: [{ url: "https://*.example.com/*", exceptions: {
  needs_auth: { matches: "status = 401", hint: "Sign in" },
} }] };

describe("catalog exceptions", () => {
  it("matches URL templates and merges fields", () => {
    expect(applyCatalogSettings({ ...doc, exceptions: { needs_auth: { matches: "status = 403" } } }, catalog).exceptions)
      .toEqual({ needs_auth: { matches: "status = 403", hint: "Sign in" } });
  });
  it("nullifies a whole inherited entry", () => {
    expect(applyCatalogSettings({ ...doc, exceptions: { needs_auth: null } }, catalog).exceptions)
      .toEqual({ needs_auth: null });
  });
  it("can disable only the inherited predicate while keeping advice", () => {
    expect(applyCatalogSettings({ ...doc, exceptions: { needs_auth: { matches: null } } }, catalog).exceptions)
      .toEqual({ needs_auth: { matches: null, hint: "Sign in" } });
  });
  it("does not match another host", () => {
    expect(applyCatalogSettings({ ...doc, url: "https://elsewhere.test/a/{id}" }, catalog).exceptions).toBeUndefined();
  });
});
