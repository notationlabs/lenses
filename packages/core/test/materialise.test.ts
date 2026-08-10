import { describe, expect, it } from "vitest";
import { materialiseLenses } from "../src/materialise.js";

describe("materialiseLenses", () => {
  it("returns the value unchanged when there is no returns schema", async () => {
    const v = { a: 1 };
    expect(await materialiseLenses(v, undefined)).toEqual(v);
  });

  it("binds a $lens field using declared parameter expressions", async () => {
    const returns = {
      type: "object",
      fields: { next: { $lens: "@djgrant/hn/top", params: { p: "next" } } },
    };
    const r = await materialiseLenses({ next: 2 }, returns);
    expect(r).toEqual({ next: { $lens: "@djgrant/hn/top", params: { p: 2 } } });
  });

  it("binds a $lens field on every row of an array-of-objects field", async () => {
    const returns = {
      type: "object",
      fields: {
        stories: {
          type: "array",
          items: {
            id: "string",
            item_url: { $lens: "@djgrant/hn/item", params: { id: "id" } },
          },
        },
      },
    };
    const r = (await materialiseLenses(
      {
        stories: [
          { id: "1", item_url: "1" },
          { id: "2", item_url: "2" },
        ],
      },
      returns
    )) as { stories: Array<{ item_url: unknown }> };
    expect(r.stories[0].item_url).toEqual({ $lens: "@djgrant/hn/item", params: { id: "1" } });
    expect(r.stories[1].item_url).toEqual({ $lens: "@djgrant/hn/item", params: { id: "2" } });
  });

  it("can resolve parameters from call parameters", async () => {
    const returns = {
      type: "array",
      items: {
        id: "string",
        item_url: { $lens: "@djgrant/hn/item", params: { id: "id", page: "$page" } },
      },
    };
    const r = (await materialiseLenses([{ id: "9", item_url: "9" }], returns, { page: 2 })) as Array<{ item_url: unknown }>;
    expect(r[0].item_url).toEqual({
      $lens: "@djgrant/hn/item",
      params: { id: "9", page: 2 },
    });
  });

  it("does not double-wrap a value that is already a ref", async () => {
    const returns = { type: "object", fields: { next: { $lens: "@djgrant/hn/top" } } };
    const already = { next: { $lens: "@djgrant/hn/top", params: { p: 2 } } };
    expect(await materialiseLenses(already, returns)).toEqual(already);
  });

  it("leaves a null $lens field as null (e.g. the last page)", async () => {
    const returns = { type: "object", fields: { next_page: { $lens: "@djgrant/hn/top" } } };
    expect(await materialiseLenses({ next_page: null }, returns)).toEqual({ next_page: null });
  });

  it("binds a $lens field at every depth of a self-referencing $def", async () => {
    const defs = {
      comment: {
        type: "object",
        fields: {
          id: "string",
          permalink: { $lens: "@djgrant/hn/comment", params: { id: "id" } },
          replies: { type: "array", items: { $ref: "comment" } },
        },
      },
    };
    const returns = { type: "object", fields: { comments: { type: "array", items: { $ref: "comment" } } } };
    const r = (await materialiseLenses(
      { comments: [{ id: "1", replies: [{ id: "2", replies: [] }] }] },
      returns,
      {},
      true,
      undefined,
      defs
    )) as any;
    expect(r.comments[0].permalink).toEqual({ $lens: "@djgrant/hn/comment", params: { id: "1" } });
    expect(r.comments[0].replies[0].permalink).toEqual({
      $lens: "@djgrant/hn/comment",
      params: { id: "2" },
    });
  });

  it("leaves non-$lens fields untouched", async () => {
    const returns = { type: "object", fields: { plan: "string", limits: { type: "array" } } };
    const v = { plan: "Pro", limits: [{ name: "session" }] };
    expect(await materialiseLenses(v, returns)).toEqual(v);
  });
});
