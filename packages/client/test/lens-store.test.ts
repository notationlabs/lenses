import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LensStore, parseCatalogSource, scanLensFiles } from "../src/index.js";

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

describe("catalog settings", () => {
  const norm = 'function($s) { $trim($s) }';

  async function withCatalog(helpers: Record<string, string>, extra: Record<string, unknown> = {}) {
    const directory = await catalogDirectory({ "a.json": "@one/web/page" });
    await writeFile(join(directory, "catalog.json"), JSON.stringify({ helpers, ...extra }));
    return directory;
  }

  it("gives every document in the directory the catalogue's helpers", async () => {
    const directory = await withCatalog({ norm });
    const [spec] = await new LensStore([directory]).load();
    expect(spec.helpers).toEqual({ norm });
  });

  // catalog.json is settings, not a lens; loading it as one would throw.
  it("does not read catalog.json as a lens document", async () => {
    const directory = await withCatalog({ norm });
    expect((await new LensStore([directory]).load()).map((s) => s.name)).toEqual(["@one/web/page"]);
  });

  it("gives every document shared parameters and lets document declarations win", async () => {
    const directory = await withCatalog({}, { params: { account: "string", page: "integer" } });
    await writeFile(
      join(directory, "a.json"),
      JSON.stringify({
        name: "@one/web/page",
        url: "https://{account}.example.com/{page}",
        params: { page: { type: "integer", default: 1 } },
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
      })
    );

    const [spec] = await new LensStore([directory]).load();
    expect(spec.params).toEqual({
      account: "string",
      page: { type: "integer", default: 1 },
    });
  });

  it("lets a document's own helper of the same name win", async () => {
    const directory = await withCatalog({ norm });
    await writeFile(
      join(directory, "a.json"),
      JSON.stringify({
        name: "@one/web/page",
        url: "https://example.com/home",
        effects: { reads: ["example.com"], writes: [] },
        helpers: { norm: "function($s) { $uppercase($s) }" },
        resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
      })
    );
    const [spec] = await new LensStore([directory]).load();
    expect(spec.helpers?.norm).toBe("function($s) { $uppercase($s) }");
  });

  // `lens call ./my-lens.json` is the documented way to test a document, so it
  // must see the same helpers a catalogue load would supply.
  it("applies them to a document resolved by file path", async () => {
    const directory = await withCatalog({ norm }, { params: { account: "string" } });
    const spec = await new LensStore([]).resolve(join(directory, "a.json"));
    expect(spec.helpers).toEqual({ norm });
    expect(spec.params).toEqual({ account: "string" });
  });

  it("applies shared parameters while scanning loose lens files", async () => {
    const directory = await withCatalog({}, { params: { account: "string" } });
    await writeFile(
      join(directory, "a.json"),
      JSON.stringify({
        name: "@one/web/page",
        url: "https://{account}.example.com/home",
        effects: { reads: ["example.com"], writes: [] },
        resolve: [{ kind: "dom", fields: { title: { selector: "title" } } }],
      })
    );

    const [found] = await scanLensFiles(directory);
    expect(found.spec.params).toEqual({ account: "string" });
  });
});

describe("git catalog source", () => {
  it("clones a repository into the cache, loads it, and refreshes on update", async () => {
    const repo = await catalogDirectory({ "a.json": "@one/web/page" });
    // -c commit.gpgsign=false: a signing key in the developer's global config
    // would otherwise drag an agent (1Password, gpg) into a fixture commit.
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo });
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

  it("keeps git references as their own ids", () => {
    expect(parseCatalogSource("git:github.com/o/r#main/catalog").id).toBe(
      "git:github.com/o/r#main/catalog"
    );
  });

  it("rejects a git reference without a repository path", () => {
    expect(() => parseCatalogSource("git:justahost")).toThrow(/invalid git catalog reference/);
  });
});
