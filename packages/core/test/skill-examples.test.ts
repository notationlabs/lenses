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
  it("validates the example document as written", () => {
    expect(() => validateSpec({
      name: "@scope/site/thing",
      url: "https://site.com/{params.id}",
      params: { id: "string" },
      returns: { type: "object", fields: { title: "string" } },
      exceptions: { needs_auth: { matches: "$res.status = 401", $lens: "@scope/site/login" } },
      effects: { reads: ["site.com"], writes: [], idempotent: true },
      resolve: [
        { kind: "intercept",
          request: { method: "GET", url: "https://site.com/api/thing/{params.id}" },
          map: { title: "$res.body.data.title" } },
      ],
    })).not.toThrow();
  });

  it("shapes rows with the nested object map shown under Maps", async () => {
    const spec = validateSpec({
      name: "@scope/site/statement",
      url: "https://site.com/statement",
      effects: { reads: ["site.com"], writes: [] },
      resolve: [{
        kind: "intercept",
        request: { method: "GET", url: "https://site.com/api/statement" },
        items: "$res.body.statement",
        map: {
          date: "$item.date",
          posted: "$item.postedFlag = 'Y'",
          encoding: "'base64'",
          balance: { value: "$item.runningBalance.value", currency: "$item.runningBalance.currency" },
        },
      }],
    });
    const result = await executeLens(spec, {}, {
      ...io(null, null),
      getIntercepted: async () => [{
        url: "https://site.com/api/statement", method: "GET", status: 200, timestamp: 0,
        body: JSON.stringify({ statement: [{ date: "2026-01-01", postedFlag: "Y", runningBalance: { value: 5, currency: "GBP" } }] }),
      }],
    });
    expect(result).toMatchObject({
      kind: "value",
      value: [{ date: "2026-01-01", posted: true, encoding: "base64", balance: { value: 5, currency: "GBP" } }],
    });
  });

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
          post: "{ 'total': $number($value.total) }",
        },
        {
          kind: "dom",
          item: ".row",
          fields: { period: { selector: ".period" } },
          post: "{ 'rows': $value }",
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
      exceptions: { needs_auth: { matches: "$contains($page.url, '/sign-in') or $res.status = 401", hint: "Sign in at https://site.com, then retry." } },
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
          post: "{ 'amount': $money($value.raw) }",
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
          item: "#past-payments-{params.year} .row",
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
          detail: { $lens: "@scope/site/detail", params: { period: "$item.period" } },
        },
      },
      resolve: [
        {
          kind: "dom",
          item: ".row",
          fields: { period: { selector: ".period" } },
          post: "$value.{ 'period': period, 'detail': period ? {} : null }",
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
          detail: { $lens: "@scope/site/detail", params: { period: "$item.period" } },
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
          detail: { $lens: "@scope/site/detail", params: { period: "$item.period" } },
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
      url: "https://site.com/vat/{params.vrn}",
      params: {
        vrn: { type: "string", default: { $lens: "@scope/site/summary", field: "vrn" } },
      },
      effects: { reads: ["site.com"], writes: [] },
      resolve: [{ kind: "dom", fields: { total: { selector: ".total" } } }],
    });
    expect(spec.params).toMatchObject({ vrn: { default: { field: "vrn" } } });
  });
});
