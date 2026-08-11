import type {
  AuthGate,
  DomResolver,
  InterceptDelta,
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
}

export interface BackendInfo {
  name: string;
  detail?: string;
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
  recordingScreenshot(): Promise<string>;
}

export interface BrowserBackend {
  readonly name: string;
  available(): boolean;
  info(): BackendInfo;
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
