import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRecordingCheckpoint,
  createRecordingRun,
  imageName,
  type RecordingIndex,
} from "../src/recording.js";

const checkpoint = (pngBase64: string, url = "https://Example.com/a path?q=secret#hash") => ({
  kind: "bind" as const,
  url,
  title: "A page",
  timestamp: Date.UTC(2025, 0, 2, 3, 4, 5, 6),
  pngBase64,
});

describe("recording files", () => {
  it("allocates the next unused filesystem-safe millisecond directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-root-"));
    const now = Date.UTC(2025, 0, 2, 3, 4, 5, 6);
    const first = createRecordingRun(root, now);
    const second = createRecordingRun(root, now);

    expect(first.endsWith("lenses-recording-2025-01-02T03-04-05.006Z")).toBe(true);
    expect(second.endsWith("lenses-recording-2025-01-02T03-04-05.007Z")).toBe(true);
    expect(JSON.parse(await readFile(join(first, "index.json"), "utf8"))).toMatchObject({
      version: 1,
      events: [],
    });
  });

  it("deduplicates exact image bytes while preserving ordered checkpoint events", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-root-"));
    const path = createRecordingRun(root);
    const target = { path, callId: "call-1", lens: "@example/page" };
    const png = Buffer.from("same png").toString("base64");

    await appendRecordingCheckpoint(target, checkpoint(png));
    await appendRecordingCheckpoint(target, { ...checkpoint(png), kind: "final" });

    const index = JSON.parse(await readFile(join(path, "index.json"), "utf8")) as RecordingIndex;
    expect(index.events).toHaveLength(2);
    expect(index.events[1]).toMatchObject({
      sequence: 2,
      checkpoint: "final",
      image: index.events[0].image,
      duplicateOf: 1,
    });
    expect(index.events[0].image).not.toContain("secret");
    expect((await readdir(path)).filter((file) => file.endsWith(".png"))).toHaveLength(1);
  });

  it("uses the event sequence, URL slug, and hash prefix in image names", () => {
    expect(imageName(7, "https://example.com/foo/bar?q=x#y", "abcdef012345")).toBe(
      "000007-example-com-foo-bar-abcdef01.png"
    );
  });
});
