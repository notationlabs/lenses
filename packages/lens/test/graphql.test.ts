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

const threadSpec: LensSpec = {
  ...base,
  name: "@example/hn/thread",
  params: { id: "string" },
  $defs: {
    comments: {
      type: "object",
      fields: {
        author: "string",
        text: "string",
        replies: { type: "array", items: { $ref: "comments" } },
      },
    },
  },
  returns: {
    type: "object",
    fields: { comments: { type: "array", items: { $ref: "comments" } } },
  },
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

  it("compiles an enum param into a named enum type that passes the declared value", async () => {
    const searchSpec: LensSpec = {
      ...base,
      name: "@example/hn/search",
      params: {
        order: { type: "string", enum: ["byPopularity", "byDate"], default: "byPopularity" },
      },
      returns: { type: "object", fields: { total: "integer" } },
    };
    const sdl = printSchema(buildLensSchema([searchSpec]));
    expect(sdl).toContain("enum HnSearchOrder {");
    expect(sdl).toContain("BY_POPULARITY");
    // the default prints as the enum name, not the raw declared value
    expect(sdl).toContain("search(order: HnSearchOrder = BY_POPULARITY): HnSearch");

    const seen: Record<string, unknown>[] = [];
    const client: GraphQLLensClient = {
      async call({ params }) {
        seen.push(params ?? {});
        return { kind: "value", value: { total: 1 }, resolver: "intercept" };
      },
    };
    const result = await graphql({
      schema: buildLensSchema([searchSpec]),
      source: "{ hn { search(order: BY_DATE) { total } } }",
      contextValue: createContext(client, 10),
    });
    expect(result.errors).toBeUndefined();
    // the lens receives the document's declared value, not the GraphQL name
    expect(seen).toEqual([{ order: "byDate" }]);
  });

  it("compiles a self-referencing $defs entry into one recursive type", async () => {
    const sdl = printSchema(buildLensSchema([threadSpec]));
    expect(sdl).toContain("type HnThreadComments {");
    // the recursive edge points back at the same type, with the array's first arg
    expect(sdl).toMatch(/replies\([^)]*first: Int\s*\): \[HnThreadComments\]/);

    const client = stubClient({
      "@example/hn/thread": {
        kind: "value",
        value: {
          comments: [
            {
              author: "a",
              text: "root",
              replies: [{ author: "b", text: "child", replies: [] }],
            },
          ],
        },
        resolver: "dom",
      },
    });
    const result = await graphql({
      schema: buildLensSchema([threadSpec]),
      source: "{ hn { thread { comments { text replies { text replies { text } } } } } }",
      contextValue: createContext(client, 10),
    });
    expect(result.errors).toBeUndefined();
    const comments = (result.data as any).hn.thread.comments;
    expect(comments[0].replies[0].text).toBe("child");
    expect(comments[0].replies[0].replies).toEqual([]);
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
