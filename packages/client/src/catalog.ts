import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateSpec, type LensSpec } from "@djgrant/lenses-core";

const run = promisify(execFile);

/** One catalog of lens documents, addressed by a scheme-prefixed reference. */
export interface CatalogSource {
  /** The normalised reference, used in listings and error messages. */
  readonly id: string;
  load(): Promise<LensSpec[]>;
  /** Refresh any cached copy from the origin. Absent for live sources. */
  update?(): Promise<void>;
}

/**
 * Dispatch a catalog reference to a source by scheme:
 *   file:./examples (or a bare path)  — local directory, read live
 *   git:host/owner/repo#ref/subdir    — shallow clone cached under ~/.cache/lenses
 *   https://…/catalog.json            — HTTP index of lens documents, ETag-cached
 */
export function parseCatalogSource(ref: string): CatalogSource {
  if (ref.startsWith("git:")) return new GitCatalogSource(ref);
  if (ref.startsWith("http://") || ref.startsWith("https://")) return new HttpCatalogSource(ref);
  if (ref.startsWith("file:")) return new FileCatalogSource(fileRefToPath(ref));
  return new FileCatalogSource(ref);
}

function fileRefToPath(ref: string): string {
  // file:///abs is a proper URL; file:./relative and file:/abs are shorthand.
  if (ref.startsWith("file://")) return fileURLToPath(ref);
  return ref.slice("file:".length);
}

function cacheRoot(): string {
  return process.env.LENS_CACHE_DIR ?? join(homedir(), ".cache", "lenses");
}

function refHash(ref: string): string {
  return createHash("sha256").update(ref).digest("hex").slice(0, 16);
}

/**
 * Catalogue-level settings, held in a `catalog.json` beside the documents (or
 * in the index document, for an HTTP catalogue). It is not itself a lens.
 */
export const CATALOG_DOCUMENT = "catalog.json";

interface CatalogDocument {
  helpers?: Record<string, string>;
}

/**
 * Give every document the catalogue's helpers, with its own winning by name.
 *
 * The point is blast radius, not typing. A helper copy-pasted into thirteen
 * documents has to be fixed thirteen times and re-verified against thirteen
 * live pages; bound here, a fix is proportional to the change instead.
 */
function withCatalogHelpers(spec: LensSpec, catalog: CatalogDocument): LensSpec {
  if (!catalog.helpers) return spec;
  return { ...spec, helpers: { ...catalog.helpers, ...spec.helpers } };
}

/** `withCatalogHelpers` for a caller holding helpers rather than a document. */
export function applyCatalogHelpers(
  spec: LensSpec,
  helpers: Record<string, string> | undefined
): LensSpec {
  return withCatalogHelpers(spec, { helpers });
}

/** The helpers a lens document at `path` inherits from its own directory. */
export async function catalogHelpersFor(path: string): Promise<Record<string, string> | undefined> {
  return (await readCatalogDocument(dirname(path))).helpers;
}

async function readCatalogDocument(directory: string): Promise<CatalogDocument> {
  let text: string;
  try {
    text = await readFile(join(directory, CATALOG_DOCUMENT), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as CatalogDocument;
    return { helpers: parsed.helpers };
  } catch (error) {
    throw new Error(
      `invalid catalog document ${join(directory, CATALOG_DOCUMENT)}: ${(error as Error).message}`
    );
  }
}

/** Read every *.json in a directory as a validated lens document. */
export async function readLensDirectory(directory: string): Promise<LensSpec[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const catalog = await readCatalogDocument(directory);
  const specs: LensSpec[] = [];
  for (const file of entries.filter((entry) => entry.endsWith(".json")).sort()) {
    if (file === CATALOG_DOCUMENT) continue;
    try {
      specs.push(
        withCatalogHelpers(
          validateSpec(JSON.parse(await readFile(join(directory, file), "utf8"))),
          catalog
        )
      );
    } catch (error) {
      throw new Error(`invalid lens document ${join(directory, file)}: ${(error as Error).message}`);
    }
  }
  return specs;
}

export interface LensFile {
  /** Path relative to the scanned root, usable directly as a lens_call / lens call reference. */
  path: string;
  spec: LensSpec;
}

const SCAN_SKIP = new Set(["node_modules", "dist", "build", "coverage"]);

/**
 * Leniently scan a directory tree for loose lens documents: every *.json that
 * parses and validates as a lens spec. Unlike readLensDirectory, files that are
 * not lens documents (package.json, tsconfig.json, …) are silently skipped.
 */
export async function scanLensFiles(root: string, maxDepth = 2): Promise<LensFile[]> {
  const found: LensFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SCAN_SKIP.has(entry.name)) await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      if (entry.name === CATALOG_DOCUMENT) continue;
      try {
        const spec = validateSpec(JSON.parse(await readFile(path, "utf8")));
        found.push({ path: relative(root, path), spec });
      } catch {
        // not a lens document
      }
    }
  };
  await walk(resolve(root), 1);
  return found;
}

class FileCatalogSource implements CatalogSource {
  readonly id: string;
  private readonly directory: string;

  constructor(path: string) {
    this.directory = resolve(path);
    this.id = pathToFileURL(this.directory).href.replace("file://", "file:");
  }

  load(): Promise<LensSpec[]> {
    return readLensDirectory(this.directory);
  }
}

/** git:host/owner/repo[#ref][/subdir] — the subdir follows the ref after the first slash. */
class GitCatalogSource implements CatalogSource {
  readonly id: string;
  private readonly cloneUrl: string;
  private readonly ref?: string;
  private readonly subdir: string;
  private readonly dir: string;

  constructor(reference: string) {
    this.id = reference;
    const body = reference.slice("git:".length);
    const hashAt = body.indexOf("#");
    const repoPath = hashAt === -1 ? body : body.slice(0, hashAt);
    const refAndSubdir = hashAt === -1 ? "" : body.slice(hashAt + 1);
    const slashAt = refAndSubdir.indexOf("/");
    this.ref = (slashAt === -1 ? refAndSubdir : refAndSubdir.slice(0, slashAt)) || undefined;
    this.subdir = slashAt === -1 ? "" : refAndSubdir.slice(slashAt + 1);
    if (!repoPath.includes("/")) throw new Error(`invalid git catalog reference "${reference}"`);
    // git:/abs/path/to/repo clones a local repository; git:host/owner/repo goes over https.
    this.cloneUrl = repoPath.startsWith("/")
      ? pathToFileURL(repoPath).href
      : `https://${repoPath}`;
    this.dir = join(cacheRoot(), "git", refHash(`${this.cloneUrl}#${this.ref ?? ""}`));
  }

  private async cloned(): Promise<boolean> {
    return await stat(join(this.dir, ".git"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
  }

  private async git(args: string[]): Promise<void> {
    try {
      await run("git", args, { cwd: this.dir });
    } catch (error) {
      throw new Error(`git catalog ${this.id}: git ${args[0]} failed: ${(error as Error).message}`);
    }
  }

  private async ensureClone(): Promise<void> {
    if (await this.cloned()) return;
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
    await this.git([
      "clone",
      "--depth",
      "1",
      ...(this.ref ? ["--branch", this.ref] : []),
      this.cloneUrl,
      ".",
    ]);
  }

  async load(): Promise<LensSpec[]> {
    await this.ensureClone();
    const specs = await readLensDirectory(join(this.dir, this.subdir));
    if (specs.length === 0) {
      throw new Error(`git catalog ${this.id} contains no lens documents`);
    }
    return specs;
  }

  async update(): Promise<void> {
    await this.ensureClone();
    await this.git(["fetch", "--depth", "1", "origin", this.ref ?? "HEAD"]);
    await this.git(["reset", "--hard", "FETCH_HEAD"]);
  }
}

interface HttpCatalogCache {
  etag?: string;
  specs: unknown[];
}

/**
 * An HTTP catalog is an index document — { "lenses": ["hn.top.json", …] } — whose
 * entries are URLs resolved against the index. The index is revalidated with
 * If-None-Match on every load; the cached copy also serves network failures.
 */
class HttpCatalogSource implements CatalogSource {
  readonly id: string;
  private readonly cacheFile: string;

  constructor(url: string) {
    this.id = url;
    this.cacheFile = join(cacheRoot(), "http", `${refHash(url)}.json`);
  }

  private async readCache(): Promise<HttpCatalogCache | undefined> {
    try {
      return JSON.parse(await readFile(this.cacheFile, "utf8")) as HttpCatalogCache;
    } catch {
      return undefined;
    }
  }

  async load(): Promise<LensSpec[]> {
    const cached = await this.readCache();
    let response: Response;
    try {
      response = await fetch(this.id, {
        headers: cached?.etag ? { "if-none-match": cached.etag } : {},
      });
    } catch (error) {
      if (cached) return cached.specs.map((spec) => validateSpec(spec));
      throw new Error(`http catalog ${this.id}: ${(error as Error).message}`);
    }
    if (response.status === 304 && cached) {
      return cached.specs.map((spec) => validateSpec(spec));
    }
    if (!response.ok) throw new Error(`http catalog ${this.id}: HTTP ${response.status}`);

    const index = (await response.json()) as { lenses?: unknown; helpers?: Record<string, string> };
    if (!Array.isArray(index.lenses)) {
      throw new Error(`http catalog ${this.id}: index must declare a "lenses" array`);
    }
    // Helpers are folded in before caching, so the 304 and offline paths below
    // serve documents that already carry them.
    const catalog = { helpers: index.helpers };
    const specs = await Promise.all(
      index.lenses.map(async (entry) => {
        if (typeof entry === "string") {
          const documentUrl = new URL(entry, this.id).href;
          const documentResponse = await fetch(documentUrl);
          if (!documentResponse.ok) {
            throw new Error(`http catalog ${this.id}: ${documentUrl} HTTP ${documentResponse.status}`);
          }
          return withCatalogHelpers(validateSpec(await documentResponse.json()), catalog);
        }
        return withCatalogHelpers(validateSpec(entry), catalog); // an index may inline documents
      })
    );
    await mkdir(join(cacheRoot(), "http"), { recursive: true });
    await writeFile(
      this.cacheFile,
      JSON.stringify({ etag: response.headers.get("etag") ?? undefined, specs }),
      "utf8"
    );
    return specs;
  }

  async update(): Promise<void> {
    await rm(this.cacheFile, { force: true });
  }
}
