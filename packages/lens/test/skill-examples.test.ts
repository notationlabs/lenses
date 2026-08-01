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

  it("runs a spec-level detect against each tier's own context", async () => {
    const spec = validateSpec({
      name: "@scope/site/thing",
      url: "https://site.com/thing",
      effects: { reads: ["site.com"], writes: [] },
      outcomes: { needs_auth: { hint: "Sign in at https://site.com, then retry." } },
      detect: { needs_auth: "$contains(url, '/sign-in') or status = 401" },
      resolve: [{ kind: "dom", fields: { total: { selector: ".total" } } }],
    });

    const signedOut: EngineIO = {
      ...io(null, null),
      domExtract: async () => ({ url: "https://site.com/sign-in", title: "Sign in", value: null }),
    };
    expect(await executeLens(spec, {}, signedOut)).toMatchObject({
      kind: "outcome",
      name: "needs_auth",
      resolver: "dom",
    });
  });

  it("binds a shared helper lambda as $name", async () => {
    const spec = validateSpec({
      name: "@scope/site/thing",
      url: "https://site.com/thing",
      effects: { reads: ["site.com"], writes: [] },
      helpers: { money: 'function($s) { $number($replace($s, /[^0-9.]/, "")) }' },
      resolve: [
        {
          kind: "dom",
          fields: { raw: { selector: ".total" } },
          post: "{ 'amount': $money(raw) }",
        },
      ],
    });

    const result = await executeLens(spec, {}, io(null, { raw: "\u00a31,234.50" }));
    expect(result).toMatchObject({ kind: "value", value: { amount: 1234.5 } });
  });

  it("substitutes a declared param into a selector", async () => {
    const spec = validateSpec({
      name: "@scope/site/payments",
      url: "https://site.com/payments",
      params: { year: "integer" },
      effects: { reads: ["site.com"], writes: [] },
      resolve: [
        {
          kind: "dom",
          item: "#past-payments-{year} .row",
          fields: { amount: { selector: ".amount" } },
        },
      ],
    });

    let seen: string | undefined;
    const capture: EngineIO = {
      ...io([{ amount: "1" }], null),
      domExtract: async (r: DomResolver) => {
        seen = r.item;
        return { url: "https://site.com/payments", title: "t", value: [{ amount: "1" }] };
      },
    };
    await executeLens(spec, { year: 2024 }, capture);
    expect(seen).toBe("#past-payments-2024 .row");
  });

  // An explicit null is how a row opts out of a reference it could otherwise
  // carry; the {} an author may still emit is materialised like an absent one.
  it("lets a row suppress its declared $lens ref with an explicit null", async () => {
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

  it("materialises a declared ref the resolver never emitted", async () => {
    // The ref needs nothing from the page: its params are expressions over the
    // sibling fields, so the row alone builds it. This used to require a {}
    // placeholder, and without one the field was simply absent — reported as
    // "no resolver produced field /0/detail", which reads as a broken selector
    // for a field no selector was ever meant to fill.
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
    expect(result).toMatchObject({
      kind: "value",
      value: [
        { period: "26C1", detail: { $lens: "@scope/site/detail", params: { period: "26C1" } } },
      ],
    });
    // Complete, not partial: nothing was left for a later tier to supply.
    expect(result).not.toHaveProperty("partial");
  });

  it("drops a ref to null when its params do not bind", async () => {
    const spec = validateSpec({
      name: "@scope/site/norefs",
      url: "https://site.com/list",
      effects: { reads: ["site.com"], writes: [] },
      returns: {
        type: "array",
        items: {
          period: { type: "string", nullable: true },
          detail: { $lens: "@scope/site/detail", params: { period: "period" } },
        },
      },
      resolve: [{ kind: "dom", item: ".row", fields: { period: { selector: ".period" } } }],
    });

    // A bare {} would be neither a callable ref nor null, and fails the schema.
    const result = await executeLens(spec, {}, io([{ period: null }], null));
    expect(result).toMatchObject({ kind: "value", value: [{ period: null, detail: null }] });
  });

  it("accepts a param default drawn from another lens, as written", () => {
    const spec = validateSpec({
      name: "@scope/site/vat",
      url: "https://site.com/vat/{vrn}",
      params: {
        vrn: { type: "string", default: { $lens: "@scope/site/summary", field: "vrn" } },
      },
      effects: { reads: ["site.com"], writes: [] },
      resolve: [{ kind: "dom", fields: { total: { selector: ".total" } } }],
    });
    expect(spec.params).toMatchObject({ vrn: { default: { field: "vrn" } } });
  });
});
