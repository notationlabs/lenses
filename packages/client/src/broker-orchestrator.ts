import {
  errorMessage,
  executeLens,
  expandUrl,
  specWrites,
  type EngineIO,
  type HttpFetchRequest,
  type InterceptedResponse,
  type LensBridgeRequest,
  type LensResult,
  type LensSpec,
  type MutationState,
  type PerformStep,
} from "@djgrant/lenses-core";
import { materialiseHttpBody } from "./http-body.js";
import { RecordingMonitor } from "./recording-monitor.js";
import { appendRecordingCheckpoint } from "./recording.js";
import type {
  BrowserBackend,
  BrowserCapability,
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
 * Consent gate for a spec with page steps or mutating HTTP requests: default deny, opened only by
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
  /** Browser work that outlived its caller deadline; new calls must not overlap it. */
  busy(): { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;
}

export function createBrokerOrchestrator(
  backends: BrowserBackend[],
  /**
   * preferredWaitMs may be a getter: the broker drops the wait to zero once it
   * knows no preferred backend is coming, so a call concedes to the fallback
   * immediately instead of paying the full grace.
   */
  options: {
    preferredWaitMs?: number | (() => number);
    /**
     * Start making the fallback available after the preferred grace. Selection
     * still races that work against a late preferred attachment, so an
     * unavailable fallback is never pinned merely because the grace elapsed.
     */
    prepareFallback?: () => Promise<void>;
  } = {}
): BrokerOrchestrator {
  if (backends.length === 0) throw new Error("broker orchestrator requires a browser backend");
  const cache = new Map<string, { result: LensResult; expiresAt: number }>();
  let backgroundCall: { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;

  function currentBackend(eligible = backends): BrowserBackend {
    return eligible.find((backend) => backend.available()) ?? eligible[eligible.length - 1];
  }

  async function selectBackend(
    rendezvousDeadline: number,
    requiredCapabilities: BrowserCapability[] = ["browser-session"]
  ): Promise<BrowserBackend> {
    const eligible = backends.filter((backend) =>
      requiredCapabilities.every((capability) => backendSupports(backend, capability))
    );
    if (eligible.length === 0) {
      throw capabilityMismatch(requiredCapabilities, backends);
    }
    let selected = currentBackend(eligible);
    // If the preferred backend was excluded by capability negotiation, prepare
    // the capable fallback now instead of pinning the connected-but-stale one.
    if (
      !selected.available() &&
      options.prepareFallback &&
      selected === backends[backends.length - 1] &&
      !eligible.includes(backends[0])
    ) {
      let fallbackError: unknown;
      try {
        await options.prepareFallback();
      } catch (error) {
        fallbackError = error;
      }
      selected = currentBackend(eligible);
      if (!selected.available()) {
        throw capabilityMismatch(requiredCapabilities, backends, fallbackError);
      }
      return selected;
    }
    const preferredWaitMs =
      (typeof options.preferredWaitMs === "function"
        ? options.preferredWaitMs()
        : options.preferredWaitMs) ?? 0;
    if (
      selected.available() ||
      selected !== backends[backends.length - 1] ||
      preferredWaitMs <= 0 ||
      eligible.length === 1
    ) {
      return selected;
    }
    const preferred = eligible.slice(0, -1);
    await waitForPreferredBackend(
      preferred,
      Math.min(preferredWaitMs, Math.max(0, rendezvousDeadline - Date.now()))
    );
    const afterGrace = currentBackend(eligible);
    if (afterGrace.available() || !options.prepareFallback) return afterGrace;

    // The grace controls when fallback preparation starts, not when the
    // expected extension stops being eligible. Until the request deadline,
    // whichever backend actually becomes available first wins; a failed CDP
    // probe is merely remembered for the bounded no-backend failure.
    return waitForAvailableBackend(
      eligible,
      options.prepareFallback,
      rendezvousDeadline,
      () => currentBackend(eligible)
    );
  }

  async function call(
    message: Extract<LensBridgeRequest, { type: "call" }>,
    progress: (text: string) => void,
    mutation?: MutationTracker
  ): Promise<LensResult> {
    // The client timeout covers the complete call, including recorder setup
    // and final capture; screenshot RPCs must use its remaining budget rather
    // than an unrelated 30-second default.
    const callDeadline = message.deadline ?? Date.now() + message.timeoutMs;
    // Consent comes before everything — no page bind, no cache read, no tier:
    // a denied write call must leave the browser exactly as it found it.
    const performs = (message.spec.perform?.length ?? 0) > 0;
    const writes = specWrites(message.spec);
    if (writes && !writesAllowed(message)) {
      return {
        kind: "error",
        code: "writes_not_allowed",
        message: `${message.spec.name} performs writes; call it with allowWrites: true to consent`,
      };
    }
    // Enforced here, not trusted from the document: a perform result is never
    // cached and never served from cache, whatever effects.cache claims.
    const cacheTtlMs = writes ? 0 : (message.spec.effects.cache ?? 0) * 1000;
    const cacheKey = `${JSON.stringify(message.spec)}|${JSON.stringify(message.params)}`;
    const cached = writes ? undefined : cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true } as unknown as LensResult;
    }
    if (cached) cache.delete(cacheKey);

    const target = expandUrl(message.spec.url, message.params);
    const loadTimeoutMs = message.spec.loadTimeoutMs ?? 30_000;
    let backend: BrowserBackend | undefined;
    const requiredCapabilities = capabilitiesForSpec(message.spec);
    if (specNeedsBrowser(message.spec)) {
      backend = await selectBackend(callDeadline, requiredCapabilities);
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
      backend ??= await selectBackend(callDeadline);
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
        recording = new RecordingMonitor(
          session,
          (checkpoint) => appendRecordingCheckpoint(message.recording!, checkpoint),
          callDeadline
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
      backend ??= await selectBackend(
        callDeadline,
        request.body ? ["credentialed-http-body"] : ["credentialed-http"]
      );
      progress(`fetching ${request.url} with browser cookies via ${backend.name}`);
      // Strip the engine's `credentials` flag: the backend request crosses the
      // extension's strict protocol schema, which rejects unknown keys.
      return backend.httpFetch?.({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
      });
    };

    const io = createSessionEngineIO(
      ensureSession,
      loadTimeoutMs,
      progress,
      httpFetch,
      mutation
    );
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
    const init = materialiseHttpBody(request.body, request.headers);
    const response = await fetch(request.url, {
      method: request.method,
      ...init,
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
    const backend = await selectBackend(
      message.deadline ?? Date.now() + 60_000
    );
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
    busy: () => backgroundCall,
    async handle(message, emit) {
      if (backgroundCall) {
        emit({
          type: "result",
          id: message.id,
          result: {
            kind: "error",
            code: "broker_busy",
            message: `broker is still completing timed-out ${backgroundCall.id}; retry after it settles or restart the broker`,
          },
        });
        return;
      }
      let completed = false;
      const progress = (text: string) => {
        if (!completed) emit({ type: "progress", id: message.id, message: text });
      };
      try {
        const mutation =
          message.type === "call" &&
          (message.spec.perform?.length ?? 0) > 0 &&
          message.spec.effects.idempotent !== true
            ? createMutationTracker()
            : undefined;
        const work =
          message.type === "call"
            ? call(message, progress, mutation)
            : observe(message, progress);
        const result =
          message.type === "call"
            ? await withinCallDeadline(work, message, mutation, () => {
                backgroundCall = {
                  id: message.id,
                  type: message.type,
                  lens: message.spec.name,
                  startedAt: Date.now(),
                };
                void work.then(
                  () => {
                    if (backgroundCall?.id === message.id) backgroundCall = undefined;
                  },
                  () => {
                    if (backgroundCall?.id === message.id) backgroundCall = undefined;
                  }
                );
              })
            : await work;
        completed = true;
        emit({ type: "result", id: message.id, result });
      } catch (error) {
        completed = true;
        emit({
          type: "result",
          id: message.id,
          result: { kind: "error", message: errorMessage(error) },
        });
      }
    },
  };
}

async function withinCallDeadline(
  work: Promise<LensResult>,
  message: Extract<LensBridgeRequest, { type: "call" }>,
  mutation?: MutationTracker,
  onTimeout: () => void = () => {}
): Promise<LensResult> {
  const remaining = Math.max(0, (message.deadline ?? Date.now() + message.timeoutMs) - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<LensResult>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      const recording = message.recording ? `, recording ${message.recording.callId}` : "";
      resolve({
        kind: "error",
        message: `call ${message.id} for ${message.spec.name}${recording} timed out after ${message.timeoutMs}ms`,
        ...(mutation ? { mutation: mutation.snapshot() } : {}),
      });
    }, remaining);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function capabilitiesForSpec(spec: LensSpec): BrowserCapability[] {
  // A later page tier is an explicit fallback when browser HTTP is unsupported;
  // require HTTP capability only when the document has no such route.
  if (spec.resolve.some((resolver) => resolver.kind !== "http")) {
    return ["browser-session"];
  }
  const credentialed = spec.resolve.filter(
    (resolver): resolver is Extract<typeof resolver, { kind: "http" }> =>
      resolver.kind === "http" && resolver.credentials === true
  );
  if (credentialed.some((resolver) => resolver.body !== undefined)) {
    return ["credentialed-http-body"];
  }
  if (credentialed.length > 0) return ["credentialed-http"];
  return ["browser-session"];
}

function backendSupports(
  backend: BrowserBackend,
  capability: BrowserCapability
): boolean {
  if (backend.supports) return backend.supports(capability);
  // Compatibility for custom transports/backends built against the previous
  // interface. Session support was implicit; httpFetch advertised cookie fetch.
  return capability === "browser-session" || backend.httpFetch !== undefined;
}

function capabilityMismatch(
  required: BrowserCapability[],
  backends: BrowserBackend[],
  fallbackError?: unknown
): Error {
  const requirement = required
    .map((capability) =>
      capability === "credentialed-http-body"
        ? "credentialed HTTP request bodies"
        : capability === "credentialed-http"
          ? "credentialed HTTP requests"
          : "browser sessions"
    )
    .join(", ");
  const connected = backends
    .filter((backend) => backend.available() || backend.info().diagnostic)
    .map((backend) => {
      const info = backend.info();
      const version = info.version ? ` ${info.version}` : "";
      const capabilities = info.capabilities?.length
        ? `; negotiated capabilities: ${info.capabilities.join(", ")}`
        : "; capabilities not reported";
      const diagnostic = info.diagnostic ? `; ${info.diagnostic}` : "";
      return `${backend.name}${version}${capabilities}${diagnostic}`;
    })
    .join(". ");
  const fallback = fallbackError
    ? ` CDP fallback could not be acquired: ${errorMessage(fallbackError)}.`
    : "";
  return new Error(
    `No available browser backend supports ${requirement}.` +
      (connected ? ` ${connected}.` : "") +
      fallback +
      " Update the Lens CLI and Chrome extension together and reload the extension at chrome://extensions, or enable the CDP fallback."
  );
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

function waitForAvailableBackend(
  backends: BrowserBackend[],
  prepareFallback: () => Promise<void>,
  deadline: number,
  currentBackend: () => BrowserBackend
): Promise<BrowserBackend> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fallbackError: unknown;
    const unsubscribes: Array<() => void> = [];
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          fallbackError ??
            new Error(
              "no browser backend became available before the request deadline"
            )
        ),
      Math.max(0, deadline - Date.now())
    );
    const finish = (backend?: BrowserBackend, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (backend) resolve(backend);
      else reject(error);
    };
    const changed = () => {
      const backend = currentBackend();
      if (backend.available()) finish(backend);
    };
    for (const backend of backends) {
      unsubscribes.push(backend.onStatusChange(changed));
    }
    void Promise.resolve()
      .then(prepareFallback)
      .then(changed, (error) => {
        // CDP absence/failure must not end an expected extension's rendezvous.
        fallbackError = error;
        changed();
      });
    changed();
  });
}

export function createSessionEngineIO(
  getSession: () => Promise<BrowserSession>,
  loadTimeoutMs: number,
  progress: (message: string) => void = () => {},
  httpFetch?: EngineIO["httpFetch"],
  mutation?: MutationTracker
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
    // Dispatch one step at a time so progress and timeout diagnostics describe
    // only work the browser acknowledged. This does not retry a step: a lost
    // acknowledgement remains ambiguous and immediately rejects the call.
    perform: async (steps) => {
      const session = await acquire();
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        mutation?.started(step);
        progress(`perform step ${index + 1}/${steps.length} started: ${describePerformStep(step)}`);
        const result = await session.perform([step]);
        mutation?.acknowledged(index, result.failedStep === undefined);
        if (result.failedStep !== undefined) {
          progress(`perform step ${index + 1}/${steps.length} failed`);
          return { ...result, failedStep: index };
        }
        progress(`perform step ${index + 1}/${steps.length} completed`);
      }
      mutation?.completed();
      return {};
    },
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

interface MutationTracker {
  started(step: PerformStep): void;
  acknowledged(index: number, succeeded: boolean): void;
  completed(): void;
  snapshot(): MutationState;
}

function createMutationTracker(): MutationTracker {
  let performStarted = false;
  let actionDispatched = false;
  let lastAcknowledgedStep: number | undefined;
  let performed: MutationState["performed"] = "no";
  return {
    started(step) {
      performStarted = true;
      performed = "unknown";
      if (!("wait" in step)) actionDispatched = true;
    },
    acknowledged(index, succeeded) {
      lastAcknowledgedStep = index;
      if (!succeeded) performed = "no";
    },
    completed() {
      performed = "yes";
    },
    snapshot() {
      return {
        performStarted,
        ...(lastAcknowledgedStep !== undefined ? { lastAcknowledgedStep } : {}),
        submissionMayHaveHappened: actionDispatched,
        performed,
      };
    },
  };
}

const MAX_DIAGNOSTIC_SELECTOR_CHARS = 120;

function describePerformStep(step: PerformStep): string {
  if ("navigate" in step) return "navigate fresh";
  if ("press" in step) return `press ${truncateDiagnostic(step.press)}`;
  if ("fill" in step) return `fill ${safeSelector(step.fill)} (value redacted)`;
  if ("click" in step) return `click ${safeSelector(step.click)}`;
  if ("submit" in step) return `submit ${safeSelector(step.submit)}`;
  const form = step.wait.appears !== undefined
    ? "appears"
    : step.wait.gone !== undefined
      ? "gone"
      : "increases";
  return `wait ${form} ${safeSelector(step.wait[form] ?? "")}`;
}

function safeSelector(selector: string): string {
  // Selectors occasionally contain credentials in attribute equality tests.
  // Redact likely secret-bearing values, flatten controls, then impose a hard
  // bound so verbose logs cannot become an accidental data dump.
  const redacted = selector
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /(\[(?:[^\]]*?(?:value|password|token|secret|auth|api[-_]?key)[^\]]*?=)\s*)(["'])(.*?)\2/gi,
      "$1\"<redacted>\""
    );
  return truncateDiagnostic(redacted);
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_SELECTOR_CHARS
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_SELECTOR_CHARS - 1)}…`;
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
