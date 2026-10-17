import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HANDOVER_TTL_MS, saveHandover, takeHandover } from "../src/tab-handover.js";

const tab = { tabId: 7, targetId: "target-7", url: "https://bank.example/home" };

function handoverFile(): string {
  return join(mkdtempSync(join(tmpdir(), "handover-")), "tab-handover.json");
}

describe("tab handover", () => {
  it("gives the tabs to the next broker once", () => {
    const path = handoverFile();
    saveHandover("Profile 4", [tab], path, 1_000);
    expect(takeHandover("Profile 4", path, 2_000)).toEqual([tab]);
    expect(existsSync(path)).toBe(false);
    expect(takeHandover("Profile 4", path, 2_000)).toEqual([]);
  });

  it("drops a stale handover or one for another profile", () => {
    const path = handoverFile();
    saveHandover("Profile 4", [tab], path, 1_000);
    expect(takeHandover("Profile 4", path, 1_000 + HANDOVER_TTL_MS + 1)).toEqual([]);
    expect(existsSync(path)).toBe(false);

    saveHandover("Profile 4", [tab], path, 1_000);
    expect(takeHandover("Default", path, 2_000)).toEqual([]);
  });

  it("writes nothing for no tabs and ignores a damaged file", () => {
    const path = handoverFile();
    saveHandover("Profile 4", [], path);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, "{not json");
    expect(takeHandover("Profile 4", path)).toEqual([]);
  });
});
