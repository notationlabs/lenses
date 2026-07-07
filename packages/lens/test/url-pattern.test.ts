import { describe, expect, it } from "vitest";
import { matchRequestPattern, matchUrl } from "../src/url-pattern.js";

describe("matchUrl", () => {
  it("extracts named holes", () => {
    const m = matchUrl(["https://x.com/{handle}/status/{id}"], "https://x.com/alice/status/123");
    expect(m?.params).toEqual({ handle: "alice", id: "123" });
  });

  it("holes do not cross segment boundaries", () => {
    expect(matchUrl(["https://x.com/{handle}"], "https://x.com/a/b")).toBeNull();
  });

  it("supports trailing wildcard", () => {
    expect(matchUrl(["https://news.ycombinator.com/*"], "https://news.ycombinator.com/news?p=2")).toBeTruthy();
  });

  it("matches query-string holes", () => {
    const m = matchUrl(
      ["https://news.ycombinator.com/item?id={id}"],
      "https://news.ycombinator.com/item?id=999"
    );
    expect(m?.params.id).toBe("999");
  });

  it("returns null on no match", () => {
    expect(matchUrl(["https://x.com/{h}"], "https://example.com/")).toBeNull();
  });
});

describe("matchRequestPattern", () => {
  it("matches method + glob", () => {
    expect(
      matchRequestPattern(
        "GET https://x.com/i/api/graphql/*/TweetDetail*",
        "get",
        "https://x.com/i/api/graphql/abc123/TweetDetail?vars=1"
      )
    ).toBe(true);
  });

  it("rejects wrong method", () => {
    expect(matchRequestPattern("POST https://a.com/*", "GET", "https://a.com/x")).toBe(false);
  });
});
