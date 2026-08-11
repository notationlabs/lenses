import type {
  BrowserSession,
  RecordingCheckpoint,
  RecordingPageState,
} from "./browser-backend.js";

const SETTLE_MS = 500;
const POLL_MS = 50;

/**
 * Watches only the bound session. URL/revision changes invalidate pending work,
 * so a redirect or newer navigation can never commit a stale screenshot.
 */
export class RecordingMonitor {
  private candidate?: { key: string; since: number; state: RecordingPageState };
  private capturedKey?: string;
  private generation = 0;
  private stopped = false;
  private loop?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: BrowserSession,
    private readonly emit: (checkpoint: RecordingCheckpoint) => Promise<void>
  ) {}

  async start(): Promise<void> {
    const state = await this.session.recordingState();
    this.observe(state);
    // A fresh bind has already waited for load + the existing 500ms grace.
    // A reused tab must prove that it stays put for 500ms after binding.
    if (this.session.navigated) {
      const captured = await this.capture("bind", this.generation, state);
      if (!captured) await this.waitAndCapture("bind", true);
    } else await this.waitAndCapture("bind", false);
    this.loop = this.watch();
  }

  async finish(): Promise<void> {
    // Stop the background capturer first: the final waiter performs the same
    // transition invalidation and must not race it for an extension debugger.
    this.stopped = true;
    await this.loop;
    await this.waitAndCapture("final", true);
    await this.writes;
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      await delay(POLL_MS);
      if (this.stopped) break;
      try {
        const changed = this.observe(await this.session.recordingState());
        const current = this.candidate;
        if (
          changed ||
          !current ||
          current.state.loading ||
          Date.now() - current.since < SETTLE_MS ||
          current.key === this.capturedKey
        ) continue;
        await this.capture("navigation", this.generation, current.state);
      } catch {
        // The final probe/call result owns session-loss reporting. Recording
        // observation must not replace a lens outcome.
      }
    }
  }

  private observe(state: RecordingPageState): boolean {
    const key = `${state.documentRevision}|${state.url}`;
    if (this.candidate?.key === key && this.candidate.state.loading === state.loading) {
      this.candidate.state = state;
      return false;
    }
    this.generation += 1;
    this.candidate = { key, since: Date.now(), state };
    return true;
  }

  private async waitAndCapture(kind: "bind" | "final", always: boolean): Promise<void> {
    for (;;) {
      const state = await this.session.recordingState();
      this.observe(state);
      const candidate = this.candidate;
      if (!candidate) continue;
      const generation = this.generation;
      const remaining = candidate.state.loading
        ? POLL_MS
        : SETTLE_MS - (Date.now() - candidate.since);
      if (remaining > 0) {
        await delay(Math.min(POLL_MS, remaining));
        continue;
      }
      if (!always && candidate.key === this.capturedKey) return;
      if (await this.capture(kind, generation, candidate.state)) return;
    }
  }

  private async capture(
    kind: RecordingCheckpoint["kind"],
    generation: number,
    state: RecordingPageState
  ): Promise<boolean> {
    const pngBase64 = await this.session.recordingScreenshot();
    const after = await this.session.recordingState();
    this.observe(after);
    if (
      generation !== this.generation ||
      after.loading ||
      after.url !== state.url ||
      after.documentRevision !== state.documentRevision
    ) return false;
    this.capturedKey = `${after.documentRevision}|${after.url}`;
    this.writes = this.writes.then(() =>
      this.emit({
        kind,
        url: after.url,
        title: after.title,
        timestamp: Date.now(),
        pngBase64,
      })
    );
    await this.writes;
    return true;
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
