type Exit = "moved" | "closed" | "cancelled" | "expired";
type Prompt = { update(expiresAt: number, count: number): void; dispose(): void };
type Watch = (origin: string, target: string, onExit: (reason: Exit) => void) => Promise<Prompt | undefined>;

type Waiter = { expiresAt: number; resolve: (reason: Exit) => void; timer: ReturnType<typeof setTimeout>; cleanup?: () => void }; 
type Group = { waiters: Set<Waiter>; prompt?: Prompt; done: boolean };

/** One visible gate per origin, but each call owns its own absolute deadline. */
export function createAuthLeases(watch: Watch) {
  const groups = new Map<string, Group>();
  return {
    wait(origin: string, target: string, expiresAt: number, signal?: AbortSignal): Promise<Exit> {
      if (expiresAt <= Date.now()) return Promise.resolve("expired");
      if (signal?.aborted) return Promise.resolve("cancelled");
      let group = groups.get(origin);
      if (!group) {
        group = { waiters: new Set(), done: false };
        groups.set(origin, group);
        const own = group;
        void watch(origin, target, (reason) => finish(reason)).then((prompt) => {
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
        };
        const settle = (reason: Exit) => {
          if (!current.waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          waiter.cleanup?.();
          resolve(reason);
          if (current.waiters.size) update();
          else finish(reason);
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
