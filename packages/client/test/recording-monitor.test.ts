import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession, RecordingCheckpoint } from "../src/browser-backend.js";
import { RecordingMonitor } from "../src/recording-monitor.js";

afterEach(() => vi.useRealTimers());

describe("RecordingMonitor", () => {
  it("abandons a transient URL and records only the newer settled transition", async () => {
    vi.useFakeTimers();
    let state = {
      url: "https://example.com/start",
      title: "Start",
      documentRevision: 0,
      loading: false,
    };
    const events: RecordingCheckpoint[] = [];
    const session = {
      navigated: true,
      async recordingState() {
        return { ...state };
      },
      async recordingScreenshot() {
        return Buffer.from(state.url).toString("base64");
      },
    } as BrowserSession;
    const monitor = new RecordingMonitor(session, async (event) => {
      events.push(event);
    });

    await monitor.start();
    state = { ...state, url: "https://example.com/redirect", title: "Redirect" };
    await vi.advanceTimersByTimeAsync(300);
    state = { ...state, url: "https://example.com/landed", title: "Landed" };
    await vi.advanceTimersByTimeAsync(499);
    expect(events.map((event) => event.url)).toEqual(["https://example.com/start"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(events.map((event) => event.url)).toEqual([
      "https://example.com/start",
      "https://example.com/landed",
    ]);

    const finishing = monitor.finish();
    await vi.advanceTimersByTimeAsync(600);
    await finishing;
    expect(events.at(-1)).toMatchObject({
      kind: "final",
      url: "https://example.com/landed",
      title: "Landed",
    });
  });
});
