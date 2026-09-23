import type { BrokerOrchestrator } from "./broker-orchestrator.js";

type Exit = "moved" | "closed" | "cancelled" | "expired" | "poll";
const AUTH_POLL_MS = 1_000;
type Prompt = { update(expiresAt: number, count: number): void; dispose(): void };
type Watch = (origin: string, target: string, onExit: (reason: Exit) => void, resume: boolean) => Promise<Prompt | undefined>;

type Waiter = { expiresAt: number; resolve: (reason: Exit) => void; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setTimeout>; cleanup?: () => void };
type Group = { waiters: Set<Waiter>; prompt?: Prompt; done: boolean };

/** Broker and browser tests use the same adapter, including retry reattachment. */
export function createBrokerAuthLeases(orchestrator: Pick<BrokerOrchestrator, "watchAuthGate">) {
  return createAuthLeases((origin, target, onExit, resume) =>
    orchestrator.watchAuthGate(origin, target, onExit, resume)
  );
}

/** One visible gate per origin, but each call owns its own absolute deadline. */
export function createAuthLeases(watch: Watch) {
  const groups = new Map<string, Group>();
  return {
    /** Remove an idle prompt when its caller has finished after a poll. */
    close(origin: string): void {
      const group = groups.get(origin);
      if (!group || group.waiters.size) return;
      group.done = true;
      groups.delete(origin);
      group.prompt?.dispose();
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
          if (!prompt) { finish("closed"); return; }
          if (own.done) { prompt.dispose(); return; }
          own.prompt = prompt;
          update();
        }, () => finish("closed"));
      }
      const current = group;
      const update = () => {
        if (!current.prompt || current.done) return;
        current.prompt.update(
          Math.max(...[...current.waiters].map((waiter) => waiter.expiresAt)),
          current.waiters.size
        );
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
          else if (reason !== "poll") finish(reason);
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
