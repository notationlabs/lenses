import { describe, expect, it } from "vitest";
import { generateTsSdk } from "../src/generate.js";
import type { LensSpec } from "../src/types.js";

const base = {
  url: "https://example.com/",
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom" as const, fields: { title: { selector: "h1" } } }],
};

function spec(overrides: Partial<LensSpec> & { name: string }): LensSpec {
  return { ...base, ...overrides };
}

describe("generateTsSdk", () => {
  it("emits a Lenses entry keyed by scoped name with a shortname alias", () => {
    const source = generateTsSdk([spec({ name: "@example/web/page", returns: "string" })]);
    expect(source).toContain('"@example/web/page": {');
    expect(source).toContain("    result: string;");
    expect(source).toContain('"web/page": Lenses["@example/web/page"];');
  });

  it("marks defaulted params optional and undeclared param maps as empty", () => {
    const source = generateTsSdk([
      spec({
        name: "@example/web/item",
        url: "https://example.com/{id}?p={p}",
        params: { id: "string", p: { type: "integer", default: 1 } },
      }),
      spec({ name: "@example/web/home" }),
    ]);
    expect(source).toContain("params: { id: string; p?: number };");
    expect(source).toContain("params: Record<string, never>;");
  });

  it("derives open objects, nullable primitives and typed lens refs", () => {
    const source = generateTsSdk([
      spec({
        name: "@example/web/page",
        returns: {
          type: "object",
          fields: {
            title: "string",
            resets_at: { type: "string", nullable: true },
            next_page: { $lens: "@example/web/page", params: { p: "p" } },
            elsewhere: { $lens: "@other/site/page" },
            rows: { type: "array", items: { id: "string" } },
          },
        },
      }),
    ]);
    expect(source).toContain("title: string;");
    expect(source).toContain("resets_at: string | null;");
    expect(source).toContain('next_page: LensRef<"@example/web/page"> | null;');
    expect(source).toContain("elsewhere: LensRef | null;");
    expect(source).toContain("rows: Array<{");
    expect(source).toContain("[key: string]: unknown;");
  });

  it("types an absent returns declaration as unknown", () => {
    expect(generateTsSdk([spec({ name: "@example/web/page" })])).toContain("result: unknown;");
  });

  it("rejects duplicate shortnames across the merged set", () => {
    expect(() =>
      generateTsSdk([spec({ name: "@a/web/page" }), spec({ name: "@b/web/page" })])
    ).toThrow('duplicate lens name "web/page"');
  });
});
