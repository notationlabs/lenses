import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LensResult, LensSpec } from "@djgrant/lens";
import {
  LensClient,
  LensOutcomeError,
  LensResultError,
  LensStore,
  type LensTransport,
  type LensTransportResult,
} from "../src/index.js";

class FakeTransport implements LensTransport {
  connected = true;
  info = "connected (test)";
  port = 4319;
  calls = 0;
  lastParams: Record<string, unknown> | undefined;
  lastAllowWrites: boolean | undefined;
  result: LensTransportResult = { kind: "value", value: { ok: true }, resolver: "dom" };

  async call(
    _spec: LensSpec,
    params: Record<string, unknown>,
    _timeoutMs?: number,
    allowWrites?: boolean
  ): Promise<LensResult> {
    this.calls++;
    this.lastParams = params;
    this.lastAllowWrites = allowWrites;
    return this.result;
  }

  async observe(): Promise<LensResult> {
    return { kind: "value", value: { requests: [] }, resolver: "dom" };
  }

  async waitForConnection(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

async function fixtureDirectory(
  parameterised = false,
  returns?: unknown,
  outcomes?: Record<string, unknown>
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lens-client-"));
  await writeFile(
    join(directory, "example.json"),
    JSON.stringify({
      name: "@example/web/page",
      url: parameterised ? "https://example.com/{page}" : "https://example.com/home",
      ...(parameterised ? { params: { page: "string" } } : {}),
      ...(returns !== undefined ? { returns } : {}),
      ...(outcomes !== undefined ? { outcomes } : {}),
      effects: { reads: ["example.com"], writes: [], cache: 60 },
      resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
    })
  );
  return directory;
}

const titledReturns = { type: "object", fields: { title: "string", score: "number" } };

describe("LensClient", () => {
  it("lists local lenses without exposing storage details", async () => {
    const client = new LensClient(new LensStore(await fixtureDirectory()), new FakeTransport());
    expect(await client.list()).toEqual([
      expect.objectContaining({
        name: "@example/web/page",
        shortname: "web/page",
        url: "https://example.com/home",
      }),
    ]);
  });

  // Undeclared outcomes are invisible in a listing whose whole outcome column
  // is derived from the declarations that are missing.
  it("warns in the listing when a detect names an undeclared outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lens-client-"));
    await writeFile(
      join(directory, "example.json"),
      JSON.stringify({
        name: "@example/web/page",
        url: "https://example.com/home",
        effects: { reads: ["example.com"], writes: [] },
        detect: { needs_auth: "$contains(url, '/sign-in')" },
        resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
      })
    );
    const client = new LensClient(new LensStore(directory), new FakeTransport());

    const [summary] = await client.list();
    expect(summary.outcomes).toEqual([]);
    expect(summary.warnings?.[0]).toContain(
      '"outcomes": { "needs_auth": { "hint": "<how to recover>" } }'
    );
  });

  it("leaves warnings off a listing with nothing to report", async () => {
    const client = new LensClient(new LensStore(await fixtureDirectory()), new FakeTransport());
    expect((await client.list())[0]).not.toHaveProperty("warnings");
  });

  it("owns call caching for every adapter", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);
    const input = { lens: "web/page" };

    expect(await client.call(input)).toMatchObject({ kind: "value" });
    expect(await client.call(input)).toMatchObject({ kind: "value", cached: true });
    expect(transport.calls).toBe(1);
  });

  it("passes allowWrites through to the broker call, defaulting absent", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    await client.call({ lens: "web/page", allowWrites: true });
    expect(transport.lastAllowWrites).toBe(true);

    // A fresh client so the cached first result cannot mask the second call.
    const bare = new LensClient(new LensStore(await fixtureDirectory()), transport);
    await bare.call({ lens: "web/page" });
    expect(transport.lastAllowWrites).toBeUndefined();
  });

  it("calls a fixed-URL lens without parameters", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    expect(await client.call({ lens: "web/page" })).toMatchObject({ kind: "value" });
    expect(transport.lastParams).toEqual({});
  });

  it("requires declared parameters", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory(true)), transport);

    expect(await client.call({ lens: "web/page" })).toEqual({
      kind: "error",
      message: 'missing parameter "page" for @example/web/page',
    });
    expect(transport.calls).toBe(0);
  });

  it("rejects undeclared parameters before asking the browser transport", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    expect(
      await client.call({ lens: "web/page", params: { other: "home" } })
    ).toMatchObject({ kind: "error" });
    expect(transport.calls).toBe(0);
  });

  it("does not cache partial values", async () => {
    const transport = new FakeTransport();
    transport.result = {
      kind: "value",
      value: { incomplete: true },
      resolver: "dom",
      partial: true,
    };
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);
    const input = { lens: "web/page" };

    await client.call(input);
    await client.call(input);
    expect(transport.calls).toBe(2);
  });

  it("does not extend the lifetime of a result cached by the broker", async () => {
    const transport = new FakeTransport();
    transport.result = {
      kind: "value",
      value: { cached: true },
      resolver: "dom",
      cached: true,
    };
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);
    const input = { lens: "web/page" };

    await client.call(input);
    await client.call(input);
    expect(transport.calls).toBe(2);
  });

  it("fails a result schema violation with a structured error by default", async () => {
    const transport = new FakeTransport();
    transport.result = { kind: "value", value: { title: 7, score: 3 }, resolver: "dom" };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    expect(await client.call({ lens: "web/page" })).toEqual({
      kind: "error",
      message: "@example/web/page result failed its schema at /title",
      issues: [{ path: "/title", message: "Invalid input: expected string, received number" }],
    });
  });

  it("names a missing required field at its JSON pointer", async () => {
    const transport = new FakeTransport();
    transport.result = { kind: "value", value: { title: "Home" }, resolver: "dom" };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    expect(await client.call({ lens: "web/page" })).toMatchObject({
      kind: "error",
      issues: [{ path: "/score", message: "Invalid input: expected number, received undefined" }],
    });
  });

  // The cost of omitting this was a debugging cycle: a signed-out redirect
  // fails every field and reads exactly like a broken selector.
  it("names the URL the value was read from in a schema failure", async () => {
    const transport = new FakeTransport();
    transport.result = {
      kind: "value",
      value: { title: "Sign in" },
      resolver: "dom",
      observed: "https://example.com/sign-in",
    };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    expect(await client.call({ lens: "web/page" })).toMatchObject({
      kind: "error",
      message:
        "@example/web/page: no resolver produced field /score (read from https://example.com/sign-in)",
    });
  });

  it("demotes result schema violations to warnings when strict is off", async () => {
    const transport = new FakeTransport();
    transport.result = { kind: "value", value: { title: "Home" }, resolver: "dom" };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    expect(await client.call({ lens: "web/page", strict: false })).toMatchObject({
      kind: "value",
      value: { title: "Home" },
      warnings: [{ path: "/score", message: "Invalid input: expected number, received undefined" }],
    });
  });

  it("returns conforming values untouched", async () => {
    const transport = new FakeTransport();
    transport.result = { kind: "value", value: { title: "Home", score: 3 }, resolver: "dom" };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    const result = await client.call({ lens: "web/page" });
    expect(result).toMatchObject({ kind: "value" });
    expect(result).not.toHaveProperty("warnings");
  });

  it("derives a JSON Schema from a lens's returns declaration", async () => {
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      new FakeTransport()
    );

    expect(await client.schema("web/page")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "@example/web/page",
      type: "object",
      required: ["title", "score"],
    });
  });

  it("unwraps a value result via value()", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    expect(await client.value({ lens: "web/page" })).toEqual({ ok: true });
  });

  it("throws a LensOutcomeError carrying the declared hint", async () => {
    const transport = new FakeTransport();
    transport.result = {
      kind: "outcome",
      name: "needs_auth",
      value: { $lens: "@example/web/login" },
      resolver: "dom",
    };
    const client = new LensClient(
      new LensStore(
        await fixtureDirectory(false, undefined, {
          needs_auth: { $lens: "@example/web/login", hint: "Sign in, then retry." },
        })
      ),
      transport
    );

    const thrown = await client.value({ lens: "web/page" }).catch((error) => error);
    expect(thrown).toBeInstanceOf(LensOutcomeError);
    expect(thrown).toMatchObject({
      outcome: "needs_auth",
      value: { $lens: "@example/web/login" },
      hint: "Sign in, then retry.",
      message: 'lens outcome "needs_auth": Sign in, then retry.',
    });
  });

  it("throws a LensResultError preserving schema issues", async () => {
    const transport = new FakeTransport();
    transport.result = { kind: "value", value: { title: 7, score: 3 }, resolver: "dom" };
    const client = new LensClient(
      new LensStore(await fixtureDirectory(false, titledReturns)),
      transport
    );

    const thrown = await client.value({ lens: "web/page" }).catch((error) => error);
    expect(thrown).toBeInstanceOf(LensResultError);
    expect(thrown).toMatchObject({
      message: "@example/web/page result failed its schema at /title",
      issues: [{ path: "/title", message: "Invalid input: expected string, received number" }],
    });
  });

  describe("{$lens} parameter defaults", () => {
    /** Routes canned results per lens name; records the order of engine calls. */
    class RoutingTransport extends FakeTransport {
      named: string[] = [];
      results: Record<string, LensTransportResult> = {};

      override async call(spec: LensSpec, params: Record<string, unknown>): Promise<LensResult> {
        this.named.push(spec.name);
        this.lastParams = params;
        return this.results[spec.name] ?? { kind: "value", value: {}, resolver: "dom" };
      }
    }

    const summarySpec = {
      name: "@example/hmrc/summary",
      url: "https://example.com/summary",
      returns: { type: "object", fields: { vrn: "string" } },
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "dom", fields: { vrn: { selector: ".vrn" } } }],
    };

    const vatSpec = (param: unknown) => ({
      name: "@example/hmrc/vat",
      url: "https://example.com/vat/{vrn}",
      params: { vrn: param },
      returns: { type: "object", fields: { total: "number" } },
      effects: { reads: ["example.com"], writes: [] },
      resolve: [{ kind: "dom", fields: { total: { selector: ".total" } } }],
    });

    const refDefault = { $lens: "@example/hmrc/summary", field: "vrn" };

    async function catalogDirectory(...specs: object[]): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), "lens-client-"));
      await Promise.all(
        specs.map((spec, index) =>
          writeFile(join(directory, `lens-${index}.json`), JSON.stringify(spec))
        )
      );
      return directory;
    }

    async function catalog(
      ...specs: object[]
    ): Promise<{ client: LensClient; transport: RoutingTransport }> {
      const transport = new RoutingTransport();
      const client = new LensClient(new LensStore(await catalogDirectory(...specs)), transport);
      return { client, transport };
    }

    it("fills an omitted param by calling the target lens and projecting the field", async () => {
      const { client, transport } = await catalog(summarySpec, vatSpec({ type: "string", default: refDefault }));
      transport.results["@example/hmrc/summary"] = {
        kind: "value",
        value: { vrn: "GB123" },
        resolver: "dom",
      };
      transport.results["@example/hmrc/vat"] = {
        kind: "value",
        value: { total: 42 },
        resolver: "dom",
      };

      expect(await client.call({ lens: "hmrc/vat" })).toMatchObject({
        kind: "value",
        value: { total: 42 },
      });
      expect(transport.named).toEqual(["@example/hmrc/summary", "@example/hmrc/vat"]);
      expect(transport.lastParams).toEqual({ vrn: "GB123" });
    });

    it("skips the default call when the caller supplies the param", async () => {
      const { client, transport } = await catalog(summarySpec, vatSpec({ type: "string", default: refDefault }));
      transport.results["@example/hmrc/vat"] = {
        kind: "value",
        value: { total: 42 },
        resolver: "dom",
      };

      await client.call({ lens: "hmrc/vat", params: { vrn: "GB9" } });
      expect(transport.named).toEqual(["@example/hmrc/vat"]);
    });

    it("fails the outer call naming the param and target when the target errors", async () => {
      const { client, transport } = await catalog(summarySpec, vatSpec({ type: "string", default: refDefault }));
      transport.results["@example/hmrc/summary"] = { kind: "error", message: "boom" };

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message: 'default for "vrn" via @example/hmrc/summary: boom',
      });
    });

    it("fails the outer call when the target returns an outcome", async () => {
      const { client, transport } = await catalog(summarySpec, vatSpec({ type: "string", default: refDefault }));
      transport.results["@example/hmrc/summary"] = {
        kind: "outcome",
        name: "needs_auth",
        value: null,
        resolver: "dom",
      };

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message: 'default for "vrn" via @example/hmrc/summary: returned outcome "needs_auth"',
      });
    });

    it("fails the outer call when the target result is partial", async () => {
      const { client, transport } = await catalog(summarySpec, vatSpec({ type: "string", default: refDefault }));
      transport.results["@example/hmrc/summary"] = {
        kind: "value",
        value: { vrn: "GB123" },
        resolver: "dom",
        partial: true,
      };

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message: 'default for "vrn" via @example/hmrc/summary: returned a partial result',
      });
    });

    // An authoring mistake fails before spending a browser call.
    it("rejects a ref default whose target field disagrees with the param type", async () => {
      const { client, transport } = await catalog(
        summarySpec,
        vatSpec({ type: "integer", default: refDefault })
      );

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message:
          'default for "vrn" via @example/hmrc/summary: field "vrn" of @example/hmrc/summary is not a non-nullable integer',
      });
      expect(transport.named).toEqual([]);
    });

    it("rejects a ref default naming a field the target does not declare", async () => {
      const { client, transport } = await catalog(
        summarySpec,
        vatSpec({ type: "string", default: { $lens: "@example/hmrc/summary", field: "vat_number" } })
      );

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message:
          'default for "vrn" via @example/hmrc/summary: @example/hmrc/summary does not declare a top-level "vat_number" field in its returns',
      });
      expect(transport.named).toEqual([]);
    });

    it("re-checks enum membership on the projected value", async () => {
      const { client, transport } = await catalog(
        summarySpec,
        vatSpec({ type: "string", enum: ["GB1", "GB2"], default: refDefault })
      );
      transport.results["@example/hmrc/summary"] = {
        kind: "value",
        value: { vrn: "GB123" },
        resolver: "dom",
      };

      expect(await client.call({ lens: "hmrc/vat" })).toEqual({
        kind: "error",
        message: 'parameter "vrn" for @example/hmrc/vat must be one of: GB1, GB2',
      });
    });

    it("rejects a lens whose default chain re-enters itself", async () => {
      const selfSpec = {
        name: "@example/web/self",
        url: "https://example.com/{x}",
        params: { x: { type: "string", default: { $lens: "@example/web/self", field: "x" } } },
        returns: { type: "object", fields: { x: "string" } },
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { x: { selector: ".x" } } }],
      };
      const { client } = await catalog(selfSpec);

      expect(await client.call({ lens: "web/self" })).toMatchObject({
        kind: "error",
        message: expect.stringContaining("circular parameter default: @example/web/self"),
      });
    });

    it("caps how deep a default chain may recurse", async () => {
      const chain = [0, 1, 2, 3, 4, 5].map((step) => ({
        name: `@example/web/step${step}`,
        url: `https://example.com/step${step}/{x}`,
        params: {
          x:
            step === 5
              ? { type: "string", default: "leaf" }
              : { type: "string", default: { $lens: `@example/web/step${step + 1}`, field: "x" } },
        },
        returns: { type: "object", fields: { x: "string" } },
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { x: { selector: ".x" } } }],
      }));
      const { client, transport } = await catalog(...chain);
      for (const spec of chain) {
        transport.results[spec.name] = { kind: "value", value: { x: "leaf" }, resolver: "dom" };
      }

      expect(await client.call({ lens: "web/step0" })).toMatchObject({
        kind: "error",
        message: expect.stringContaining("parameter default chain exceeds depth 4"),
      });
    });
  });

  it("reports lens resolution and call parameters", async () => {
    const messages: string[] = [];
    const client = new LensClient(
      new LensStore(await fixtureDirectory()),
      new FakeTransport(),
      (message) => messages.push(message)
    );

    await client.call({
      lens: "web/page",
    });

    expect(messages).toEqual([
      "resolving lens web/page",
      "resolved @example/web/page to https://example.com/home",
      "calling @example/web/page; params: none",
    ]);
  });
});
