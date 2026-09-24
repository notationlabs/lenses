import type { BrokerOrchestrator } from "./broker-orchestrator.js";

type Exit = "moved" | "closed" | "unavailable" | "cancelled" | "expired" | "poll";
const AUTH_POLL_MS = 1_000;
type Prompt = { update(expiresAt: number, count: number): void; dispose(): void };
type Watch = (origin: string, target: string, onExit: (reason: Exit) => void, resume: boolean) => Promise<Prompt | undefined>;

type Waiter = { expiresAt: number; resolve: (reason: Exit) => void; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setTimeout>; cleanup?: () => void };
type Group = { waiters: Set<Waiter>; prompt?: Prompt; done: boolean; last?: string };

/** Broker and browser tests use the same adapter, including retry reattachment. */
export function createBrokerAuthLeases(orchestrator: Pick<BrokerOrchestrator, "watchAuthGate">) {
  return createAuthLeases((origin, target, onExit, resume) =>
    orchestrator.watchAuthGate(origin, target, onExit, resume)
  );
}

/** One visible gate per origin, but each call owns its own absolute deadline. */
export function createAuthLeases(watch: Watch) {
  const groups = new Map<string, Group>();
  const owners = new Map<string, number>();
  const disposeIdle = (origin: string) => {
    const group = groups.get(origin);
    if (!group || group.waiters.size || (owners.get(origin) ?? 0) > 0) return;
    group.done = true;
    groups.delete(origin);
    group.prompt?.dispose();
  };
  return {
    /** Hold the gate across this call's poll/retry gaps. */
    retain(origin: string): void {
      owners.set(origin, (owners.get(origin) ?? 0) + 1);
    },
    close(origin: string): void {
      const count = owners.get(origin) ?? 0;
      if (count <= 1) owners.delete(origin);
      else owners.set(origin, count - 1);
      disposeIdle(origin);
    },
    wait(origin: string, target: string, expiresAt: number, signal?: AbortSignal, resume = false): Promise<Exit> {
      if (expiresAt <= Date.now()) return Promise.resolve("expired");
      if (signal?.aborted) return Promise.resolve("cancelled");
      let group = groups.get(origin);
      if (!group) {
        group = { waiters: new Set(), done: false };
        groups.set(origin, group);
        const own = group;
        void watch(origin, target, (reason) => finish(reason), resume).then((prompt) => {
          if (!prompt) { finish("unavailable"); return; }
          if (own.done) { prompt.dispose(); return; }
          own.prompt = prompt;
          update();
        }, () => finish("closed"));
      }
      const current = group;
      const update = () => {
        if (!current.prompt || current.done) return;
        if (!current.waiters.size) return;
        const expiresAt = Math.max(...[...current.waiters].map((waiter) => waiter.expiresAt));
        const state = `${expiresAt}:${current.waiters.size}`;
        if (current.last === state) return;
        current.last = state;
        current.prompt.update(expiresAt, current.waiters.size);
      };
      const finish = (reason: Exit) => {
        if (current.done) return;
        current.done = true;
        groups.delete(origin);
        current.prompt?.dispose();
        for (const waiter of current.waiters) {
          clearTimeout(waiter.timer);
          clearTimeout(waiter.poll);
          waiter.cleanup?.();
          waiter.resolve(reason);
        }
        current.waiters.clear();
      };
      return new Promise<Exit>((resolve) => {
        const waiter: Waiter = {
          expiresAt,
          resolve,
          timer: setTimeout(() => settle("expired"), Math.max(0, expiresAt - Date.now())),
          poll: setTimeout(() => settle("poll"), AUTH_POLL_MS),
        };
        const settle = (reason: Exit) => {
          if (!current.waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          clearTimeout(waiter.poll);
          waiter.cleanup?.();
          resolve(reason);
          if (current.waiters.size) update();
          else if (reason !== "poll") {
            if ((owners.get(origin) ?? 0) === 0) finish(reason);
            else if (reason !== "expired" && reason !== "cancelled") finish(reason);
            else disposeIdle(origin);
          }
          // Keep the banner and navigation watcher mounted while a safe
          // retry checks the site; reattaching every second would flicker.
        };
        const aborted = () => settle("cancelled");
        waiter.cleanup = () => signal?.removeEventListener("abort", aborted);
        current.waiters.add(waiter);
        signal?.addEventListener("abort", aborted, { once: true });
        update();
      });
    },
  };
}
