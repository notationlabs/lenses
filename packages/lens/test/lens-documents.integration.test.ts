import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import type { EngineIO, InterceptedResponse } from "../src/types.js";
import { validateSpec } from "../src/validate.js";

const lensCatalog = resolve(import.meta.dirname, "../../../examples");

async function loadLens(file: string) {
  return validateSpec(JSON.parse(await readFile(resolve(lensCatalog, file), "utf8")));
}

function io(overrides: Partial<EngineIO>): EngineIO {
  return {
    getIntercepted: async () => [],
    domExtract: async () => ({ url: "", title: "", value: null }),
    snapshot: async () => ({ url: "", title: "", text: "" }),
    sleep: async () => {},
    ...overrides,
  };
}

describe("shipped lens documents", () => {
  it("all pass the same nested validation used by the host", async () => {
    const files = (await readdir(lensCatalog)).filter((file) => file.endsWith(".json"));
    const specs = await Promise.all(files.map(loadLens));
    expect(specs.map((spec) => spec.name).sort()).toEqual([
      "@djgrant/claude/usage",
      "@djgrant/github/notifications",
      "@djgrant/hn/comment",
      "@djgrant/hn/item",
      "@djgrant/hn/top",
    ]);
  });

  it("executes hn/top through DOM extraction, reconciliation, and lens materialisation", async () => {
    const spec = await loadLens("hn.top.json");
    const io: EngineIO = {
      getIntercepted: async () => [],
      domExtract: async (resolver) =>
        resolver.item
          ? {
              url: "https://news.ycombinator.com/",
              title: "Hacker News",
              value: [
                {
                  id: "42",
                  title: "A story",
                  url: "https://example.com/story",
                  score: "10 points",
                  comments: "3 comments",
                },
                {
                  id: "43",
                  title: "Another story",
                  url: "https://example.com/another",
                  score: "8 points",
                  comments: "1 comment",
                },
              ],
            }
          : {
              url: "https://news.ycombinator.com/",
              title: "Hacker News",
              value: { next_page: "https://news.ycombinator.com/news?p=2" },
            },
      snapshot: async () => {
        throw new Error("LLM fallback should not run");
      },
      sleep: async () => {},
    };

    const result = await executeLens(spec, { page: 1 }, io);
    expect(result).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: {
        stories: [
          {
            item_url: { $lens: "@djgrant/hn/item", params: { id: "42" } },
          },
          {
            item_url: { $lens: "@djgrant/hn/item", params: { id: "43" } },
          },
        ],
        next_page: { $lens: "@djgrant/hn/top", params: { page: 2 } },
      },
    });
  });

  it("keeps a hiring post's null score and comments within the hn/top contract", async () => {
    const spec = await loadLens("hn.top.json");
    const result = await executeLens(spec, { page: 2 }, io({
      domExtract: async (resolver) =>
        resolver.item
          ? {
              url: "https://news.ycombinator.com/news?p=2",
              title: "Hacker News",
              value: [
                {
                  id: "42",
                  title: "A story",
                  url: "https://example.com/story",
                  score: "10 points",
                  comments: "3 comments",
                },
                {
                  id: "44",
                  title: "Acme (YC W26) is hiring",
                  url: "https://example.com/jobs",
                  score: null,
                  comments: null,
                },
              ],
            }
          : {
              url: "https://news.ycombinator.com/news?p=2",
              title: "Hacker News",
              value: { next_page: "https://news.ycombinator.com/news?p=3" },
            },
      snapshot: async () => {
        throw new Error("LLM fallback should not run");
      },
    }));

    expect(result).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: {
        stories: [
          { score: "10 points", comments: "3 comments" },
          {
            score: null,
            comments: null,
            item_url: { $lens: "@djgrant/hn/item", params: { id: "44" } },
          },
        ],
        next_page: { $lens: "@djgrant/hn/top", params: { page: 3 } },
      },
    });
  });

  it("combines Claude's usage API limits with the plan shown in the page", async () => {
    const spec = await loadLens("claude.usage.json");
    const capture: InterceptedResponse = {
      method: "GET",
      url: "https://claude.ai/api/organizations/acme/usage",
      status: 200,
      body: JSON.stringify({ limits: [{ kind: "session", percent: 20, resets_at: null }] }),
      timestamp: Date.now(),
    };

    const result = await executeLens(spec, {}, io({
      getIntercepted: async () => [
        capture,
        {
          method: "GET",
          url: "https://claude.ai/api/organizations/acme/overage_spend_limit",
          status: 200,
          body: JSON.stringify({
            is_enabled: true,
            used_credits: 125,
            monthly_credit_limit: 4000,
            currency: "GBP",
          }),
          timestamp: Date.now(),
        },
        {
          method: "GET",
          url: "https://claude.ai/api/organizations/acme/prepaid/credits",
          status: 200,
          body: JSON.stringify({ amount: 750, auto_reload_settings: null }),
          timestamp: Date.now(),
        },
        {
          method: "GET",
          url: "https://claude.ai/api/organizations/acme/prepaid/bundles",
          status: 200,
          body: JSON.stringify({ purchases_reset_at: "2026-08-01T00:00:00Z" }),
          timestamp: Date.now(),
        },
      ],
      domExtract: async () => ({
        url: "https://claude.ai/settings/usage",
        title: "Usage",
        value: { dialog: "Plan usage limits Max (20x) Current session" },
      }),
    }));

    expect(result).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: {
        plan: "Max (20x)",
        limits: [{ name: "Current session", percent: "20%", resets_at: null }],
        usage_credits: {
          enabled: true,
          spent_minor: 125,
          monthly_limit_minor: 4000,
          balance_minor: 750,
          currency: "GBP",
          percent: "3%",
          resets_at: "2026-08-01T00:00:00Z",
          auto_reload: false,
        },
      },
    });
  });

  it("asks the agent to complete GitHub notifications when DOM fields cannot satisfy the contract", async () => {
    const spec = await loadLens("github.notifications.json");
    const result = await executeLens(spec, {}, io({
      domExtract: async (resolver) => ({
        url: "https://github.com/notifications",
        title: "Notifications",
        value: resolver.item
          ? [{ title: "Review requested", url: "https://github.com/acme/widgets/pull/1" }]
          : { page: "Notifications" },
      }),
      snapshot: async () => ({
        url: "https://github.com/notifications",
        title: "Notifications",
        text: "acme/widgets: Review requested because you were mentioned",
      }),
    }));

    expect(result).toMatchObject({
      kind: "outcome",
      name: "agent_extract",
      value: {
        gathered: [{ title: "Review requested", url: "https://github.com/acme/widgets/pull/1" }],
      },
    });
  });

  it("returns an empty GitHub inbox without escalating to the agent", async () => {
    const spec = await loadLens("github.notifications.json");
    const result = await executeLens(spec, {}, io({
      domExtract: async () => ({
        url: "https://github.com/notifications?query=is%3Aunread",
        title: "Notifications",
        value: { page: "Notifications by date\nAll caught up!" },
      }),
    }));

    expect(result).toEqual({
      kind: "value",
      value: [],
      resolver: "dom",
      observed: "https://github.com/notifications?query=is%3Aunread",
    });
  });

  it("extracts a Hacker News story, windows its comments, and materialises the next page", async () => {
    const spec = await loadLens("hn.item.json");
    const comments = Array.from({ length: 31 }, (_, index) => ({
      id: String(1000 + index),
      author: `user${index}`,
      age: `${index + 1} minutes ago`,
      text: `Comment ${index + 1}`,
      indent: "0",
    }));
    const result = await executeLens(spec, { id: "42" }, io({
      domExtract: async (resolver) => ({
        url: "https://news.ycombinator.com/item?id=42",
        title: "A story",
        value: resolver.item
          ? comments
          : { title: "A story", url: "https://example.com/story", score: "10 points" },
      }),
      snapshot: async () => {
        throw new Error("LLM fallback should not run");
      },
    }));

    expect(result).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: {
        story: { title: "A story", url: "https://example.com/story", score: "10 points" },
        next_page: {
          $lens: "@djgrant/hn/item",
          params: { id: "42", page: 2, limit: 30 },
        },
      },
    });
    if (result.kind === "value") {
      const value = result.value as { comments: Array<{ author: string; text: string }> };
      expect(value.comments).toHaveLength(30);
      expect(value.comments[0]).toMatchObject({ id: "1000", author: "user0", text: "Comment 1" });
    }
  });

  it("extracts a comment subtree from a permalink, merging the root with its reply tree", async () => {
    const spec = await loadLens("hn.comment.json");
    const replies = [
      { id: "43", author: "child", age: "1 minute ago", text: "First reply", indent: "0" },
      { id: "44", author: "grandchild", age: "1 minute ago", text: "Nested reply", indent: "1" },
    ];
    const result = await executeLens(spec, { id: "42" }, io({
      domExtract: async (resolver) => ({
        url: "https://news.ycombinator.com/item?id=42",
        title: "A comment",
        value: resolver.item
          ? replies
          : { author: "root", age: "2 hours ago", text: "Root comment" },
      }),
      snapshot: async () => {
        throw new Error("LLM fallback should not run");
      },
    }));

    expect(result).toEqual({
      kind: "value",
      resolver: "reconciled",
      observed: "https://news.ycombinator.com/item?id=42",
      value: {
        id: "42",
        author: "root",
        age: "2 hours ago",
        text: "Root comment",
        replies: [
          {
            id: "43",
            author: "child",
            age: "1 minute ago",
            text: "First reply",
            replies: [
              { id: "44", author: "grandchild", age: "1 minute ago", text: "Nested reply", replies: [] },
            ],
          },
        ],
      },
    });
  });

  it("returns an empty reply list for a leaf comment instead of missing the contract", async () => {
    const spec = await loadLens("hn.comment.json");
    const result = await executeLens(spec, { id: "42" }, io({
      domExtract: async (resolver) => ({
        url: "https://news.ycombinator.com/item?id=42",
        title: "A comment",
        // the reply-tree tier finds no .comtr rows on a leaf comment's page
        value: resolver.item ? [] : { author: "root", age: "2 hours ago", text: "Leaf comment" },
      }),
      snapshot: async () => {
        throw new Error("LLM fallback should not run");
      },
    }));

    expect(result).toEqual({
      kind: "value",
      resolver: "dom",
      observed: "https://news.ycombinator.com/item?id=42",
      value: { id: "42", author: "root", age: "2 hours ago", text: "Leaf comment", replies: [] },
    });
  });
});
