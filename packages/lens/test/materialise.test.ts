import { describe, expect, it } from "vitest";
import { materialiseLenses } from "../src/materialise.js";

describe("materialiseLenses", () => {
  it("returns the value unchanged when there is no returns schema", async () => {
    const v = { a: 1 };
    expect(await materialiseLenses(v, undefined)).toEqual(v);
  });

  it("binds a $lens field on an object return using its string URL value", async () => {
    const returns = { type: "object", fields: { next: { $lens: "hn/top@v1" } } };
    const r = await materialiseLenses({ next: "https://news.ycombinator.com/news?p=2" }, returns);
    expect(r).toEqual({ next: { $lens: "hn/top@v1", target: "https://news.ycombinator.com/news?p=2" } });
  });

  it("binds a $lens field on every row of an array-of-objects field", async () => {
    const returns = {
      type: "object",
      fields: {
        stories: {
          type: "array",
          items: { id: "string", item_url: { $lens: "hn/item@v1" } },
        },
      },
    };
    const r = (await materialiseLenses(
      {
        stories: [
          { id: "1", item_url: "https://news.ycombinator.com/item?id=1" },
          { id: "2", item_url: "https://news.ycombinator.com/item?id=2" },
        ],
      },
      returns
    )) as { stories: Array<{ item_url: unknown }> };
    expect(r.stories[0].item_url).toEqual({ $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=1" });
    expect(r.stories[1].item_url).toEqual({ $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=2" });
  });

  it("resolves target via a JSONata expression against the row", async () => {
    const returns = {
      type: "array",
      items: { id: "string", item_url: { $lens: "hn/item@v1", target: "'https://x/item?id=' & id" } },
    };
    const r = (await materialiseLenses([{ id: "9" }], returns)) as Array<{ item_url: unknown }>;
    expect(r[0].item_url).toEqual({ $lens: "hn/item@v1", target: "https://x/item?id=9" });
  });

  it("does not double-wrap a value that is already a ref", async () => {
    const returns = { type: "object", fields: { next: { $lens: "hn/top@v1" } } };
    const already = { next: { $lens: "hn/top@v1", target: "https://x" } };
    expect(await materialiseLenses(already, returns)).toEqual(already);
  });

  it("leaves a null $lens field as null (e.g. the last page)", async () => {
    const returns = { type: "object", fields: { next_page: { $lens: "hn/top@v1" } } };
    expect(await materialiseLenses({ next_page: null }, returns)).toEqual({ next_page: null });
  });

  it("leaves non-$lens fields untouched", async () => {
    const returns = { type: "object", fields: { plan: "string", limits: { type: "array" } } };
    const v = { plan: "Pro", limits: [{ name: "session" }] };
    expect(await materialiseLenses(v, returns)).toEqual(v);
  });
});
