import { describe, expect, it } from "vitest";
import { fileContentProblem, unsafeFileName } from "../src/file-result.js";
import { generateTsSdk } from "../src/generate.js";
import { satisfiesReturns } from "../src/reconcile.js";
import { deriveJsonSchema, validateResult } from "../src/schema.js";
import type { LensSpec } from "../src/types.js";
import { validateSpec } from "../src/validate.js";

const fileSpec = {
  name: "@example/bank/statement-pdf",
  url: "https://example.com/statements/{params.id}",
  params: { id: "string" },
  returns: { type: "file" },
  effects: { reads: ["example.com"], writes: [] },
  resolve: [
    {
      kind: "intercept",
      request: { method: "GET", url: "https://example.com/api/statements/{params.id}" },
      map: { content: "$res.body.content", encoding: "'base64'", mimeType: "'application/pdf'" },
    },
  ],
};

describe('returns {"type": "file"}', () => {
  it("is accepted as the whole result", () => {
    expect(validateSpec(fileSpec)).toEqual(fileSpec);
  });

  it("is refused inside an object", () => {
    expect(() =>
      validateSpec({ ...fileSpec, returns: { type: "object", fields: { pdf: { type: "file" } } } })
    ).toThrow(/returns/);
  });

  it("is satisfied by file content, not by a partial map", () => {
    const returns = { type: "file" };
    expect(satisfiesReturns({ content: "JVBERg==", encoding: "base64", mimeType: "application/pdf" }, returns)).toBe(true);
    expect(satisfiesReturns({ content: "JVBERg==", encoding: "base64" }, returns)).toBe(false);
  });

  it("describes what the caller receives", () => {
    const spec = fileSpec as LensSpec;
    expect(validateResult(spec, { path: "/tmp/s.pdf", name: "s.pdf", mimeType: "application/pdf", bytes: 3 })).toEqual([]);
    expect(deriveJsonSchema(spec)).toMatchObject({
      type: "object",
      required: ["path", "name", "mimeType", "bytes"],
    });
    expect(generateTsSdk([spec])).toContain(
      "result: { path: string; name: string; mimeType: string; bytes: number };"
    );
  });
});

describe("file content checks", () => {
  it.each([
    [{ content: 1, encoding: "base64", mimeType: "application/pdf" }, "content must be a string"],
    [{ content: "x", encoding: "hex", mimeType: "application/pdf" }, "encoding"],
    [{ content: "x", encoding: "utf8", mimeType: "pdf" }, "mimeType"],
    [{ content: "not base64!", encoding: "base64", mimeType: "application/pdf" }, "not base64"],
  ])("refuses %j", (value, problem) => {
    expect(fileContentProblem(value)).toContain(problem);
  });

  it.each([
    ["../up.pdf", "path separator"],
    ["a\\b.pdf", "path separator"],
    [".hidden", "starts with a dot"],
    ["", "is empty"],
  ])("refuses the name %j", (name, problem) => {
    expect(unsafeFileName(name)).toContain(problem);
  });

  it("accepts an ordinary name", () => {
    expect(unsafeFileName("Statement--12-34-56-12345678--02-09-2026-01-10-2026.pdf")).toBeUndefined();
  });
});
