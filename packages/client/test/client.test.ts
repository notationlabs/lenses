import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LensResult, LensSpec } from "@djgrant/lens";
import {
  LensClient,
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
  result: LensTransportResult = { kind: "value", value: { ok: true }, resolver: "dom" };

  async call(_spec: LensSpec, params: Record<string, unknown>): Promise<LensResult> {
    this.calls++;
    this.lastParams = params;
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

async function fixtureDirectory(parameterised = false, returns?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lens-client-"));
  await writeFile(
    join(directory, "example.json"),
    JSON.stringify({
      name: "@example/web/page",
      url: parameterised ? "https://example.com/{page}" : "https://example.com/home",
      ...(parameterised ? { params: { page: "string" } } : {}),
      ...(returns !== undefined ? { returns } : {}),
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

  it("owns call caching for every adapter", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);
    const input = { lens: "web/page" };

    expect(await client.call(input)).toMatchObject({ kind: "value" });
    expect(await client.call(input)).toMatchObject({ kind: "value", cached: true });
    expect(transport.calls).toBe(1);
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
