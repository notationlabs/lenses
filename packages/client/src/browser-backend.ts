import type {
  DomResolver,
  InterceptedResponse,
  PageSnapshot,
} from "@djgrant/lens";

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

export interface InterceptDelta {
  captures: InterceptedResponse[];
  nextCursor: number;
  truncated: boolean;
}

export type FinishDisposition = "close-if-created" | "keep";

export interface BrowserSession {
  readonly id: string;
  readonly created: boolean;
  readonly navigated: boolean;
  reload(loadTimeoutMs: number): Promise<void>;
  readIntercepts(cursor: number, deadline: number): Promise<InterceptDelta>;
  domExtract(resolver: DomResolver): Promise<DomExtractResult>;
  snapshot(options: SnapshotOptions): Promise<PageSnapshot>;
}

export interface BrowserBackend {
  readonly name: string;
  available(): boolean;
  info(): BackendInfo;
  onStatusChange(listener: () => void): () => void;
  bind(request: BindRequest): Promise<BrowserSession>;
  finish(session: BrowserSession, disposition: FinishDisposition): Promise<void>;
}
