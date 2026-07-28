import { graphql, printSchema } from "graphql";
import { describe, expect, it } from "vitest";
import {
  buildLensSchema,
  createContext,
  type GraphQLLensClient,
} from "../src/graphql.js";
import type { LensResult, LensSpec } from "../src/types.js";

const base = {
  url: "https://example.com/",
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom" as const, fields: {} }],
};

const topSpec: LensSpec = {
  ...base,
  name: "@example/hn/top",
  params: { page: { type: "integer", default: 1 } },
  returns: {
    type: "object",
    fields: {
      stories: {
        type: "array",
        items: {
          title: "string",
          score: "integer",
          item_url: { $lens: "@example/hn/item", params: { id: "id" } },
        },
      },
    },
  },
};

const itemSpec: LensSpec = {
  ...base,
  name: "@example/hn/item",
  effects: { reads: ["example.com"], writes: [], cache: 300 },
  outcomes: { needs_auth: { hint: "sign in first" } },
  returns: { type: "object", fields: { text: "string" } },
};

/** A client whose lenses resolve from a canned result map; records each call. */
function stubClient(results: Record<string, LensResult>): GraphQLLensClient & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async call({ lens }) {
      calls.push(lens);
      const result = results[lens];
      if (!result) throw new Error(`no stub for ${lens}`);
      return result;
    },
  };
}

const topValue = (stories: unknown[]): LensResult => ({
  kind: "value",
  value: { stories },
  resolver: "dom",
  observed: "https://example.com/",
});

describe("buildLensSchema", () => {
  it("compiles groups, args, and ref joins into the schema", () => {
    const sdl = printSchema(buildLensSchema([topSpec, itemSpec]));
    expect(sdl).toContain("type Hn {");
    expect(sdl).toContain("top(page: Int = 1): HnTop");
    // the ref field is named for its join target, typed as the target lens
    expect(sdl).toContain("item: HnItem");
    // first's description makes printSchema render the args multi-line
    expect(sdl).toMatch(/stories\([^)]*first: Int\s*\): \[HnTopStories\]/);
  });

  it("resolves refs by calling the lens, only when selected", async () => {
    const client = stubClient({
      "@example/hn/top": topValue([
        { title: "a", score: 1, item_url: { $lens: "@example/hn/item", params: { id: "1" } } },
      ]),
      "@example/hn/item": { kind: "value", value: { text: "hi" }, resolver: "dom" },
    });
    const schema = buildLensSchema([topSpec, itemSpec]);
    const unselected = await graphql({
      schema,
      source: "{ hn { top { stories { title } } } }",
      contextValue: createContext(client, 10),
    });
    expect(unselected.errors).toBeUndefined();
    expect(client.calls).toEqual(["@example/hn/top"]);

    const selected = await graphql({
      schema,
      source: "{ hn { top { stories { title item { text } } } } }",
      contextValue: createContext(client, 10),
    });
    expect(selected.errors).toBeUndefined();
    expect((selected.data as any).hn.top.stories[0].item.text).toBe("hi");
    expect(client.calls).toEqual(["@example/hn/top", "@example/hn/top", "@example/hn/item"]);
  });

  it("bounds ref expansion with first", async () => {
    const stories = [1, 2, 3].map((id) => ({
      title: `s${id}`,
      score: id,
      item_url: { $lens: "@example/hn/item", params: { id: String(id) } },
    }));
    const client = stubClient({
      "@example/hn/top": topValue(stories),
      "@example/hn/item": { kind: "value", value: { text: "hi" }, resolver: "dom" },
    });
    const result = await graphql({
      schema: buildLensSchema([topSpec, itemSpec]),
      source: "{ hn { top { stories(first: 2) { item { text } } } } }",
      contextValue: createContext(client, 10),
    });
    expect(result.errors).toBeUndefined();
    expect(client.calls.filter((lens) => lens.endsWith("/item"))).toHaveLength(2);
  });

  it("exhausts the call budget as a GraphQL error, not an exception", async () => {
    const client = stubClient({
      "@example/hn/top": topValue([
        { title: "a", score: 1, item_url: { $lens: "@example/hn/item", params: { id: "1" } } },
      ]),
      "@example/hn/item": { kind: "value", value: { text: "hi" }, resolver: "dom" },
    });
    const result = await graphql({
      schema: buildLensSchema([topSpec, itemSpec]),
      source: "{ hn { top { stories { item { text } } } } }",
      contextValue: createContext(client, 1),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].extensions).toMatchObject({
      code: "LENS_BUDGET_EXHAUSTED",
      lens: "@example/hn/item",
    });
    // the budgeted call still produced its data; only the ref field nulled
    expect((result.data as any).hn.top.stories[0].item).toBeNull();
  });

  it("surfaces outcomes with the document's hint", async () => {
    const client = stubClient({
      "@example/hn/item": { kind: "outcome", name: "needs_auth", value: null, resolver: "dom" },
    });
    const result = await graphql({
      schema: buildLensSchema([topSpec, itemSpec]),
      source: "{ hn { item { text } } }",
      contextValue: createContext(client, 10),
    });
    expect(result.errors?.[0].extensions).toMatchObject({
      lens: "@example/hn/item",
      outcome: "needs_auth",
      hint: "sign in first",
    });
  });

  it("records call metadata for the response extensions", async () => {
    const client = stubClient({
      "@example/hn/item": { kind: "value", value: { text: "hi" }, resolver: "intercept" },
    });
    const context = createContext(client, 10);
    await graphql({
      schema: buildLensSchema([topSpec, itemSpec]),
      source: "{ hn { item { text } } }",
      contextValue: context,
    });
    expect(context.calls).toHaveLength(1);
    expect(context.calls[0]).toMatchObject({
      lens: "@example/hn/item",
      resolver: "intercept",
      cached: false,
      ttlSeconds: 300,
    });
    expect(context.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
