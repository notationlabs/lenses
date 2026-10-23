import {
  errorMessage,
  executeLens,
  expandTemplate,
  expandUrl,
  pageNeedsUser,
  returnsFile,
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
import { MAX_FILE_BODY_BYTES, outDirProblem, saveFile } from "./file-output.js";
import { materialiseHttpBody } from "./http-body.js";
import { RecordingMonitor } from "./recording-monitor.js";
import { appendRecordingCheckpoint } from "./recording.js";
import type {
  BrowserBackend,
  BrowserCapability,
  BrowserSession,
  FinishDisposition,
  InterceptDelta,
  TabChoice,
} from "./browser-backend.js";
import { AuthPageUnavailable, TabClosed, TabDisconnected } from "./browser-backend.js";

const MAX_HTTP_BODY_CHARS = 512 * 1024;

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
  | {
      type: "result";
      id: string;
      result: LensResult;
      authReplaySafe?: boolean;
      /** The call's tab is open but detached from the debugger; the result is the latest word on it. */
      tabDisconnected?: boolean;
    }
  | { type: "progress"; id: string; message: string };

export interface BrokerOrchestrator {
  handle(
    message: Exclude<LensBridgeRequest, { type: "control" }>,
    emit: (frame: BrokerFrame) => void,
    options?: { authRetry?: boolean; retry?: AuthRetryState }
  ): Promise<void>;
  /** Browser work that outlived its caller deadline; new calls must not overlap it. */
  busy(): { id: string; type: "call" | "observe"; lens?: string; startedAt: number } | undefined;
  watchAuthGate(
    origin: string,
    target: string,
    onExit: (reason: "moved" | "closed" | "cancelled") => void,
    resume?: boolean
  ): Promise<{ update(expiresAt: number, count: number): void; dispose(): void } | undefined>;
}

/**
 * One call's sign-in wait, across its retries: where the sign-in tab was when
 * a retry last did browser work, so the call runs once per place the tab
 * reaches, not once per poll.
 */
export interface AuthRetryState {
  ranAt?: string;
}

export function createBrokerOrchestrator(
  backends: BrowserBackend[],
  /**
   * preferredWaitMs may be a getter: the broker drops the wait to zero once it
   * knows no preferred backend is coming, so a call concedes to the fallback
   * immediately instead of paying the full grace.
   */
  options: {
    /** Lazily start browser transports only after execution actually needs one. */
    prepareBackends?: () => Promise<void>;
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
    if (!eligible.some((backend) => backend.available())) {
      await options.prepareBackends?.();
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
    // expected preferred backend stops being eligible. Until the request deadline,
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
    mutation?: MutationTracker,
    authRetry = false,
    onPerformStarted: () => void = () => {},
    retry?: AuthRetryState
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
    // A file lens writes into the caller's directory; a bad one fails before
    // any browser work.
    const fileLens = returnsFile(message.spec);
    if (fileLens) {
      const problem = await outDirProblem(message.outDir);
      if (problem) return problem;
    }
    const maxBodyBytes = fileLens ? MAX_FILE_BODY_BYTES : undefined;
    // The cache keeps the file's content, so a hit writes the file again.
    const deliver = (result: LensResult): Promise<LensResult> =>
      fileLens ? saveFile(message.spec, result, message.outDir!) : Promise.resolve(result);
    // Enforced here, not trusted from the document: a perform result is never
    // cached and never served from cache, whatever effects.cache claims.
    const cacheTtlMs = writes ? 0 : (message.spec.effects.cache ?? 0) * 1000;
    const cacheKey = `${JSON.stringify(message.spec)}|${JSON.stringify(message.params)}|${message.tab ?? ""}`;
    const cached = writes ? undefined : cache.get(cacheKey);
    if (!message.noCache && cached && cached.expiresAt > Date.now()) {
      return deliver({ ...cached.result, cached: true } as unknown as LensResult);
    }
    if (!message.noCache && cached) cache.delete(cacheKey);

    const target = expandUrl(message.spec.url, message.params);
    const loadTimeoutMs = message.spec.loadTimeoutMs ?? 30_000;
    const choice: TabChoice = {
      ...(message.tab !== undefined ? { tab: message.tab } : {}),
      ...(message.spec.tab === "reuse" ? { reuse: true } : {}),
    };
    const inPage = message.spec.navigate === "in-page";
    let sessionBackend: BrowserBackend | undefined;
    const requiredCapabilities = capabilitiesForSpec(message.spec);
    const needsPageSession =
      performs || message.spec.resolve.some((resolver) => resolver.kind !== "http");
    const needsUser = (place: { url: string; title: string }) =>
      pageNeedsUser(message.spec, place, message.params).catch(() => false);
    /**
     * The sign-in this call must not disturb, for an origin. The gate is
     * derived from the browser, not remembered here: a kept tab still sitting
     * where a needs_* outcome left it, or any tab on a page this lens's needs_*
     * rule matches (the user signing in), blocks its whole site, and keeps
     * doing so across broker restarts. A call never navigates, fetches from,
     * or evaluates in that tab; it reports the sign-in instead, and the
     * broker's wait watches the tab passively. An auth retry is blocked only
     * while the tab is still on the sign-in pages.
     */
    const signInGate = async (backend: BrowserBackend, origin: string) => {
      const gate = await findGateQuietly(backend, origin, needsUser);
      if (!gate || !authRetry) return gate;
      return (await needsUser({ url: gate.url, title: "" })) ? gate : undefined;
    };
    /** Set when a tier found a sign-in under way: the call reports it rather than any tier error. */
    let blockedBy: { url: string } | undefined;
    if (needsPageSession && !authRetry) {
      sessionBackend = await selectBackend(callDeadline, requiredCapabilities);
      const gate = await signInGate(sessionBackend, gateKey(target));
      if (gate) {
        progress(
          `a sign-in tab is already open at ${gate.url}; complete it there to unblock this site`
        );
        return gateOutcome(message.spec, gate.url);
      }
    }

    // During sign-in, read only an already-open target tab. In particular,
    // never visit the lens URL every second: that creates new login tabs and
    // can disrupt the form the user is filling out.
    if (authRetry) {
      sessionBackend ??= await selectBackend(callDeadline, requiredCapabilities);
      // While the sign-in tab is on the login pages, a retry does nothing at
      // all: the wait polls, and the tab's own navigation (watched passively)
      // tells it when the user has moved on. Then the call runs once per
      // place the tab reaches.
      const gate = await findGateQuietly(sessionBackend, gateKey(target), needsUser);
      if (gate) {
        if (await needsUser({ url: gate.url, title: "" })) return gateOutcome(message.spec, gate.url);
        if (retry?.ranAt === gate.url) return gateOutcome(message.spec, gate.url);
        if (retry) retry.ranAt = gate.url;
      }
      try {
        if (!await sessionBackend.hasOpenTarget?.(target, choice)) return gateOutcome(message.spec, target);
      } catch (error) {
        if (error instanceof TabDisconnected) return disconnectedOutcome(message.spec, error);
        throw error;
      }
    }

    // The page is bound on first use, so a call an http tier satisfies never
    // touches the browser at all.
    let session: BrowserSession | undefined;
    let recording: RecordingMonitor | undefined;
    const ensureSession = async (): Promise<BrowserSession> => {
      if (session) return session;
      sessionBackend ??= await selectBackend(callDeadline);
      // A sign-in may have begun since the call started (between tiers).
      const gate = await signInGate(sessionBackend, gateKey(target));
      if (gate) {
        blockedBy = gate;
        throw new Error(`a sign-in is under way at ${gate.url}; not touching its tab`);
      }
      progress(`binding browser page for ${target} via ${sessionBackend.name}`);
      session = await sessionBackend.bind({
        target,
        ...choice,
        ...(inPage ? { inPage } : {}),
        ...(message.spec.ready ? { ready: expandTemplate(message.spec.ready, message.params) } : {}),
        holdAt: (page) => pageNeedsUser(message.spec, page, message.params),
        ...(fileLens ? { maxBodyBytes, blockDownloads: true } : {}),
        loadTimeoutMs,
        existingOnly: authRetry,
        // A document with perform steps binds with "reuse": a reload only
        // ever comes from an explicit `navigate` step, so a send cannot
        // reload the chat it is about to type into. Intercept-implies-fresh
        // stays for read-only documents.
        navigation: performs || authRetry
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
        return directHttpFetch(request, loadTimeoutMs, maxBodyBytes);
      }
      const required: BrowserCapability[] = request.body
        ? ["credentialed-http-body"]
        : ["credentialed-http"];
      if (request.credentials === "same-origin-page") {
        required.push("same-origin-page-http");
      }
      let requestBackend: BrowserBackend;
      try {
        requestBackend = await selectBackend(callDeadline, required);
      } catch (error) {
        if (request.credentials === "same-origin-page") {
          throw requiredBackendUnavailable(error);
        }
        throw error;
      }
      // A credentialed request runs in (or shares the cookies of) a tab on the
      // site: never while the user is signing in there.
      const gate = await signInGate(requestBackend, gateKey(request.url));
      if (gate) {
        blockedBy = gate;
        throw new Error(`a sign-in is under way at ${gate.url}; not fetching with its cookies`);
      }
      progress(
        request.credentials === "same-origin-page"
          ? `executing credentialed ${request.method} in same-origin page context via ${requestBackend.name}`
          : `fetching ${request.url} with browser cookies via ${requestBackend.name}`
      );
      // Strip engine-only policy fields: backend wire protocols reject unknown keys.
      const response = await requestBackend.httpFetch?.({
        existingOnly: authRetry,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        ...(request.credentials === "same-origin-page"
          ? { context: "same-origin-page" as const }
          : {}),
        ...(maxBodyBytes ? { maxBodyBytes } : {}),
      });
      if (!response && request.credentials === "same-origin-page") {
        throw requiredBackendUnavailable();
      }
      return response;
    };

    const io = createSessionEngineIO(
      ensureSession,
      loadTimeoutMs,
      progress,
      httpFetch,
      mutation,
      authRetry,
      onPerformStarted
    );
    let result: LensResult | undefined;
    try {
      result = await executeLens(message.spec, message.params, io);
      if (blockedBy) {
        progress(`a sign-in is under way at ${blockedBy.url}; complete it there to unblock this site`);
        result = gateOutcome(message.spec, blockedBy.url);
        return result;
      }
      // Name the tab only when it outlives this call: an ordinary created tab
      // is closed on the way out, and its id would point nowhere.
      const disposition = authRetry ? "close-if-created" : dispositionFor(result);
      if (session?.tab && (!session.created || choice.reuse || disposition === "keep")) {
        result = { ...result, tab: session.tab };
      }
      if (!message.noCache && result.kind === "value" && !result.partial && cacheTtlMs > 0) {
        // A cached result names no tab: the tab may be gone when it is served.
        const { tab: _tab, ...untabbed } = result;
        cache.set(cacheKey, { result: untabbed, expiresAt: Date.now() + cacheTtlMs });
      }
      result = await deliver(result);
      return result;
    } catch (error) {
      if (blockedBy) {
        progress(`a sign-in is under way at ${blockedBy.url}; complete it there to unblock this site`);
        result = gateOutcome(message.spec, blockedBy.url);
        return result;
      }
      if (authRetry && error instanceof AuthPageUnavailable) {
        return gateOutcome(message.spec, target);
      }
      if (error instanceof TabClosed) {
        return { kind: "error", code: "tab_closed", message: error.message };
      }
      if (error instanceof TabDisconnected) return disconnectedOutcome(message.spec, error);
      throw error;
    } finally {
      if (sessionBackend && session) {
        try {
          if (recording) await recording.finish();
        } finally {
          await finishQuietly(sessionBackend, session, authRetry ? "close-if-created" : dispositionFor(result));
        }
      }
    }
  }

  async function directHttpFetch(
    request: HttpFetchRequest,
    timeoutMs: number,
    maxBodyBytes = MAX_HTTP_BODY_CHARS
  ): Promise<InterceptedResponse> {
    const init = materialiseHttpBody(request.body, request.headers);
    const response = await fetch(request.url, {
      method: request.method,
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.text()).slice(0, maxBodyBytes);
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
    progress(`binding browser page for ${message.target ?? `tab ${message.tab}`} via ${backend.name}`);
    let session: BrowserSession;
    try {
      // A named tab is observed without a document load: in place, or routed
      // in-page to the target, so tab-held sessions survive authoring.
      session = await backend.bind(
        message.tab !== undefined
          ? {
              tab: message.tab,
              ...(message.target !== undefined ? { target: message.target } : {}),
              inPage: true,
              loadTimeoutMs: 30_000,
              navigation: "reuse",
            }
          : { target: message.target, loadTimeoutMs: 30_000, navigation: "fresh" }
      );
    } catch (error) {
      if (error instanceof TabClosed) return { kind: "error", code: "tab_closed", message: error.message };
      if (error instanceof TabDisconnected) return disconnectedOutcome(undefined, error);
      throw error;
    }
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
      return {
        kind: "value",
        value: { snapshot, requests },
        ...(message.tab !== undefined ? { tab: session.tab } : {}),
      } as LensResult;
    } finally {
      await finishQuietly(backend, session, "close-if-created");
    }
  }

  return {
    busy: () => backgroundCall,
    async watchAuthGate(origin, target, onExit, resume = false) {
      for (const candidate of backends) {
        if (!candidate.available() || (!resume && !await candidate.findAuthGate(origin))) continue;
        // A multi-page login can move the kept tab before the retry finishes.
        // Reattach only for that retry, not for a later unrelated auth wait.
        const prompt = await candidate.watchAuthGate?.(origin, onExit, resume);
        if (prompt) return prompt;
      }
      if (resume) return undefined; // Never open a replacement tab mid-login.
      const backend = await selectBackend(Date.now() + 15_000);
      // The first outcome may come from an HTTP tier without binding any page.
      if (!await backend.openAuthGate?.(origin, target)) return undefined;
      return backend.watchAuthGate?.(origin, onExit, resume);
    },
    async handle(message, emit, options = {}) {
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
        let performStarted = false;
        const mutation =
          message.type === "call" &&
          (message.spec.perform?.length ?? 0) > 0 && message.spec.effects.idempotent !== true
            ? createMutationTracker()
            : undefined;
        const work =
          message.type === "call"
            ? call(message, progress, mutation, options.authRetry, () => { performStarted = true; }, options.retry)
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
        emit({
          type: "result", id: message.id, result,
          ...(disconnectedResults.has(result) ? { tabDisconnected: true } : {}),
          ...(message.type === "call" ? {
            authReplaySafe: !specWrites(message.spec) ||
              ((message.spec.perform?.length ?? 0) > 0 && !performStarted),
          } : {}),
        });
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
  // A later page tier is an explicit fallback when ordinary browser HTTP is
  // unsupported. Same-origin requirements are selected again per request, so
  // mixed chains may use Playwright Extension for a cheap read and CDP for a mutation.
  if (spec.resolve.some((resolver) => resolver.kind !== "http")) {
    return ["browser-session"];
  }
  let credentialed = false;
  let body = false;
  let sameOriginPage = false;
  for (const resolver of spec.resolve) {
    if (resolver.kind !== "http") continue;
    const requests = resolver.sources
      ? Object.values(resolver.sources).map((source) => ({
          credentials: source.credentials ?? resolver.credentials ?? false,
          body: source.body,
        }))
      : [{ credentials: resolver.credentials ?? false, body: resolver.body }];
    for (const request of requests) {
      if (!request.credentials) continue;
      credentialed = true;
      body ||= request.body !== undefined;
      sameOriginPage ||= request.credentials === "same-origin-page";
    }
  }
  const required: BrowserCapability[] = body
    ? ["credentialed-http-body"]
    : credentialed
      ? ["credentialed-http"]
      : ["browser-session"];
  if (sameOriginPage) required.push("same-origin-page-http");
  return required;
}

function backendSupports(
  backend: BrowserBackend,
  capability: BrowserCapability
): boolean {
  if (backend.supports) return backend.supports(capability);
  // Backends that omit supports() advertise sessions; httpFetch means cookie
  // fetch. Same-origin page fetch is not assumed.
  if (capability === "same-origin-page-http") return false;
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
          : capability === "same-origin-page-http"
            ? "same-origin page HTTP requests"
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
      " Approve the Playwright Extension connect page, or enable the CDP fallback at chrome://inspect/#remote-debugging."
  );
}

function requiredBackendUnavailable(cause?: unknown): Error & {
  code: "required_backend_unavailable";
} {
  const error = new Error(
    "This request requires a same-origin page context, but no compatible browser backend is available." +
      (cause ? ` ${errorMessage(cause)}` : "")
  ) as Error & { code: "required_backend_unavailable" };
  error.code = "required_backend_unavailable";
  return error;
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
        // CDP absence/failure must not end an expected preferred backend's rendezvous.
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
  mutation?: MutationTracker,
  authRetry = false,
  onPerformStarted: () => void = () => {}
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
      // Never disturb the original login form. Once the kept tab has left
      // that place, reloadOnMiss may generate fresh authenticated traffic.
      if (authRetry && session.atAuthGate !== false) return;
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
        onPerformStarted();
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
  if ("drop" in step) return `drop ${safeSelector(step.drop)} (file redacted)`;
  if ("fill" in step) return `fill ${safeSelector(step.fill)} (value redacted)`;
  if ("click" in step) {
    return `click ${safeSelector(step.click)}${step.text !== undefined ? " (text redacted)" : ""}`;
  }
  if ("submit" in step) return `submit ${safeSelector(step.submit)}`;
  const form = step.wait.appears !== undefined
    ? "appears"
    : step.wait.gone !== undefined
      ? "gone"
      : "increases";
  return `wait ${form} ${safeSelector(step.wait[form] ?? "")}${step.wait.text !== undefined ? " (text redacted)" : ""}`;
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
  origin: string,
  needsUser?: (place: { url: string; title: string }) => Promise<boolean>
): Promise<{ url: string; target: string } | undefined> {
  try {
    return await backend.findAuthGate(origin, needsUser);
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
  const names = [
    ...spec.resolve.flatMap((resolver) =>
      "exceptions" in resolver ? Object.keys(resolver.exceptions ?? {}) : []
    ),
    ...Object.keys(spec.exceptions ?? {}),
  ];
  const declared = names.includes("needs_auth")
    ? "needs_auth"
    : names.find((name) => name.startsWith("needs_"));
  return {
    kind: "outcome",
    name: declared ?? "needs_auth",
    value: { url: signInUrl },
    resolver: spec.resolve[0]?.kind ?? "dom",
  };
}

const disconnectedResults = new WeakSet<LensResult>();

/**
 * The result for a call whose tab is open but detached from the debugger
 * (see TabDisconnected). Reported as the sign-in outcome, because that is
 * what the user is doing there, so the auth wait keeps watching it until the
 * extension re-attaches it. The browser's own reason for refusing the last
 * re-attach is passed through verbatim as `detail`.
 */
function disconnectedOutcome(spec: LensSpec | undefined, error: TabDisconnected): LensResult {
  const base = spec ? gateOutcome(spec, error.url) : undefined;
  const result: LensResult = {
    kind: "outcome",
    name: base?.kind === "outcome" ? base.name : "needs_auth",
    value: { url: error.url, tab: error.tab, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
    hint: `Finish signing in in the open tab (${error.tab}) in the Lenses tab group, then retry.`,
    resolver: spec?.resolve[0]?.kind ?? "dom",
    tab: error.tab,
  };
  disconnectedResults.add(result);
  return result;
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
