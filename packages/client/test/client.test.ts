import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LensResult, LensSpec } from "@djgrant/lens";
import { LensClient, LensStore, type LensTransport } from "../src/index.js";

class FakeTransport implements LensTransport {
  connected = true;
  info = "connected (test)";
  port = 4319;
  calls = 0;
  lastTarget: string | undefined;
  result: LensResult = { kind: "value", value: { ok: true }, resolver: "dom" };

  async call(_spec: LensSpec, target: string): Promise<LensResult> {
    this.calls++;
    this.lastTarget = target;
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

async function fixtureDirectory(defaultTarget: string | null = "https://example.com/home"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lens-client-"));
  await writeFile(
    join(directory, "example.json"),
    JSON.stringify({
      lens: "example/page",
      version: 1,
      accepts: ["https://example.com/*"],
      ...(defaultTarget ? { defaultTarget } : {}),
      effects: { reads: ["example.com"], writes: [], cache: 60 },
      resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
    })
  );
  return directory;
}

describe("LensClient", () => {
  it("lists local lenses without exposing storage details", async () => {
    const client = new LensClient(new LensStore(await fixtureDirectory()), new FakeTransport());
    expect(await client.list()).toEqual([
      expect.objectContaining({
        lens: "example/page@v1",
        accepts: ["https://example.com/*"],
        defaultTarget: "https://example.com/home",
      }),
    ]);
  });

  it("owns call caching for every adapter", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);
    const input = { lens: "example/page", target: "https://example.com/home" };

    expect(await client.call(input)).toMatchObject({ kind: "value" });
    expect(await client.call(input)).toMatchObject({ kind: "value", cached: true });
    expect(transport.calls).toBe(1);
  });

  it("uses a declared default target when the caller omits one", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    expect(await client.call({ lens: "example/page" })).toMatchObject({ kind: "value" });
    expect(transport.lastTarget).toBe("https://example.com/home");
  });

  it("requires a target when the lens has no default", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory(null)), transport);

    expect(await client.call({ lens: "example/page" })).toEqual({
      kind: "error",
      message: "example/page@v1 requires a target URL",
    });
    expect(transport.calls).toBe(0);
  });

  it("rejects targets before asking the browser transport", async () => {
    const transport = new FakeTransport();
    const client = new LensClient(new LensStore(await fixtureDirectory()), transport);

    expect(
      await client.call({ lens: "example/page", target: "https://other.example/home" })
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
    const input = { lens: "example/page", target: "https://example.com/home" };

    await client.call(input);
    await client.call(input);
    expect(transport.calls).toBe(2);
  });

  it("reports lens resolution and call arguments", async () => {
    const messages: string[] = [];
    const client = new LensClient(
      new LensStore(await fixtureDirectory()),
      new FakeTransport(),
      (message) => messages.push(message)
    );

    await client.call({
      lens: "example/page",
      target: "https://example.com/home",
      args: { limit: 10 },
    });

    expect(messages).toEqual([
      "resolving lens example/page",
      "resolved example/page@v1 for https://example.com/home",
      "calling example/page@v1; args: limit",
    ]);
  });
});
