import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBuildStamp } from "../src/broker-stamp.js";

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
});
