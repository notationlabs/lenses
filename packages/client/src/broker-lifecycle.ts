export interface IdleExitTimer {
  /** Restart the countdown; a no-op while the broker is not idle. */
  reset(): void;
  stop(): void;
  readonly armed: boolean;
}

export interface IdleExitOptions {
  /** Window with a browser available but unused. 0 disables idle exit. */
  idleMs: number;
  /**
   * Window with no browser reachable at all. Short by design: a broker with
   * nowhere to run lenses can do nothing but occupy memory, and respawning one
   * costs ~200ms.
   */
  noBrowserMs: number;
  isIdle(): boolean;
  browserLive(): Promise<boolean>;
  onExit(reason: string): void | Promise<void>;
}

/**
 * Exits the broker once nothing needs it. "Quiet" includes no attached
 * Playwright Extension relay: exiting would drop that socket and force the
 * connect page again, which is a worse trade than a resident process. The next
 * client respawns the broker on demand.
 */
export function createIdleExitTimer(options: IdleExitOptions): IdleExitTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const arm = (delayMs: number, fire: () => void) => {
    clear();
    timer = setTimeout(() => {
      timer = undefined;
      // Re-check: work can arrive between the last reset and the deadline.
      if (options.isIdle()) fire();
    }, delayMs);
    timer.unref?.();
  };

  const start = () => {
    clear();
    if (options.idleMs <= 0 || !options.isIdle()) return;
    arm(Math.min(options.noBrowserMs, options.idleMs), async () => {
      if (await options.browserLive()) {
        // A browser is there, just unused: fall back to the long window.
        const remaining = Math.max(options.idleMs - options.noBrowserMs, 1);
        arm(remaining, () => void options.onExit(`idle for ${options.idleMs}ms`));
        return;
      }
      void options.onExit("no browser is reachable");
    });
  };

  return {
    get armed() {
      return timer !== undefined;
    },
    reset: start,
    stop: clear,
  };
}

export interface ShutdownSequenceOptions {
  inFlight(): number;
  drainTimeoutMs: number;
  /**
   * Stop accepting connections, freeing the port. Runs first: a client that is
   * restarting a stale broker waits on the port, and both the drain and the
   * lease release can take seconds.
   */
  stopListening(): void;
  /**
   * Drop client sockets. Runs after the drain, so a call that was already in
   * flight still gets its result frame instead of a "broker disconnected".
   */
  closeSockets(): void;
  /** Release the CDP lease so Chrome's debugging slot is free for other tools. */
  release(): Promise<void>;
  /** Bound on the release, so a stuck Chrome cannot keep the process alive. */
  releaseTimeoutMs?: number;
  stop(): void;
  exit(): void;
  log?(message: string): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * Retire the daemon: stop listening, let in-flight work drain (bounded, so a
 * wedged call cannot pin the process), release the CDP lease, then exit. Runs
 * at most once.
 */
export function createShutdownSequence(
  options: ShutdownSequenceOptions
): (reason: string) => Promise<void> {
  let running = false;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return async (reason: string) => {
    if (running) return;
    running = true;
    options.log?.(`broker shutting down: ${reason}`);
    options.stopListening();
    const deadline = Date.now() + options.drainTimeoutMs;
    while (options.inFlight() > 0 && Date.now() < deadline) {
      await sleep(25);
    }
    options.closeSockets();
    try {
      await withTimeout(options.release(), options.releaseTimeoutMs ?? 5_000, sleep);
    } catch (error) {
      options.log?.(`broker lease release failed: ${String(error)}`);
    }
    options.stop();
    options.exit();
  };
}

async function withTimeout(
  work: Promise<void>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await Promise.race([
    work,
    sleep(timeoutMs).then(() => {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }),
  ]);
}
