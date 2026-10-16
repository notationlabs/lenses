import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  fileContentProblem,
  fileExtension,
  type FileContent,
  type SavedFile,
  type LensResult,
  type LensSpec,
} from "@djgrant/lenses-core";

/** Responses a file lens may read are far larger than ordinary JSON. */
export const MAX_FILE_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Why `outDir` cannot receive a file lens's output, or undefined when it can.
 * Checked before any browser work so a bad directory costs nothing.
 */
export async function outDirProblem(outDir: string | undefined): Promise<LensResult | undefined> {
  if (outDir === undefined) {
    return {
      kind: "error",
      code: "out_dir_required",
      message: "this lens returns a file; pass an out dir (--out-dir <dir>, or outDir) to write it into",
    };
  }
  const invalid = (reason: string): LensResult => ({
    kind: "error",
    code: "out_dir_invalid",
    message: `out dir ${outDir} ${reason}`,
  });
  if (!isAbsolute(outDir)) return invalid("must be an absolute path");
  try {
    if (!(await stat(outDir)).isDirectory()) return invalid("is not a directory");
    await access(outDir, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === "ENOENT" ? "does not exist" : "is not writable");
  }
  return undefined;
}

/**
 * Decode a file lens's value and write it into `outDir`, replacing the value
 * with where it went. A cached value is written again, so a hit still leaves
 * the file on disk. The write goes through a temporary name and a rename, so
 * a reader never sees a half-written file.
 */
export async function saveFile(
  spec: LensSpec,
  result: LensResult,
  outDir: string
): Promise<LensResult> {
  if (result.kind !== "value") return result;
  const problem =
    fileContentProblem(result.value) ?? (result.partial ? "the tiers produced only part of it" : undefined);
  if (problem) {
    return {
      kind: "error",
      code: "file_invalid",
      message: `${spec.name} did not produce a file: ${problem}`,
    };
  }
  const file = result.value as FileContent;
  const bytes = Buffer.from(file.content, file.encoding);
  const name =
    file.name ??
    `${spec.name.split("/").pop()}-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.${fileExtension(file.mimeType)}`;
  const path = join(outDir, name);
  const temporary = join(outDir, `.${name}.${process.pid}.${Date.now()}.partial`);
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  const value: SavedFile = { path, name, mimeType: file.mimeType, bytes: bytes.length };
  return { ...result, value };
}
