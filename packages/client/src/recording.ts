import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RecordingCheckpoint } from "./browser-backend.js";

export interface RecordingOptions {
  path: string;
}

export interface RecordingHandle {
  /** Absolute path of this recording run. */
  readonly path: string;
  /** Stop applying this recorder to new calls through its client. */
  stop(): void;
}

export interface RecordingTarget {
  path: string;
  callId: string;
  lens: string;
}

export interface RecordingEvent {
  sequence: number;
  checkpoint: "bind" | "navigation" | "final";
  timestamp: string;
  lens: string;
  callId: string;
  url: string;
  title: string;
  sha256: string;
  image: string;
  duplicateOf?: number;
}

export interface RecordingIndex {
  version: 1;
  startedAt: string;
  events: RecordingEvent[];
}

const INDEX = "index.json";

/** Create an exclusive, sortable run directory without introducing a random ID. */
export function createRecordingRun(root = "./screenshots", now = Date.now()): string {
  const resolvedRoot = resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  for (let millisecond = now; ; millisecond += 1) {
    const run = resolve(resolvedRoot, `lenses-recording-${safeUtcTimestamp(millisecond)}`);
    try {
      mkdirSync(run);
      const index: RecordingIndex = {
        version: 1,
        startedAt: new Date(millisecond).toISOString(),
        events: [],
      };
      // Synchronous creation makes record() immediately usable by the next call.
      writeFileSync(resolve(run, INDEX), `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function appendRecordingCheckpoint(
  target: RecordingTarget,
  checkpoint: RecordingCheckpoint
): Promise<void> {
  const indexPath = resolve(target.path, INDEX);
  const index = JSON.parse(await readFile(indexPath, "utf8")) as RecordingIndex;
  const bytes = Buffer.from(checkpoint.pngBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sequence = index.events.length + 1;
  const prior = index.events.find((event) => event.sha256 === sha256);
  const image = prior?.image ?? imageName(sequence, checkpoint.url, sha256);
  if (!prior) await writeFile(resolve(target.path, image), bytes, { flag: "wx" });
  index.events.push({
    sequence,
    checkpoint: checkpoint.kind,
    timestamp: new Date(checkpoint.timestamp).toISOString(),
    lens: target.lens,
    callId: target.callId,
    url: checkpoint.url,
    title: checkpoint.title,
    sha256,
    image,
    ...(prior ? { duplicateOf: prior.sequence } : {}),
  });
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

export function safeUtcTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replaceAll(":", "-");
}

export function imageName(sequence: number, value: string, hash: string): string {
  let slug = "page";
  try {
    const url = new URL(value);
    slug = `${url.host}${url.pathname}`;
  } catch {
    slug = value;
  }
  slug = slug
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 100) || "page";
  return `${String(sequence).padStart(6, "0")}-${slug}-${hash.slice(0, 8)}.png`;
}
