import type {
  AuthGate,
  DomResolver,
  InterceptDelta,
  HttpFetchBody,
  InterceptedResponse,
  PageSnapshot,
  PerformResult,
  PerformStep,
} from "@djgrant/lenses-core";

export type { InterceptDelta };

export interface BackendHttpRequest {
  method: string;
  /** A sign-in recheck must never open a temporary browser tab. */
  existingOnly?: boolean;
  url: string;
  headers?: Record<string, string>;
  body?: HttpFetchBody;
  /** Execute in a matching top-level page rather than a cookie-only fetch. */
  context?: "same-origin-page";
  /** Keep response bodies up to this size; a file lens reads larger ones. */
  maxBodyBytes?: number;
}

export type BrowserCapability =
  | "browser-session"
  | "credentialed-http"
  | "credentialed-http-body"
  | "same-origin-page-http";

export interface BackendInfo {
  name: string;
  detail?: string;
  version?: string;
  protocolMajor?: number;
  /** Version found in the configured Chrome profile; not a runtime attestation. */
  installedVersion?: string;
  /** Negotiated wire capabilities (backend-specific names). */
  capabilities?: string[];
  /** A handshake, compatibility, or connection problem that explains unavailability. */
  diagnostic?: string;
  /** Connection attempts since this broker started (zero when not applicable). */
  reconnectAttempts?: number;
  /** Whether this backend can execute fetch in the target site's page origin. */
  sameOriginPageRequests: boolean;
}

export class AuthPageUnavailable extends Error {}

/** A `tab` id named a tab that is gone (or that this broker never issued). */
export class TabClosed extends Error {
  readonly code = "tab_closed";
}

/**
 * The tab is still open in the group, but the debugger cannot reach it yet:
 * Chrome detaches a whole tab while another extension's frame (a password
 * manager's) is in the page. The user is most likely signing in there.
 */
export class TabDisconnected extends Error {
  constructor(
    /** Broker id of the tab. */
    readonly tab: string,
    /** Where the tab was last seen. */
    readonly url: string,
    /** Why the extension's last re-attach failed, verbatim from the browser. */
    readonly detail?: string
  ) {
    super(`tab ${tab} is open but the browser debugger cannot reach it${detail ? `: ${detail}` : ""}`);
  }
}

/** How a call picks its tab; shared by bind and the auth-retry presence check. */
export interface TabChoice {
  /** An explicit broker tab id from an earlier result. */
  tab?: string;
  /** Lens `tab: "reuse"`: the tab this origin used last, never closed. */
  reuse?: boolean;
}

export interface BindRequest extends TabChoice {
  /** Omitted only with `tab`: bind the tab where it is. */
  target?: string;
  /** Refuse to create or navigate a tab while checking sign-in. */
  existingOnly?: boolean;
  loadTimeoutMs: number;
  navigation: "reuse" | "fresh";
  /** Lens `navigate: "in-page"`: route with pushState + popstate; never load or reload. */
  inPage?: boolean;
  /**
   * Lens `ready`: after navigating, wait until this selector matches or
   * `holdAt` reports the page needs the user, bounded by the load timeout.
   */
  ready?: string;
  /**
   * For a reused or named tab: whether the page it is on now needs the user
   * (a sign-in step). If so the tab is bound where it is, never navigated,
   * so the call reports the outcome instead of disturbing the form.
   */
  holdAt?(page: { url: string; title: string }): Promise<boolean>;
  /** Capture response bodies up to this size while bound; a file lens reads larger ones. */
  maxBodyBytes?: number;
  /**
   * Deny the page's own downloads until the call finishes. A file lens writes
   * its file itself, so a download the page starts would be a second copy.
   */
  blockDownloads?: boolean;
}

export interface DomExtractResult {
  url: string;
  title: string;
  value: unknown;
}

export interface SnapshotOptions {
  maxChars: number;
  html?: boolean;
  maxHtmlChars?: number;
}

export type FinishDisposition = "close-if-created" | "keep";

export interface RecordingPageState {
  url: string;
  title: string;
  /** Changes when a top-level document navigation starts, including same-URL reloads. */
  documentRevision: number;
  loading: boolean;
}

export interface RecordingCheckpoint {
  kind: "bind" | "navigation" | "final";
  url: string;
  title: string;
  timestamp: number;
  pngBase64: string;
}

export interface BrowserSession {
  readonly id: string;
  /** Broker id of the bound tab, stable while the tab stays open. */
  readonly tab?: string;
  readonly created: boolean;
  readonly navigated: boolean;
  /** Auth retry bound the original kept sign-in place (or cannot prove it left). */
  readonly atAuthGate?: boolean;
  reload(loadTimeoutMs: number): Promise<void>;
  readIntercepts(cursor: number, deadline: number): Promise<InterceptDelta>;
  domExtract(resolver: DomResolver): Promise<DomExtractResult>;
  /**
   * Execute perform steps in order, stopping at the first failure. Failures
   * are reported in the result, never thrown — a throw means the session
   * itself broke.
   */
  perform(steps: PerformStep[]): Promise<PerformResult>;
  snapshot(options: SnapshotOptions): Promise<PageSnapshot>;
  /** Cheap top-level state probe used only while a scoped recorder is active. */
  recordingState(): Promise<RecordingPageState>;
  /** PNG of this session's tab; implementations must not capture another tab. */
  recordingScreenshot(deadline?: number): Promise<string>;
}

export interface BrowserBackend {
  readonly name: string;
  available(): boolean;
  info(): BackendInfo;
  /** Whether this backend can safely execute an operation before it is selected. */
  supports?(capability: BrowserCapability): boolean;
  onStatusChange(listener: () => void): () => void;
  /**
   * A sign-in gate for this origin: a tab a needs_* outcome kept open that is
   * still at the place it was kept. Must not launch a browser or open a tab;
   * an unreachable browser reports none.
   */
  findAuthGate(origin: string): Promise<AuthGate | undefined>;
  /** Read-only presence check. An auth retry must not open a browser tab. */
  hasOpenTarget?(target: string, choice?: TabChoice): Promise<boolean>;
  /** Show a sign-in tab for a needs_auth result, including HTTP-only calls. */
  openAuthGate?(origin: string, target: string): Promise<boolean>;
  /** Subscribe to the kept tab without navigating it. Dispose removes the prompt. */
  watchAuthGate?(
    origin: string,
    onExit: (reason: "moved" | "closed" | "cancelled") => void,
    /** Reattach a gate whose URL moved during an earlier authentication attempt. */
    resume?: boolean
  ): Promise<{ update(expiresAt: number, count: number): void; dispose(): void } | undefined>;
  bind(request: BindRequest): Promise<BrowserSession>;
  /** `need`: the call ended at a page that needs the user, with this needs_* outcome. */
  finish(session: BrowserSession, disposition: FinishDisposition, need?: string): Promise<void>;
  /**
   * An HTTP request with the browser's cookies, without binding a tab. Absent
   * (or resolving undefined) on backends that cannot make one; the http tier
   * misses and the page tiers take over.
   */
  httpFetch?(request: BackendHttpRequest): Promise<InterceptedResponse | undefined>;
}
