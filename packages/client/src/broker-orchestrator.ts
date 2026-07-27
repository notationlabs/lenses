import {
  executeLens,
  expandUrl,
  type EngineIO,
  type InterceptedResponse,
  type LensBridgeRequest,
  type LensResult,
} from "@djgrant/lens";
import type {
  BrowserBackend,
  BrowserSession,
  FinishDisposition,
  InterceptDelta,
} from "./browser-backend.js";

export type BrokerFrame =
  | { type: "result"; id: string; result: LensResult }
  | { type: "progress"; id: string; message: string };

export interface BrokerOrchestrator {
  handle(
    message: Exclude<LensBridgeRequest, { type: "control" }>,
    emit: (frame: BrokerFrame) => void
  ): Promise<void>;
}

export function createBrokerOrchestrator(
  backends: BrowserBackend[],
  /**
   * preferredWaitMs may be a getter: the broker drops the wait to zero once it
   * knows no preferred backend is coming, so a call concedes to the fallback
   * immediately instead of paying the full grace.
   */
  options: { preferredWaitMs?: number | (() => number) } = {}
): BrokerOrchestrator {
  if (backends.length === 0) throw new Error("broker orchestrator requires a browser backend");
  const cache = new Map<string, { result: LensResult; expiresAt: number }>();

  function currentBackend(): BrowserBackend {
    return backends.find((backend) => backend.available()) ?? backends[backends.length - 1];
  }

  async function selectBackend(): Promise<BrowserBackend> {
    const selected = currentBackend();
    const preferredWaitMs =
      (typeof options.preferredWaitMs === "function"
        ? options.preferredWaitMs()
        : options.preferredWaitMs) ?? 0;
    if (
      selected.available() ||
      selected !== backends[backends.length - 1] ||
      preferredWaitMs <= 0 ||
      backends.length === 1
    ) {
      return selected;
    }
    await waitForPreferredBackend(
      backends.slice(0, -1),
      preferredWaitMs
    );
    return currentBackend();
  }

  async function call(
    message: Extract<LensBridgeRequest, { type: "call" }>,
    progress: (text: string) => void
  ): Promise<LensResult> {
    const cacheTtlMs = (message.spec.effects.cache ?? 0) * 1000;
    const cacheKey = `${JSON.stringify(message.spec)}|${JSON.stringify(message.params)}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true } as unknown as LensResult;
    }
    if (cached) cache.delete(cacheKey);

    const backend = await selectBackend();
    const target = expandUrl(message.spec.url, message.params);
    progress(`binding browser page for ${target} via ${backend.name}`);
    const session = await backend.bind({
      target,
      loadTimeoutMs: message.spec.loadTimeoutMs ?? 30_000,
      navigation: message.spec.resolve.some((resolver) => resolver.kind === "intercept")
        ? "fresh"
        : "reuse",
    });
    progress(`bound page${session.created ? " (created)" : " (existing)"}`);
    const io = createSessionEngineIO(session, message.spec.loadTimeoutMs ?? 30_000, progress);
    let result: LensResult | undefined;
    try {
      result = await executeLens(message.spec, message.params, io);
      if (result.kind === "value" && !result.partial && cacheTtlMs > 0) {
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
      }
      return result;
    } finally {
      await finishQuietly(backend, session, dispositionFor(result));
    }
  }

  async function observe(
    message: Extract<LensBridgeRequest, { type: "observe" }>,
    progress: (text: string) => void
  ): Promise<LensResult> {
    const backend = await selectBackend();
    progress(`binding browser page for ${message.target} via ${backend.name}`);
    const session = await backend.bind({
      target: message.target,
      loadTimeoutMs: 30_000,
      navigation: "fresh",
    });
    try {
      progress(`collecting page activity for ${message.waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, message.waitMs));
      const delta = await session.readIntercepts(0, Date.now());
      const requests = delta.captures.slice(-40).map((capture) => ({
        method: capture.method,
        url: capture.url,
        status: capture.status,
        bodyPreview: capture.body.slice(0, 2000),
      }));
      const snapshot = await session.snapshot({ maxChars: 6000, html: message.html ?? false });
      progress(`collected ${requests.length} captured requests`);
      return { kind: "value", value: { snapshot, requests } } as LensResult;
    } finally {
      await finishQuietly(backend, session, "close-if-created");
    }
  }

  return {
    async handle(message, emit) {
      const progress = (text: string) =>
        emit({ type: "progress", id: message.id, message: text });
      try {
        const result =
          message.type === "call"
            ? await call(message, progress)
            : await observe(message, progress);
        emit({ type: "result", id: message.id, result });
      } catch (error) {
        emit({
          type: "result",
          id: message.id,
          result: {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
  };
}

function waitForPreferredBackend(
  backends: BrowserBackend[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribes: Array<() => void> = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      resolve();
    };
    const changed = () => {
      if (backends.some((backend) => backend.available())) finish();
    };
    for (const backend of backends) {
      unsubscribes.push(backend.onStatusChange(changed));
    }
    timer = setTimeout(finish, timeoutMs);
    changed();
  });
}

export function createSessionEngineIO(
  session: BrowserSession,
  loadTimeoutMs: number,
  progress: (message: string) => void = () => {}
): EngineIO {
  let cursor = 0;
  let captures: InterceptedResponse[] = [];
  let readDeadline = 0;
  let navigationIsFresh = session.navigated;

  const merge = (delta: InterceptDelta) => {
    if (delta.truncated) captures = [];
    captures.push(...delta.captures);
    cursor = delta.nextCursor;
  };

  return {
    async getIntercepted() {
      merge(await session.readIntercepts(cursor, readDeadline));
      readDeadline = 0;
      return [...captures];
    },
    async reload() {
      if (navigationIsFresh) {
        navigationIsFresh = false;
        progress("using the page's fresh navigation for intercept capture");
        return;
      }
      await session.reload(loadTimeoutMs);
      captures = [];
    },
    domExtract: (resolver) => session.domExtract(resolver),
    snapshot: (maxChars) => session.snapshot({ maxChars }),
    async sleep(ms) {
      // EngineIO.sleep is a polling hook: defer the next cursor read until this
      // deadline so the backend can long-poll instead of sleeping then polling.
      readDeadline = Date.now() + ms;
    },
    log: progress,
  };
}

function dispositionFor(result: LensResult | undefined): FinishDisposition {
  return result?.kind === "outcome" && result.name.startsWith("needs_")
    ? "keep"
    : "close-if-created";
}

async function finishQuietly(
  backend: BrowserBackend,
  session: BrowserSession,
  disposition: FinishDisposition
): Promise<void> {
  try {
    await backend.finish(session, disposition);
  } catch {
    // A backend loss must not replace the call's result or failure.
  }
}
