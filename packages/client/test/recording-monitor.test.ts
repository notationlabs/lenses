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
    const screenshotDeadlines: Array<number | undefined> = [];
    const session = {
      navigated: true,
      async recordingState() {
        return { ...state };
      },
      async recordingScreenshot(deadline?: number) {
        screenshotDeadlines.push(deadline);
        return Buffer.from(state.url).toString("base64");
      },
    } as BrowserSession;
    const monitor = new RecordingMonitor(
      session,
      async (event) => {
        events.push(event);
      },
      12345
    );

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
    expect(screenshotDeadlines).toEqual(screenshotDeadlines.map(() => 12345));
  });
  it("gives up waiting for a page that never settles at the deadline", async () => {
    vi.useFakeTimers();
    const events: RecordingCheckpoint[] = [];
    const session = {
      navigated: false,
      async recordingState() {
        return { url: "https://example.com/spinner", title: "", documentRevision: 0, loading: true };
      },
      async recordingScreenshot() {
        return "";
      },
    } as BrowserSession;
    const monitor = new RecordingMonitor(session, async (event) => {
      events.push(event);
    }, Date.now() + 2_000);

    let started = false;
    const starting = monitor.start().then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(2_100);
    await starting;
    expect(started).toBe(true);

    let finished = false;
    const finishing = monitor.finish().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(100);
    await finishing;
    expect(finished).toBe(true);
    expect(events).toEqual([]);
  });

  it("does not throw from finish when the final checkpoint fails", async () => {
    vi.useFakeTimers();
    let lost = false;
    const session = {
      navigated: true,
      async recordingState() {
        if (lost) throw new Error("session closed");
        return { url: "https://example.com/", title: "", documentRevision: 0, loading: false };
      },
      async recordingScreenshot() {
        return "";
      },
    } as BrowserSession;
    const monitor = new RecordingMonitor(session, async () => {}, Date.now() + 30_000);
    await monitor.start();
    lost = true;
    const finishing = monitor.finish();
    await vi.advanceTimersByTimeAsync(100);
    await expect(finishing).resolves.toBeUndefined();
  });
});
