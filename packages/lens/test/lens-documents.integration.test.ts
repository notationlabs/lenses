import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import type { EngineIO, InterceptedResponse } from "../src/types.js";
import { validateSpec } from "../src/validate.js";

const lensDirectory = resolve(import.meta.dirname, "../../../lenses");

async function loadLens(file: string) {
  return validateSpec(JSON.parse(await readFile(resolve(lensDirectory, file), "utf8")));
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
    const files = (await readdir(lensDirectory)).filter((file) => file.endsWith(".json"));
    const specs = await Promise.all(files.map(loadLens));
    expect(specs.map((spec) => `${spec.lens}@v${spec.version}`).sort()).toEqual([
      "claude/usage@v1",
      "github/notifications@v1",
      "hn/item@v1",
      "hn/top@v1",
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

    const result = await executeLens(spec, "https://news.ycombinator.com/", {}, io);
    expect(result).toMatchObject({
      kind: "value",
      resolver: "reconciled",
      value: {
        stories: [
          {
            item_url: { $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=42" },
          },
          {
            item_url: { $lens: "hn/item@v1", target: "https://news.ycombinator.com/item?id=43" },
          },
        ],
        next_page: { $lens: "hn/top@v1", target: "https://news.ycombinator.com/news?p=2" },
      },
    });
  });

  it("combines Claude's usage API limits with the plan shown in the page", async () => {
    const spec = await loadLens("claude.usage.json");
    const capture: InterceptedResponse = {
      method: "GET",
      url: "https://claude.ai/api/organizations/acme/usage",
      status: 200,
      body: JSON.stringify({
        limits: [{ kind: "session", used_dollars: "1", limit_dollars: "5", percent: 20, resets_at: "13:00" }],
      }),
      timestamp: Date.now(),
    };

    const result = await executeLens(spec, "https://claude.ai/settings/usage", {}, io({
      getIntercepted: async () => [capture],
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
        limits: [{ name: "Current session", used: "1", limit: "5", percent: "20%", resets_at: "13:00" }],
      },
    });
  });

  it("asks the agent to complete GitHub notifications when DOM fields cannot satisfy the contract", async () => {
    const spec = await loadLens("github.notifications.json");
    const result = await executeLens(spec, "https://github.com/notifications", {}, io({
      domExtract: async () => ({
        url: "https://github.com/notifications",
        title: "Notifications",
        value: [{ title: "Review requested", url: "https://github.com/acme/widgets/pull/1" }],
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

  it("extracts a Hacker News story, windows its comments, and materialises the next page", async () => {
    const spec = await loadLens("hn.item.json");
    const comments = Array.from({ length: 31 }, (_, index) => ({
      author: `user${index}`,
      age: `${index + 1} minutes ago`,
      text: `Comment ${index + 1}`,
      indent: "0",
    }));
    const result = await executeLens(spec, "https://news.ycombinator.com/item?id=42", {}, io({
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
          $lens: "hn/item@v1",
          target: "https://news.ycombinator.com/item?id=42&p=2",
        },
      },
    });
    if (result.kind === "value") {
      const value = result.value as { comments: Array<{ author: string; text: string }> };
      expect(value.comments).toHaveLength(30);
      expect(value.comments[0]).toMatchObject({ author: "user0", text: "Comment 1" });
    }
  });
});
