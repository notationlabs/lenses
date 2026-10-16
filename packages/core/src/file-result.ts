import type { LensSpec } from "./types.js";

/**
 * A lens declaring `returns: {"type": "file"}` resolves to file content,
 * which the broker writes into the caller's out dir. Its tiers produce a
 * `FileContent`; the caller receives a `SavedFile`.
 */
export interface FileContent {
  content: string;
  encoding: "base64" | "utf8";
  mimeType: string;
  /** a bare file name; defaults to `<lens>-<sha256 prefix>.<ext>` */
  name?: string;
}

/** What a caller sees for a file lens: where the bytes were written. */
export interface SavedFile {
  /** absolute path of the written file */
  path: string;
  name: string;
  mimeType: string;
  /** size in bytes */
  bytes: number;
}

export function returnsFile(spec: Pick<LensSpec, "returns">): boolean {
  const returns = spec.returns as { type?: unknown } | undefined;
  return typeof returns === "object" && returns !== null && returns.type === "file";
}

/**
 * Why `name` is not a safe bare file name, or undefined when it is. A name
 * may not leave the out dir or hide in it.
 */
export function unsafeFileName(name: string): string | undefined {
  if (name === "") return "is empty";
  if (/[/\\]/.test(name)) return "contains a path separator";
  if (name.startsWith(".")) return "starts with a dot";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return "contains a control character";
  if (new TextEncoder().encode(name).length > 255) return "is longer than 255 bytes";
  return undefined;
}

/** Check a tier's value is FileContent; a string is the problem. */
export function fileContentProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "must be an object {content, encoding, mimeType, name?}";
  }
  const file = value as Record<string, unknown>;
  if (typeof file.content !== "string") return "content must be a string";
  if (file.encoding !== "base64" && file.encoding !== "utf8") {
    return 'encoding must be "base64" or "utf8"';
  }
  if (typeof file.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) {
    return "mimeType must be a media type like application/pdf";
  }
  if (file.name !== undefined && file.name !== null) {
    if (typeof file.name !== "string") return "name must be a string";
    const unsafe = unsafeFileName(file.name);
    if (unsafe) return `name "${file.name}" ${unsafe}`;
  }
  if (file.encoding === "base64" && !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(file.content)) {
    return "content is not base64";
  }
  return undefined;
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/xml": "xml",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/html": "html",
  "text/xml": "xml",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function fileExtension(mimeType: string): string {
  return EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}
