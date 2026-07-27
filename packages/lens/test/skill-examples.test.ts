import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import { validateSpec } from "../src/validate.js";
import type { DomResolver, EngineIO } from "../src/types.js";

/** The patterns SKILL.md tells authors to write, executed as written. */

function io(rows: unknown, fields: unknown): EngineIO {
  return {
    getIntercepted: async () => [],
    snapshot: async () => ({ url: "https://site.com/", title: "t", text: "" }),
    sleep: async () => {},
    domExtract: async (r: DomResolver) => ({
      url: "https://site.com/",
      title: "t",
      value: r.item ? rows : fields,
    }),
  };
}

describe("SKILL.md authoring examples", () => {
  it("composes a summary tier and a list tier into one object", async () => {
    const spec = validateSpec({
      name: "@scope/site/thing",
      url: "https://site.com/thing",
      effects: { reads: ["site.com"], writes: [] },
      returns: {
        type: "object",
        fields: { total: "number", rows: { type: "array", items: { period: "string" } } },
      },
      resolve: [
        {
          kind: "dom",
          fields: { total: { selector: ".total" } },
          post: "{ 'total': $number(total) }",
        },
        {
          kind: "dom",
          item: ".row",
          fields: { period: { selector: ".period" } },
          post: "{ 'rows': $ }",
        },
      ],
    });

    const result = await executeLens(spec, {}, io([{ period: "Q1" }], { total: "4" }));
    expect(result).toEqual({
      kind: "value",
      resolver: "reconciled",
      observed: "https://site.com/",
      value: { total: 4, rows: [{ period: "Q1" }] },
    });
  });

  it("materialises a declared $lens ref from a {} placeholder, and skips a null one", async () => {
    const spec = validateSpec({
      name: "@scope/site/list",
      url: "https://site.com/list",
      effects: { reads: ["site.com"], writes: [] },
      returns: {
        type: "array",
        items: {
          period: { type: "string", nullable: true },
          detail: { $lens: "@scope/site/detail", params: { period: "period" } },
        },
      },
      resolve: [
        {
          kind: "dom",
          item: ".row",
          fields: { period: { selector: ".period" } },
          post: "$.{ 'period': period, 'detail': period ? {} : null }",
        },
      ],
    });

    const result = await executeLens(spec, {}, io([{ period: "26C1" }, { period: null }], null));
    expect(result).toMatchObject({
      kind: "value",
      value: [
        { period: "26C1", detail: { $lens: "@scope/site/detail", params: { period: "26C1" } } },
        { period: null, detail: null },
      ],
    });
  });

  it("leaves a declared ref unmaterialised when the resolver emits no placeholder", async () => {
    // Why the documentation insists on the placeholder: without it the field
    // is simply absent, and the failure reads as a broken selector.
    const spec = validateSpec({
      name: "@scope/site/norefs",
      url: "https://site.com/list",
      effects: { reads: ["site.com"], writes: [] },
      returns: {
        type: "array",
        items: {
          period: "string",
          detail: { $lens: "@scope/site/detail", params: { period: "period" } },
        },
      },
      resolve: [
        { kind: "dom", item: ".row", fields: { period: { selector: ".period" } } },
      ],
    });

    const result = await executeLens(spec, {}, io([{ period: "26C1" }], null));
    expect(result).toMatchObject({ kind: "value", partial: true, value: [{ period: "26C1" }] });
    expect((result as { value: Record<string, unknown>[] }).value[0]).not.toHaveProperty("detail");
  });
});
