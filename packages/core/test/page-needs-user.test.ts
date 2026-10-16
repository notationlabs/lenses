import { describe, expect, it } from "vitest";
import { pageNeedsUser } from "../src/resolvers/outcome.js";
import { validateSpec } from "../src/validate.js";

describe("pageNeedsUser", () => {
  const spec = validateSpec({
    name: "@example/bank/summary",
    url: "https://bank.example/summary",
    exceptions: {
      needs_auth: { matches: "$contains(url, '/login')" },
      rate_limited: { matches: "title = 'Slow down'" },
    },
    effects: { reads: ["bank.example"], writes: [] },
    resolve: [{ kind: "dom", fields: { h: { selector: "h1" } } }],
  });
  it("holds only on needs_* pages", async () => {
    expect(await pageNeedsUser(spec, { url: "https://bank.example/login/step-2", title: "" }, {})).toBe(true);
    expect(await pageNeedsUser(spec, { url: "https://bank.example/other", title: "Slow down" }, {})).toBe(false);
    expect(await pageNeedsUser(spec, { url: "https://bank.example/summary", title: "" }, {})).toBe(false);
  });
});
