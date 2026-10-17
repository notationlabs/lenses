import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuild, computeBuildStamp } from "../src/broker-stamp.js";

describe("broker build stamp", () => {
  it("changes with modules in subdirectories and in every given directory", () => {
    const client = mkdtempSync(join(tmpdir(), "stamp-client-"));
    const core = mkdtempSync(join(tmpdir(), "stamp-core-"));
    mkdirSync(join(client, "relay"));
    writeFileSync(join(client, "index.js"), "a");
    writeFileSync(join(client, "relay", "model.js"), "b");
    writeFileSync(join(core, "engine.js"), "c");
    const original = computeBuildStamp(client, core);

    writeFileSync(join(client, "relay", "model.js"), "b2");
    const relayChanged = computeBuildStamp(client, core);
    expect(relayChanged).not.toBe(original);

    writeFileSync(join(core, "engine.js"), "c2");
    expect(computeBuildStamp(client, core)).not.toBe(relayChanged);

    // Declarations are not code the daemon runs.
    const settled = computeBuildStamp(client, core);
    writeFileSync(join(core, "engine.d.ts"), "types");
    expect(computeBuildStamp(client, core)).toBe(settled);
  });

  it("dates a build by its newest module", () => {
    const dir = mkdtempSync(join(tmpdir(), "stamp-time-"));
    writeFileSync(join(dir, "a.js"), "a");
    writeFileSync(join(dir, "b.js"), "b");
    writeFileSync(join(dir, "notes.md"), "not code");
    utimesSync(join(dir, "a.js"), 1_000, 1_000);
    utimesSync(join(dir, "b.js"), 2_000, 2_000);
    utimesSync(join(dir, "notes.md"), 9_000, 9_000);
    expect(computeBuild(dir).builtAt).toBe(2_000_000);
  });
});
