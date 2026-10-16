import { describe, expect, it } from "vitest";
import { executeLens } from "../src/engine.js";
import { evaluate } from "../src/expr.js";
import { checkExpression, checkTemplate, type ExprSite } from "../src/expr-check.js";
import type { EngineIO, InterceptedResponse } from "../src/types.js";
import { validateExceptions, validateSpec } from "../src/validate.js";

/**
 * The expression language: no implicit input, every path rooted at a named
 * variable, a fixed set of variables per site, objects for structure, and
 * rooted template holes.
 */

const site: ExprSite = { label: "map", vars: ["value", "params"], params: ["id"], helpers: ["money", "has"] };
const check = (expr: string, at: ExprSite = site) => checkExpression(expr, at);

describe("the top-level path rule", () => {
  it.each([
    "$value",
    "$value.title",
    "$value[0]",
    "$value[$has(date)]",
    "[$value[$has(date)].{ 'date': date }]",
    "$value.(a & b)",
    "$value.a[b > 1].c",
    "$value.$string(a)",
    "$value^(>a).b",
    "$value{ type: $sum(amount) }",
    "$value#$i[$i > 0].a",
    "$value@$v.a",
    "$value.*",
    "$value.**.a",
    "$value[$.outstanding != 0]",
    "$map($value, function($r) { $r.a })",
    "$filter($value.rows, function($r) { $r.a > 1 })",
    "$value ~> $map(function($v) { $v.a })",
    "($a := $value.b; $a.c)",
    "$exists($value) ? $value.a : null",
    "{ 'a': $value.a, 'b': [$value.b.{ 'c': c }] }",
    "$money($value.raw)",
    "$params.id & '-' & $string($value.n)",
    "'literal'",
    "{ 'k': true, 'n': 1 }",
  ])("accepts %s", (expr) => {
    expect(check(expr)).toBeUndefined();
  });

  it.each([
    ["content", 'path "content" must start at a variable'],
    ["a.b", 'path "a.b" must start at a variable'],
    ["$.content", '"$" has no input'],
    ["$", '"$" has no input'],
    ["$[0]", '"$" has no input'],
    ["$string($)", '"$" has no input'],
    ["$$", '"$$" has no input'],
    ["$$.a", '"$$" has no input'],
    ["*", '"*" must follow a variable-rooted step'],
    ["**.a", '"**" must follow a variable-rooted step'],
    ["$exists(a)", 'path "a" must start at a variable'],
    ["[a]", 'path "a" must start at a variable'],
    ["{ 'a': b }", 'path "b" must start at a variable'],
    ["$value ? a : null", 'path "a" must start at a variable'],
    ["-a", 'path "a" must start at a variable'],
    ["$value.a and b", 'path "b" must start at a variable'],
    ["($x := a; $x)", 'path "a" must start at a variable'],
    // a lambda closes over the (absent) input where it is defined
    ["$map($value, function($v) { a })", 'path "a" must start at a variable'],
  ])("rejects %s", (expr, message) => {
    expect(check(expr)).toContain(message);
  });

  it("names the variables in scope in the error", () => {
    expect(check("title")).toBe(
      'map: path "title" must start at a variable ($value, $params); expressions have no implicit input'
    );
  });
});

describe("variables", () => {
  it("accepts builtins, helpers, locals and lambda arguments", () => {
    expect(check("$count($value)")).toBeUndefined();
    expect(check("$money($value)")).toBeUndefined();
    expect(check("($n := 1; $n + $count($value))")).toBeUndefined();
    expect(check("$map($value, function($row, $i) { $i })")).toBeUndefined();
  });

  it("points a bare parameter variable at $params", () => {
    expect(check("$id")).toBe('map: variable "$id" is not defined; read the call parameter as $params.id');
  });

  it("points a bare source variable at $sources", () => {
    expect(check("$csrf", { label: "body", vars: ["sources", "params"], sources: ["csrf"] })).toContain(
      "read the source as $sources.csrf.body"
    );
  });

  it("rejects an unknown variable", () => {
    expect(check("$nope")).toContain('variable "$nope" is not defined');
  });

  it("rejects a reserved variable the site does not bind", () => {
    expect(check("$res.a")).toBe("map: $res is not available here; in scope: $value, $params");
  });

  it("rejects a $params or $sources field that is not declared", () => {
    expect(check("$params.nope")).toBe("map: $params.nope names no declared parameter");
    expect(check("$sources.later.body.a", { label: "items", vars: ["sources"], sources: [], allSources: ["later"] }))
      .toContain("not available yet");
  });

  it("evaluates with no input, so a bare path yields nothing at runtime", async () => {
    expect(await evaluate("title", { res: { body: { title: "x" } } })).toBeUndefined();
    expect(await evaluate("$res.body.title", { res: { body: { title: "x" } } })).toBe("x");
  });
});

describe("template holes", () => {
  const at = { label: "url", params: ["id", "year"] };
  it("accepts rooted holes", () => {
    expect(checkTemplate("https://x.com/{params.id}", at)).toBeUndefined();
    expect(checkTemplate("https://x.com/{sources.orgs.body.0.uuid}", { ...at, sources: ["orgs"] })).toBeUndefined();
  });
  it("rejects a bare hole, suggesting its root", () => {
    expect(checkTemplate("https://x.com/{id}", at)).toBe('url: hole "{id}" must name its root; write "{params.id}"');
    expect(checkTemplate("https://x.com/{orgs.0.uuid}", { ...at, sources: [], allSources: ["orgs"] }))
      .toContain('write "{sources.orgs.0.uuid}"');
  });
  it("rejects an unknown root, an undeclared param, and a path into a param", () => {
    expect(checkTemplate("{foo.bar}", at)).toBe('url: hole "{foo.bar}" must start with "params."');
    expect(checkTemplate("{params.nope}", at)).toContain('parameter "nope" in "{params.nope}" is not declared');
    expect(checkTemplate("{params.id.x}", at)).toContain("parameters are scalars");
  });
  it("rejects sources holes where no sources are in scope", () => {
    expect(checkTemplate("{sources.a}", at)).toContain("sources are not in scope here");
  });
});

const base = {
  name: "@example/web/thing",
  url: "https://example.com/{params.id}",
  params: { id: "string" },
  effects: { reads: ["example.com"], writes: [] },
};
const writes = { reads: ["example.com"], writes: ["example.com"] };
const valid = (extra: Record<string, unknown>) => () => validateSpec({ ...base, ...extra });

describe("variables in scope per site", () => {
  const dom = (extra: Record<string, unknown>) => ({ resolve: [{ kind: "dom", ...extra }] });
  const http = (extra: Record<string, unknown>) => ({
    resolve: [{ kind: "http", request: { method: "GET", url: "https://api.example.com" }, ...extra }],
  });
  const sources = (extra: Record<string, unknown>, first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) => ({
    effects: writes,
    resolve: [{
      kind: "http",
      sources: {
        first: { request: { method: "GET", url: "https://api.example.com/1" }, ...first },
        second: { request: { method: "POST", url: "https://api.example.com/2" }, ...second },
      },
      ...extra,
    }],
  });
  const intercept = (extra: Record<string, unknown>) => ({
    resolve: [{
      kind: "intercept",
      sources: { a: { request: { method: "GET", url: "https://api.example.com/a" }, ...extra } },
    }],
  });

  it.each([
    ["dom post", dom({ post: "{ 'v': $value.a, 'p': $params.id }" })],
    ["dom tier exception", dom({ exceptions: { x: { matches: "$contains($page.url, 'a') and $value.h" } } })],
    ["document exception", { ...dom({}), exceptions: { x: { matches: "$contains($page.title, 'a') or $res.status = 401" } } }],
    ["http items", http({ items: "$res.body.rows[$params.id = id]" })],
    ["http map with items", http({ items: "$res.body.rows", map: { a: "$item.a", total: "$res.body.total" } })],
    ["http map without items", http({ map: { a: "$res.body.a" } })],
    ["http tier exception", http({ exceptions: { x: { matches: "$res.status = 404 and $res.body.error" } } })],
    ["http body", { effects: writes, resolve: [{ kind: "http", request: { method: "POST", url: "https://a.com" }, body: { json: "{ 'id': $params.id }" } }] }],
    ["sources map", sources({ map: { a: "$sources.first.body.a", b: "$sources.second.body" } })],
    ["sources tier exception", sources({ exceptions: { x: { matches: "$sources.second.status >= 400" } } })],
    ["source items", sources({}, {}, { items: "$res.body.token & $sources.first.body.id" })],
    ["source headers", sources({}, {}, { headers: { "X-Token": "$sources.first.body.token" } })],
    ["source body", sources({}, {}, { body: { search: { token: "$sources.first.body.token", id: "$params.id" } } })],
    ["source request hole", sources({}, {}, { request: { method: "POST", url: "https://a.com/{sources.first.body.0.uuid}" } })],
    ["intercept source items", intercept({ items: "$res.body.rows" })],
    ["perform value", { effects: writes, perform: [{ fill: "#a", value: "$params.id" }], ...dom({}) }],
    ["returns $lens params", {
      ...dom({}),
      returns: { type: "object", fields: { next: { $lens: "@example/web/thing", params: { id: "$item.next & $params.id" } } } },
    }],
  ])("accepts its own variables in %s", (_, extra) => {
    expect(valid(extra)).not.toThrow();
  });

  it.each([
    ["dom post", dom({ post: "$res.a" }), "$res is not available here; in scope: $value, $params"],
    ["dom post $item", dom({ post: "$item" }), "$item is not available here"],
    ["dom tier exception", dom({ exceptions: { x: { matches: "$res.status = 401" } } }), "in scope: $page, $value, $params"],
    ["document exception", { ...dom({}), exceptions: { x: { matches: "$value.h" } } }, "in scope: $page, $res, $params"],
    ["http items", http({ items: "$item" }), "in scope: $res, $params"],
    ["http map without items", http({ map: { a: "$item.a" } }), "$item is not available here"],
    ["http tier exception", http({ exceptions: { x: { matches: "$page.url" } } }), "$page is not available here"],
    ["http body", { effects: writes, resolve: [{ kind: "http", request: { method: "POST", url: "https://a.com" }, body: { text: "$res" } }] }, "$res is not available"],
    ["sources map", sources({ map: { a: "$res.a" } }), "in scope: $sources, $params"],
    ["sources tier exception", sources({ exceptions: { x: { matches: "$res.status" } } }), "in scope: $sources, $params"],
    ["source items reading a later source", sources({}, { items: "$sources.second" }), "$sources.second is not available yet"],
    ["source headers", sources({}, {}, { headers: { "X-Token": "$res.token" } }), "$res is not available"],
    ["source request hole to a later source", sources({}, { request: { method: "GET", url: "https://a.com/{sources.second}" } }), "reads a source declared after this one"],
    ["intercept source items", intercept({ items: "$sources.b" }), "$sources is not available"],
    ["perform value", { effects: writes, perform: [{ fill: "#a", value: "$page.url" }], ...dom({}) }, "$page is not available"],
    ["returns $lens params", {
      ...dom({}),
      returns: { type: "object", fields: { next: { $lens: "@example/web/thing", params: { id: "$value.id" } } } },
    }, "in scope: $item, $params"],
  ])("rejects a foreign variable in %s", (_, extra, message) => {
    expect(valid(extra)).toThrow(message);
  });

  it("checks catalog scope exceptions as document exceptions", () => {
    expect(() => validateExceptions({ needs_auth: { matches: "$contains($page.url, '/login') or $res.status = 401" } }))
      .not.toThrow();
    expect(() => validateExceptions({ needs_auth: { matches: "$contains(url, '/login')" } }))
      .toThrow('path "url" must start at a variable ($page, $res, $params)');
  });

  it("rejects a helper with a reserved name or a bare path in its body", () => {
    expect(valid({ helpers: { item: "function($x) { $x }" }, ...dom({}) })).toThrow('helper "item" takes a reserved variable name');
    expect(valid({ helpers: { f: "function($x) { x }" }, ...dom({}) })).toThrow('helpers.f: path "x" must start at a variable');
  });
});

describe("structure is objects, not strings", () => {
  const httpWith = (request: unknown, extra: Record<string, unknown> = {}) =>
    valid({ resolve: [{ kind: "http", request, ...extra }] });

  it("takes a request as {method, url}", () => {
    expect(httpWith({ method: "GET", url: "https://a.com/{params.id}" })).not.toThrow();
    expect(httpWith({ method: "GET", url: "https://a.com/{params.id}" }, { items: "$res" })).not.toThrow();
  });

  it('rejects the "METHOD url" string form with a migration hint', () => {
    expect(httpWith("GET https://a.com/{id}")).toThrow(
      'at /resolve/0/request: must be an object {"method": "GET", "url": "https://…/{params.id}"}; the "METHOD url" string form is removed'
    );
    expect(valid({ resolve: [{ kind: "intercept", sources: { a: { request: "GET https://a.com/*" } } }] }))
      .toThrow("/resolve/0/sources/a/request: must be an object");
  });

  it("requires a method and rejects unknown request keys", () => {
    expect(httpWith({ url: "https://a.com" })).toThrow("/resolve/0/request/method");
    expect(httpWith({ method: "GET", url: "https://a.com", body: "x" })).toThrow("/resolve/0/request");
    expect(httpWith({ method: "GET /x", url: "https://a.com" })).toThrow("must be an HTTP method");
  });

  it("treats a non-GET request object as a write", () => {
    expect(valid({ resolve: [{ kind: "http", request: { method: "post", url: "https://a.com" } }] }))
      .toThrow(/effects\.writes/);
  });

  it("accepts nested map objects and checks every leaf", () => {
    const nested = {
      resolve: [{
        kind: "http",
        request: { method: "GET", url: "https://a.com" },
        items: "$res.body.rows",
        map: { id: "$item.id", balance: { value: "$item.balance.value", currency: "'GBP'" } },
      }],
    };
    expect(valid(nested)).not.toThrow();
    const bad = structuredClone(nested);
    (bad.resolve[0].map.balance as Record<string, string>).value = "balance.value";
    expect(valid(bad)).toThrow('resolve[0].map.balance.value: path "balance.value" must start at a variable');
  });

  it("rejects resolver-level items alongside sources", () => {
    expect(valid({
      resolve: [{ kind: "intercept", items: "$res.body", sources: { a: { request: { method: "GET", url: "https://a.com" } } } }],
    })).toThrow('"items" belongs on each source');
  });
});

function io(overrides: Partial<EngineIO>): EngineIO {
  return {
    getIntercepted: async () => [],
    domExtract: async () => ({ url: "https://example.com", title: "t", value: null }),
    snapshot: async () => ({ url: "", title: "", text: "" }),
    sleep: async () => {},
    ...overrides,
  };
}
const reply = (body: unknown, over: Partial<InterceptedResponse> = {}): InterceptedResponse => ({
  url: "https://api.example.com/rows",
  method: "GET",
  status: 200,
  body: JSON.stringify(body),
  timestamp: 0,
  ...over,
});

describe("runtime bindings", () => {
  const intercept = (extra: Record<string, unknown>) => validateSpec({
    ...base,
    resolve: [{ kind: "intercept", request: { method: "GET", url: "https://api.example.com/rows" }, ...extra }],
  });

  it("binds $item per row and keeps $res.body as the whole reply", async () => {
    const spec = intercept({
      items: "$res.body.rows",
      map: { id: "$item.id", of: "$res.body.total", who: "$params.id", nested: { v: "$item.v", none: "$item.missing" } },
    });
    const r = await executeLens(spec, { id: "me" }, io({
      getIntercepted: async () => [reply({ total: 2, rows: [{ id: 1, v: "a" }, { id: 2, v: "b" }] })],
    }));
    expect(r).toMatchObject({
      kind: "value",
      value: [
        { id: 1, of: 2, who: "me", nested: { v: "a" } },
        { id: 2, of: 2, who: "me", nested: { v: "b" } },
      ],
    });
    if (r.kind === "value") expect((r.value as object[])[0]).toEqual({ id: 1, of: 2, who: "me", nested: { v: "a" } });
  });

  it("binds $item to a single selected value without wrapping it", async () => {
    const r = await executeLens(intercept({ items: "$res.body.row", map: { id: "$item.id" } }), { id: "x" }, io({
      getIntercepted: async () => [reply({ row: { id: 7 } })],
    }));
    expect(r).toMatchObject({ kind: "value", value: { id: 7 } });
  });

  it("maps a reply without items once, even when it is an array", async () => {
    const r = await executeLens(intercept({ map: { count: "$count($res.body)" } }), { id: "x" }, io({
      getIntercepted: async () => [reply([{ id: 1 }, { id: 2 }])],
    }));
    expect(r).toMatchObject({ kind: "value", value: { count: 2 } });
  });

  it("gives a tier's exceptions the response envelope as $res.body", async () => {
    const spec = intercept({
      items: "$res.body.rows",
      exceptions: { gone: { matches: "$res.status = 200 and $res.body.deleted and $contains($res.url, '/rows')" } },
    });
    const r = await executeLens(spec, { id: "x" }, io({
      getIntercepted: async () => [reply({ deleted: true, rows: [] })],
    }));
    expect(r).toMatchObject({ kind: "outcome", name: "gone" });
  });

  it("gives a dom tier's exceptions $page and $value, and its post $value", async () => {
    const spec = validateSpec({
      ...base,
      resolve: [{
        kind: "dom",
        fields: { h: { selector: "h1" } },
        exceptions: { blocked: { matches: "$page.title = 'Bank' and $value.h = 'Locked'" } },
        post: "{ 'heading': $value.h, 'id': $params.id }",
      }],
    });
    const at = (h: string) => io({ domExtract: async () => ({ url: "https://example.com/x", title: "Bank", value: { h } }) });
    expect(await executeLens(spec, { id: "x" }, at("Locked"))).toMatchObject({ kind: "outcome", name: "blocked" });
    expect(await executeLens(spec, { id: "x" }, at("Hi"))).toMatchObject({ kind: "value", value: { heading: "Hi", id: "x" } });
  });

  it("threads $sources through items, headers, bodies, holes and map", async () => {
    const spec = validateSpec({
      ...base,
      effects: writes,
      resolve: [{
        kind: "http",
        sources: {
          page: { request: { method: "GET", url: "https://a.com/{params.id}" }, items: "$match($res.body, /token=(\\w+)/).groups[0]" },
          orgs: { request: { method: "GET", url: "https://a.com/orgs" } },
          saved: {
            request: { method: "POST", url: "https://a.com/orgs/{sources.orgs.body.0.uuid}" },
            headers: { "X-Token": "$sources.page.body" },
            body: { search: { token: "$sources.page.body", id: "$params.id" } },
            items: "$res.body.ok and $sources.page.body = 'abc'",
          },
        },
        map: { saved: "$sources.saved.body", org: "$sources.orgs.body[0].uuid" },
      }],
    });
    const requests: unknown[] = [];
    const r = await executeLens(spec, { id: "me" }, io({
      httpFetch: async (request) => {
        requests.push(request);
        const body = request.url.endsWith("/me") ? "x token=abc y" : request.url.endsWith("/orgs") ? '[{"uuid":"u1"}]' : '{"ok":true}';
        return { url: request.url, method: request.method, status: 200, body, timestamp: 0 };
      },
    }));
    expect(r).toMatchObject({ kind: "value", value: { saved: true, org: "u1" } });
    expect(requests[2]).toMatchObject({
      method: "POST",
      url: "https://a.com/orgs/u1",
      headers: { "X-Token": "abc" },
      body: { kind: "search", entries: [["token", "abc"], ["id", "me"]] },
    });
  });

  it("gives a sources tier's exceptions each arrived envelope under $sources", async () => {
    const spec = validateSpec({
      ...base,
      resolve: [{
        kind: "http",
        sources: {
          a: { request: { method: "GET", url: "https://a.com/a" } },
          b: { request: { method: "GET", url: "https://a.com/b" } },
        },
        exceptions: { refused: { matches: "$sources.a.status = 200 and $sources.a.body.refused" } },
      }],
    });
    const urls: string[] = [];
    const r = await executeLens(spec, { id: "x" }, io({
      httpFetch: async (request) => {
        urls.push(request.url);
        return { url: request.url, method: "GET", status: 200, body: '{"refused":true}', timestamp: 0 };
      },
    }));
    expect(r).toMatchObject({ kind: "outcome", name: "refused" });
    expect(urls).toEqual(["https://a.com/a"]);
  });
});
