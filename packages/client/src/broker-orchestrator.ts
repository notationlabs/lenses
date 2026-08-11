import {
  errorMessage,
  executeLens,
  expandUrl,
  type EngineIO,
  type HttpFetchRequest,
  type InterceptedResponse,
  type LensBridgeRequest,
  type LensResult,
  type LensSpec,
} from "@djgrant/lenses-core";
import { RecordingMonitor } from "./recording-monitor.js";
import { appendRecordingCheckpoint } from "./recording.js";
import type {
  BrowserBackend,
  BrowserSession,
  FinishDisposition,
  InterceptDelta,
} from "./browser-backend.js";

const MAX_HTTP_BODY_CHARS = 512 * 1024;

/**
 * Whether any tier of this spec can touch a browser. A spec of credential-free
 * http tiers runs entirely in the broker's own process, so the daemon must not
 * launch Chrome for it and the orchestrator must not wait for a backend.
 */
export function specNeedsBrowser(spec: LensSpec): boolean {
  if (spec.perform !== undefined) return true;
  return spec.resolve.some(
    (resolver) => resolver.kind !== "http" || resolver.credentials === true
  );
}

/**
 * Consent gate for a spec with perform steps: default deny, opened only by
 * the caller's explicit flag. Every write decision passes through here, so
 * this is also where a future host policy (a config allow/deny list) belongs.
 */
function writesAllowed(
  message: Extract<LensBridgeRequest, { type: "call" }>
): boolean {
  return message.allowWrites === true;
}

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
    // Consent comes before everything — no page bind, no cache read, no tier:
    // a denied write call must leave the browser exactly as it found it.
    const performs = (message.spec.perform?.length ?? 0) > 0;
    if (performs && !writesAllowed(message)) {
      return {
        kind: "error",
        code: "writes_not_allowed",
        message: `${message.spec.name} performs writes; call it with allowWrites: true to consent`,
      };
    }
    // Enforced here, not trusted from the document: a perform result is never
    // cached and never served from cache, whatever effects.cache claims.
    const cacheTtlMs = performs ? 0 : (message.spec.effects.cache ?? 0) * 1000;
    const cacheKey = `${JSON.stringify(message.spec)}|${JSON.stringify(message.params)}`;
    const cached = performs ? undefined : cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true } as unknown as LensResult;
    }
    if (cached) cache.delete(cacheKey);

    const target = expandUrl(message.spec.url, message.params);
    const loadTimeoutMs = message.spec.loadTimeoutMs ?? 30_000;
    let backend: BrowserBackend | undefined;
    if (specNeedsBrowser(message.spec)) {
      backend = await selectBackend();
      // The gate is derived from the browser, not remembered here: a kept tab
      // still sitting where a needs_* outcome left it blocks its whole site,
      // and it keeps doing so across broker restarts.
      const gate = await findGateQuietly(backend, gateKey(target));
      if (gate) {
        progress(
          `a sign-in tab is already open at ${gate.url}; complete it there to unblock this site`
        );
        return gateOutcome(message.spec, gate.url);
      }
    }

    // The page is bound on first use, so a call an http tier satisfies never
    // touches the browser at all.
    let session: BrowserSession | undefined;
    let recording: RecordingMonitor | undefined;
    const ensureSession = async (): Promise<BrowserSession> => {
      if (session) return session;
      backend ??= await selectBackend();
      progress(`binding browser page for ${target} via ${backend.name}`);
      session = await backend.bind({
        target,
        loadTimeoutMs,
        // A document with perform steps binds with "reuse": a reload only
        // ever comes from an explicit `navigate` step, so a send cannot
        // reload the chat it is about to type into. Intercept-implies-fresh
        // stays for read-only documents.
        navigation: performs
          ? "reuse"
          : message.spec.resolve.some((resolver) => resolver.kind === "intercept")
            ? "fresh"
            : "reuse",
      });
      progress(`bound page${session.created ? " (created)" : " (existing)"}`);
      if (message.recording) {
        recording = new RecordingMonitor(session, (checkpoint) =>
          appendRecordingCheckpoint(message.recording!, checkpoint)
        );
        await recording.start();
        progress(`recording browser states in ${message.recording.path}`);
      }
      return session;
    };
    const httpFetch = async (
      request: HttpFetchRequest
    ): Promise<InterceptedResponse | undefined> => {
      if (!request.credentials) {
        progress(`fetching ${request.url} directly`);
        return directHttpFetch(request, loadTimeoutMs);
      }
      backend ??= await selectBackend();
      progress(`fetching ${request.url} with browser cookies via ${backend.name}`);
      // Strip the engine's `credentials` flag: the backend request crosses the
      // extension's strict protocol schema, which rejects unknown keys.
      return backend.httpFetch?.({
        method: request.method,
        url: request.url,
        headers: request.headers,
      });
    };

    const io = createSessionEngineIO(ensureSession, loadTimeoutMs, progress, httpFetch);
    let result: LensResult | undefined;
    try {
      result = await executeLens(message.spec, message.params, io);
      if (result.kind === "value" && !result.partial && cacheTtlMs > 0) {
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
      }
      return result;
    } finally {
      if (backend && session) {
        try {
          if (recording) await recording.finish();
        } finally {
          await finishQuietly(backend, session, dispositionFor(result));
        }
      }
    }
  }

  async function directHttpFetch(
    request: HttpFetchRequest,
    timeoutMs: number
  ): Promise<InterceptedResponse> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.text()).slice(0, MAX_HTTP_BODY_CHARS);
    return {
      url: response.url || request.url,
      method: request.method,
      status: response.status,
      body,
      timestamp: Date.now(),
    };
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
          result: { kind: "error", message: errorMessage(error) },
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
  getSession: () => Promise<BrowserSession>,
  loadTimeoutMs: number,
  progress: (message: string) => void = () => {},
  httpFetch?: EngineIO["httpFetch"]
): EngineIO {
  let cursor = 0;
  let captures: InterceptedResponse[] = [];
  let readDeadline = 0;
  // Read from the session on first acquisition: the page is bound lazily, so
  // whether its navigation is fresh is unknowable before a page op needs it.
  let navigationIsFresh: boolean | undefined;

  const acquire = async (): Promise<BrowserSession> => {
    const session = await getSession();
    navigationIsFresh ??= session.navigated;
    return session;
  };

  const merge = (delta: InterceptDelta) => {
    if (delta.truncated) captures = [];
    captures.push(...delta.captures);
    cursor = delta.nextCursor;
  };

  return {
    async getIntercepted() {
      const session = await acquire();
      merge(await session.readIntercepts(cursor, readDeadline));
      readDeadline = 0;
      return [...captures];
    },
    async reload() {
      const session = await acquire();
      if (navigationIsFresh) {
        navigationIsFresh = false;
        progress("using the page's fresh navigation for intercept capture");
        return;
      }
      await session.reload(loadTimeoutMs);
      captures = [];
    },
    domExtract: async (resolver) => (await acquire()).domExtract(resolver),
    // Lazy like domExtract: perform binds the page on first use, so the
    // consent-denied path above it never touches the browser at all.
    perform: async (steps) => (await acquire()).perform(steps),
    snapshot: async (maxChars) => (await acquire()).snapshot({ maxChars }),
    ...(httpFetch ? { httpFetch } : {}),
    async sleep(ms) {
      // EngineIO.sleep is a polling hook: defer the next cursor read until this
      // deadline so the backend can long-poll instead of sleeping then polling.
      readDeadline = Date.now() + ms;
    },
    log: progress,
  };
}

function gateKey(target: string): string {
  try {
    return new URL(target).origin;
  } catch {
    return target;
  }
}

async function findGateQuietly(
  backend: BrowserBackend,
  origin: string
): Promise<{ url: string; target: string } | undefined> {
  try {
    return await backend.findAuthGate(origin);
  } catch {
    // An unanswerable probe must not veto the call; bind and find out.
    return undefined;
  }
}

/**
 * The result for a call the gate short-circuited. The blocked call never ran
 * its lens, so the outcome is synthesised: named after the spec's own needs_*
 * outcome where it declares one, and carrying the sign-in URL as the value in
 * place of the detection context the lens would have seen.
 */
function gateOutcome(spec: LensSpec, signInUrl: string): LensResult {
  const declared = [
    ...spec.resolve.flatMap((resolver) =>
      "detect" in resolver ? Object.keys(resolver.detect ?? {}) : []
    ),
    ...Object.keys(spec.detect ?? {}),
    ...Object.keys(spec.outcomes ?? {}),
  ].find((name) => name.startsWith("needs_"));
  return {
    kind: "outcome",
    name: declared ?? "needs_auth",
    value: { url: signInUrl },
    resolver: spec.resolve[0]?.kind ?? "dom",
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
