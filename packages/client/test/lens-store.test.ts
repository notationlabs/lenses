import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LensStore, parseCatalogSource } from "../src/index.js";

async function catalogDirectory(lenses: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lens-store-"));
  for (const [file, name] of Object.entries(lenses)) {
    await writeFile(
      join(directory, file),
      JSON.stringify({
        name,
        url: "https://example.com/home",
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
      })
    );
  }
  return directory;
}

describe("LensStore", () => {
  it("merges sources in order and resolves contested shortnames to the earliest", async () => {
    const first = await catalogDirectory({ "a.json": "@one/web/page" });
    const second = await catalogDirectory({ "b.json": "@two/web/page" });
    const store = new LensStore([first, second]);

    expect((await store.load()).map((spec) => spec.name)).toEqual([
      "@one/web/page",
      "@two/web/page",
    ]);
    expect((await store.resolve("web/page")).name).toBe("@one/web/page");
    expect((await store.resolve("@two/web/page")).name).toBe("@two/web/page");
  });

  it("rejects a scoped name declared by two sources", async () => {
    const first = await catalogDirectory({ "a.json": "@one/web/page" });
    const second = await catalogDirectory({ "b.json": "@one/web/page" });
    await expect(new LensStore([first, second]).load()).rejects.toThrow(
      /duplicate lens name "@one\/web\/page"/
    );
  });

  it("accepts file: references as directory paths", async () => {
    const directory = await catalogDirectory({ "a.json": "@one/web/page" });
    const store = new LensStore([`file:${directory}`]);
    expect((await store.load()).map((spec) => spec.name)).toEqual(["@one/web/page"]);
  });
});

describe("git catalog source", () => {
  it("clones a repository into the cache, loads it, and refreshes on update", async () => {
    const repo = await catalogDirectory({ "a.json": "@one/web/page" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one");

    process.env.LENS_CACHE_DIR = await mkdtemp(join(tmpdir(), "lens-cache-"));
    try {
      const store = new LensStore([`git:${repo}#main`]);
      expect((await store.load()).map((spec) => spec.name)).toEqual(["@one/web/page"]);

      await writeFile(
        join(repo, "b.json"),
        JSON.stringify({
          name: "@one/web/other",
          url: "https://example.com/other",
          effects: { reads: ["example.com"], writes: [] },
          resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
        })
      );
      git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "two");

      // Pinned to the clone until an explicit update.
      expect(await store.load()).toHaveLength(1);
      await store.update();
      expect(await store.load()).toHaveLength(2);
    } finally {
      delete process.env.LENS_CACHE_DIR;
    }
  });
});

describe("parseCatalogSource", () => {
  it("normalises bare paths and file: references to the same source", () => {
    expect(parseCatalogSource("./examples").id).toBe(parseCatalogSource("file:./examples").id);
  });

  it("keeps git and http references as their own ids", () => {
    expect(parseCatalogSource("git:github.com/o/r#main/catalog").id).toBe(
      "git:github.com/o/r#main/catalog"
    );
    expect(parseCatalogSource("https://example.com/catalog.json").id).toBe(
      "https://example.com/catalog.json"
    );
  });

  it("rejects a git reference without a repository path", () => {
    expect(() => parseCatalogSource("git:justahost")).toThrow(/invalid git catalog reference/);
  });
});
