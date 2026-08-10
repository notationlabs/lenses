import { describe, expect, it } from "vitest";
import { expandUrl, matchRequestPattern } from "../src/url-pattern.js";

describe("expandUrl", () => {
  it("expands and encodes named parameters", () => {
    expect(
      expandUrl("https://x.com/{handle}/status/{id}", { handle: "alice smith", id: 123 })
    ).toBe("https://x.com/alice%20smith/status/123");
  });

  it("rejects a missing URL parameter", () => {
    expect(() => expandUrl("https://x.com/{handle}", {})).toThrow(/missing URL parameter/);
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
