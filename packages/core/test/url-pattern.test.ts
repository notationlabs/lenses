import { describe, expect, it } from "vitest";
import { expandUrl, matchRequestPattern } from "../src/url-pattern.js";

describe("expandUrl", () => {
  it("expands and encodes named parameters", () => {
    expect(
      expandUrl("https://x.com/{params.handle}/status/{params.id}", { handle: "alice smith", id: 123 })
    ).toBe("https://x.com/alice%20smith/status/123");
  });

  it("rejects a missing URL parameter", () => {
    expect(() => expandUrl("https://x.com/{params.handle}", {})).toThrow(/missing URL parameter/);
  });

  it("reads a chained source's body through a sources hole", () => {
    expect(
      expandUrl("https://x.com/{params.org}/{sources.orgs.0.uuid}", { org: "a/b" }, { orgs: [{ uuid: "u 1" }] })
    ).toBe("https://x.com/a%2Fb/u%201");
    expect(() => expandUrl("https://x.com/{sources.orgs.0.uuid}", {}, { orgs: [] })).toThrow(
      'hole "{sources.orgs.0.uuid}" did not resolve to a scalar'
    );
  });

  it("refuses a hole without a params. or sources. root", () => {
    expect(() => expandUrl("https://x.com/{handle}", { handle: "a" })).toThrow('must start with "params." or "sources."');
  });
});

describe("matchRequestPattern", () => {
  it("matches method + glob", () => {
    expect(
      matchRequestPattern(
        { method: "GET", url: "https://x.com/i/api/graphql/*/TweetDetail*" },
        "get",
        "https://x.com/i/api/graphql/abc123/TweetDetail?vars=1"
      )
    ).toBe(true);
  });

  it("rejects wrong method", () => {
    expect(matchRequestPattern({ method: "POST", url: "https://a.com/*" }, "GET", "https://a.com/x")).toBe(false);
  });
});
