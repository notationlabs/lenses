import { describe, expect, it } from "vitest";
import { pageFunctionsStamp } from "@djgrant/lenses-core/page-stamp";
import { pageStampNote } from "../src/extension-backend.js";
import type { ExtensionHello } from "@djgrant/lenses-core";

const hello = (pageStamp?: string): ExtensionHello => ({
  type: "extension-hello",
  protocolMajor: 1,
  extensionVersion: "0.1.0",
  capabilities: [],
  epoch: "e",
  ...(pageStamp ? { pageStamp } : {}),
});

describe("extension page-functions stamp", () => {
  it("is stable across calls", () => {
    expect(pageFunctionsStamp()).toBe(pageFunctionsStamp());
    expect(pageFunctionsStamp()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reports a match plainly", () => {
    expect(pageStampNote(hello(pageFunctionsStamp()))).toBe(
      ` [page functions ${pageFunctionsStamp()}]`
    );
  });

  // The whole point: a stale in-memory copy has to be nameable from outside.
  it("names a mismatch and says how to fix it", () => {
    const note = pageStampNote(hello("0000000000000000"));
    expect(note).toContain("STALE page functions 0000000000000000");
    expect(note).toContain(pageFunctionsStamp());
    expect(note).toContain("chrome://extensions");
  });

  it("distinguishes an extension that predates the stamp from a mismatch", () => {
    expect(pageStampNote(hello())).toContain("predates the stamp");
  });
});
