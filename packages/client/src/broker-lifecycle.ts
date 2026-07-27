export interface IdleExitTimer {
  /** Restart the countdown; a no-op while the broker is not idle. */
  reset(): void;
  stop(): void;
  readonly armed: boolean;
}

export interface IdleExitOptions {
  /** 0 disables idle exit entirely. */
  idleMs: number;
  isIdle(): boolean;
  onExit(): void | Promise<void>;
}

/**
 * Exits the broker after a quiet window. "Quiet" deliberately includes "no
 * extension attached": exiting under an attached extension would drop its
 * socket and force the extension through rediscovery, which is a worse trade
 * than a resident process. The next client respawns the broker on demand.
 */
export function createIdleExitTimer(options: IdleExitOptions): IdleExitTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    get armed() {
      return timer !== undefined;
    },
    reset() {
      clear();
      if (options.idleMs <= 0 || !options.isIdle()) return;
      timer = setTimeout(() => {
        timer = undefined;
        // Re-check: work can arrive between the last reset and the deadline.
        if (options.isIdle()) void options.onExit();
      }, options.idleMs);
      timer.unref?.();
    },
    stop: clear,
  };
}

export interface ShutdownSequenceOptions {
  inFlight(): number;
  drainTimeoutMs: number;
  /** Release the CDP lease so Chrome's debugging slot is free for other tools. */
  release(): Promise<void>;
  stop(): void;
  exit(): void;
  log?(message: string): void;
  sleep?(ms: number): Promise<void>;
}

/**
 * Retire the daemon: refuse nothing that is already running, let it drain
 * (bounded, so a wedged call cannot pin the process), release the CDP lease,
 * then exit. Runs at most once.
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
    const deadline = Date.now() + options.drainTimeoutMs;
    while (options.inFlight() > 0 && Date.now() < deadline) {
      await sleep(25);
    }
    try {
      await options.release();
    } catch (error) {
      options.log?.(`broker lease release failed: ${String(error)}`);
    }
    options.stop();
    options.exit();
  };
}
