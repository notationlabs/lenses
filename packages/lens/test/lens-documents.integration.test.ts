import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import type { EngineIO } from "../src/types.js";
import { validateSpec } from "../src/validate.js";

const lensDirectory = resolve(import.meta.dirname, "../../../lenses");

async function loadLens(file: string) {
  return validateSpec(JSON.parse(await readFile(resolve(lensDirectory, file), "utf8")));
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
});
