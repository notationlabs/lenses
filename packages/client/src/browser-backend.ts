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
  url: string;
  headers?: Record<string, string>;
  body?: HttpFetchBody;
  /** Execute in a matching top-level page rather than an extension/service-worker context. */
  context?: "same-origin-page";
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

export interface BindRequest {
  target: string;
  loadTimeoutMs: number;
  navigation: "reuse" | "fresh";
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
  readonly created: boolean;
  readonly navigated: boolean;
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
  bind(request: BindRequest): Promise<BrowserSession>;
  finish(session: BrowserSession, disposition: FinishDisposition): Promise<void>;
  /**
   * An HTTP request with the browser's cookies, without binding a tab. Absent
   * (or resolving undefined) on backends that cannot make one; the http tier
   * misses and the page tiers take over.
   */
  httpFetch?(request: BackendHttpRequest): Promise<InterceptedResponse | undefined>;
}
