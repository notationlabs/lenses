import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileLens,
  dom,
  expr,
  intercept,
  lens,
  llm,
  seconds,
  shape,
  stream,
  string,
  url,
} from "../src/index.js";
import { compilePattern, matchUrl } from "../src/url-pattern.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("schema builders", () => {
  it("shape emits a canonical object schema", () => {
    expect(shape({ a: string })).toEqual({
      type: "object",
      fields: { a: "string" },
    });
  });

  it("stream emits a canonical array schema", () => {
    expect(stream({ a: string })).toEqual({
      type: "array",
      items: { a: "string" },
    });
  });

  it("lens emits $lens refs, with and without target", () => {
    expect(lens("hn/item@v1")).toEqual({ $lens: "hn/item@v1" });
    expect(lens("hn/item@v1", expr("id"))).toEqual({
      $lens: "hn/item@v1",
      target: "id",
    });
  });

  it("seconds is an identity for cache TTLs", () => {
    expect(seconds(60)).toBe(60);
  });
});

describe("url tagged template", () => {
  it("turns interpolations into named holes", () => {
    const p = url`https://x.com/${"handle"}/status/${"id"}`;
    expect(p).toBe("https://x.com/{handle}/status/{id}");
  });

  it("passes literal text and trailing wildcard through", () => {
    expect(url`https://news.ycombinator.com/news*`).toBe(
      "https://news.ycombinator.com/news*"
    );
  });

  it("produces patterns url-pattern.ts accepts", () => {
    const p = url`https://x.com/${"handle"}/status/${"id"}`;
    const m = matchUrl([p], "https://x.com/jack/status/123");
    expect(m?.params).toEqual({ handle: "jack", id: "123" });
    // sanity: the pattern is a valid regex source
    expect(compilePattern(p)).toBeInstanceOf(RegExp);
  });
});

describe("resolver builders", () => {
  it("intercept single-request form", () => {
    expect(
      intercept({
        request: "GET https://api.example.com/x*",
        items: expr("things"),
        map: expr("{ 'a': name }"),
        detect: { needs_auth: expr("status = 401") },
      })
    ).toEqual({
      kind: "intercept",
      request: "GET https://api.example.com/x*",
      items: "things",
      map: "{ 'a': name }",
      detect: { needs_auth: "status = 401" },
    });
  });

  it("intercept sources + object-map fan-out form", () => {
    const r = intercept({
      sources: {
        usage: { request: "GET https://api.example.com/usage*" },
        plan: { request: "GET https://api.example.com/plan*", items: expr("plan") },
      },
      map: {
        plan: expr("$plan.name"),
        limits: expr("$usage.limits"),
      },
    });
    expect(r).toEqual({
      kind: "intercept",
      sources: {
        usage: { request: "GET https://api.example.com/usage*" },
        plan: { request: "GET https://api.example.com/plan*", items: "plan" },
      },
      map: { plan: "$plan.name", limits: "$usage.limits" },
    });
  });

  it("dom item/fields/post form", () => {
    expect(
      dom({
        item: ".athing",
        fields: { id: { selector: ":self", attr: "id" } },
        post: expr("{ 'x': $ }"),
      })
    ).toEqual({
      kind: "dom",
      item: ".athing",
      fields: { id: { selector: ":self", attr: "id" } },
      post: "{ 'x': $ }",
    });
  });

  it("llm prompt/maxSnapshotChars form", () => {
    expect(llm({ prompt: "extract", maxSnapshotChars: 100 })).toEqual({
      kind: "llm",
      prompt: "extract",
      maxSnapshotChars: 100,
    });
  });
});

describe("compileLens", () => {
  it("validates and returns canonical JSON", () => {
    const spec = compileLens({
      lens: "example/x",
      version: 1,
      accepts: [url`https://example.com/${"page"}`],
      effects: { reads: ["example.com"], writes: [] },
      resolve: [dom({ fields: { a: { selector: ".a" } } })],
    });
    expect(spec.accepts).toEqual(["https://example.com/{page}"]);
    expect(spec.lens).toBe("example/x");
  });
});

describe("hn.top round-trip", () => {
  it("compiling hn.top.ts is byte-identical to hn.top.json", async () => {
    const mod = await import("../../../lenses/hn.top.ts");
    const compiled = JSON.stringify(compileLens(mod.default), null, 2) + "\n";
    const onDisk = readFileSync(join(here, "../../../lenses/hn.top.json"), "utf8");
    expect(compiled).toBe(onDisk);
  });
});
