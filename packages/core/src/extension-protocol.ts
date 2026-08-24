import * as z from "zod/v4";
import type {
  DomResolver,
  HttpFetchBody,
  InterceptedResponse,
  PerformResult,
  PerformStep,
} from "./types.js";
import type { PageSnapshot } from "./page-functions.js";

export const EXTENSION_PROTOCOL_MAJOR = 1;
export const REQUIRED_EXTENSION_CAPABILITIES = [
  "sessions",
  "cursor-delta",
  "dom-extract",
  "snapshot-html",
  "recording",
] as const;
/**
 * Capabilities the broker uses when present but can work without. find-gate
 * backs the auth-gate short circuit; without it every gated call binds a tab.
 * http-fetch backs credentialed http tiers; without it they miss and the page
 * tiers take over.
 */
export const OPTIONAL_EXTENSION_CAPABILITIES = [
  "find-gate",
  "http-fetch",
  "http-fetch-body",
] as const;
export const EXTENSION_CAPABILITIES = [
  ...REQUIRED_EXTENSION_CAPABILITIES,
  ...OPTIONAL_EXTENSION_CAPABILITIES,
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export interface ExtensionHello {
  type: "extension-hello";
  protocolMajor: number;
  extensionVersion: string;
  capabilities: string[];
  epoch: string;
  ua?: string;
  /**
   * Stamp of the page-functions module baked into this extension's bundle at
   * build time. Absent from extensions built before the stamp existed.
   */
  pageStamp?: string;
}

export type ExtensionHelloResult =
  | {
      type: "extension-hello-result";
      accepted: true;
      protocolMajor: number;
      epoch: string;
    }
  | {
      type: "extension-hello-result";
      accepted: false;
      protocolMajor: number;
      reason: string;
    };

export type ExtensionRpcOperation =
  | {
      name: "bind";
      target: string;
      loadTimeoutMs: number;
      navigation: "reuse" | "fresh";
    }
  | { name: "reload"; sessionId: string; loadTimeoutMs: number }
  | {
      name: "read-intercepts";
      sessionId: string;
      cursor: number;
      /** Long-poll until this time; a past value requests current state immediately. */
      pollDeadline: number;
    }
  | { name: "dom-extract"; sessionId: string; resolver: DomResolver }
  /**
   * Execute perform steps against the bound tab, in order, stopping at the
   * first failure. `fill` values arrive as literal strings — the engine has
   * already resolved any expression, so the extension never evaluates one.
   */
  | { name: "perform"; sessionId: string; steps: PerformStep[] }
  | {
      name: "snapshot";
      sessionId: string;
      maxChars: number;
      html?: boolean;
      maxHtmlChars?: number;
    }
  | { name: "recording-state"; sessionId: string }
  | { name: "recording-screenshot"; sessionId: string }
  | {
      name: "finish";
      sessionId: string;
      disposition: "close-if-created" | "keep";
    }
  | { name: "find-gate"; origin: string }
  /**
   * A service-worker fetch with the browser's cookies. Sessionless: it binds no
   * tab, which is the point — one credentialed request instead of a page load.
   */
  | {
      name: "http-fetch";
      request: { method: string; url: string; headers?: Record<string, string>; body?: HttpFetchBody };
      maxBodyChars?: number;
    };

/**
 * A sign-in gate: a tab an earlier needs_* outcome kept open, still sitting
 * where it was kept. `url` is the tab's current URL; `target` is the page the
 * gated call originally asked for.
 */
export interface AuthGate {
  url: string;
  target: string;
}

export interface ExtensionRpcRequest {
  type: "extension-rpc";
  requestId: string;
  epoch: string;
  /**
   * Reject the request if it has not started by this time. There is no cancel
   * frame: callers abandon timed-out requests by ignoring their late response.
   */
  deadline: number;
  operation: ExtensionRpcOperation;
}

export type ExtensionRpcResult =
  | {
      name: "bind";
      session: {
        id: string;
        created: boolean;
        navigated: boolean;
      };
    }
  | { name: "reload" }
  | {
      name: "read-intercepts";
      captures: InterceptedResponse[];
      nextCursor: number;
      truncated: boolean;
    }
  | {
      name: "dom-extract";
      extraction: { url: string; title: string; value: unknown };
    }
  | { name: "perform"; result: PerformResult }
  | { name: "snapshot"; snapshot: PageSnapshot }
  | {
      name: "recording-state";
      state: { url: string; title: string; documentRevision: number; loading: boolean };
    }
  | { name: "recording-screenshot"; pngBase64: string }
  | { name: "finish" }
  | { name: "find-gate"; gate: AuthGate | null }
  | { name: "http-fetch"; response: InterceptedResponse };

export type ExtensionRpcErrorCode =
  | "invalid-request"
  | "stale-epoch"
  | "unknown-session"
  | "deadline-exceeded"
  | "backend-error";

export type ExtensionRpcResponse =
  | {
      type: "extension-rpc-result";
      requestId: string;
      epoch: string;
      ok: true;
      result: ExtensionRpcResult;
    }
  | {
      type: "extension-rpc-result";
      requestId: string;
      epoch: string;
      ok: false;
      error: { code: ExtensionRpcErrorCode; message: string };
    };

export type BrokerExtensionMessage =
  | ExtensionHelloResult
  | ExtensionRpcRequest
  | { type: "extension-ping"; nonce: string };

export type ExtensionBrokerMessage =
  | ExtensionHello
  | ExtensionRpcResponse
  | { type: "extension-pong"; nonce: string; epoch: string };

const helloSchema = z.strictObject({
  type: z.literal("extension-hello"),
  protocolMajor: z.number().int().positive(),
  extensionVersion: z.string().min(1),
  capabilities: z.array(z.string()),
  epoch: z.string().min(1),
  pageStamp: z.string().min(1).optional(),
  ua: z.string().optional(),
});

const helloResultSchema = z.discriminatedUnion("accepted", [
  z.strictObject({
    type: z.literal("extension-hello-result"),
    accepted: z.literal(true),
    protocolMajor: z.number().int().positive(),
    epoch: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("extension-hello-result"),
    accepted: z.literal(false),
    protocolMajor: z.number().int().positive(),
    reason: z.string().min(1),
  }),
]);

const domFieldSchema = z.strictObject({
  selector: z.string(),
  attr: z.string().optional(),
  scope: z.string().optional(),
  sibling: z.boolean().optional(),
});

const domResolverSchema = z.strictObject({
  kind: z.literal("dom"),
  detect: z.record(z.string(), z.string()).optional(),
  item: z.string().optional(),
  fields: z.record(z.string(), domFieldSchema).optional(),
  post: z.string().optional(),
});

const performWaitSchema = z.strictObject({
  appears: z.string().min(1).optional(),
  gone: z.string().min(1).optional(),
  increases: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

// The same closed opcode set validate.ts enforces on documents; unknown keys
// fail closed here too, so a stale extension rejects a step it cannot run.
const performStepSchema = z.union([
  z.strictObject({ fill: z.string().min(1), value: z.string() }),
  z.strictObject({ click: z.string().min(1) }),
  z.strictObject({
    submit: z.string().min(1),
    form: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({ press: z.string().min(1) }),
  z.strictObject({ wait: performWaitSchema }),
  z.strictObject({ navigate: z.literal("fresh") }),
]);

const performResultSchema = z.strictObject({
  failedStep: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
});

const operationSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("bind"),
    target: z.string().url(),
    loadTimeoutMs: z.number().int().positive(),
    navigation: z.enum(["reuse", "fresh"]),
  }),
  z.strictObject({
    name: z.literal("reload"),
    sessionId: z.string().min(1),
    loadTimeoutMs: z.number().int().positive(),
  }),
  z.strictObject({
    name: z.literal("read-intercepts"),
    sessionId: z.string().min(1),
    cursor: z.number().int().nonnegative(),
    pollDeadline: z.number().int().nonnegative(),
  }),
  z.strictObject({
    name: z.literal("dom-extract"),
    sessionId: z.string().min(1),
    resolver: domResolverSchema,
  }),
  z.strictObject({
    name: z.literal("perform"),
    sessionId: z.string().min(1),
    steps: z.array(performStepSchema).min(1),
  }),
  z.strictObject({
    name: z.literal("snapshot"),
    sessionId: z.string().min(1),
    maxChars: z.number().int().nonnegative(),
    html: z.boolean().optional(),
    maxHtmlChars: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    name: z.literal("recording-state"),
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    name: z.literal("recording-screenshot"),
    sessionId: z.string().min(1),
  }),
  z.strictObject({
    name: z.literal("finish"),
    sessionId: z.string().min(1),
    disposition: z.enum(["close-if-created", "keep"]),
  }),
  z.strictObject({
    name: z.literal("find-gate"),
    origin: z.string().url(),
  }),
  z.strictObject({
    name: z.literal("http-fetch"),
    request: z.strictObject({
      method: z.string().min(1),
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.enum(["json", "text"]), value: z.string() }),
        z.strictObject({
          kind: z.enum(["form", "search"]),
          entries: z.array(z.tuple([z.string(), z.string()])),
        }),
      ]).optional(),
    }),
    maxBodyChars: z.number().int().positive().optional(),
  }),
]);

const rpcRequestSchema = z.strictObject({
  type: z.literal("extension-rpc"),
  requestId: z.string().min(1),
  epoch: z.string().min(1),
  deadline: z.number().int().nonnegative(),
  operation: operationSchema,
});

const interceptedResponseSchema = z.strictObject({
  url: z.string(),
  method: z.string(),
  status: z.number().int(),
  body: z.string(),
  timestamp: z.number(),
});

const snapshotSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  html: z.string().optional(),
});

const rpcResultSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("bind"),
    session: z.strictObject({
      id: z.string().min(1),
      created: z.boolean(),
      navigated: z.boolean(),
    }),
  }),
  z.strictObject({ name: z.literal("reload") }),
  z.strictObject({
    name: z.literal("read-intercepts"),
    captures: z.array(interceptedResponseSchema),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    name: z.literal("dom-extract"),
    extraction: z.strictObject({
      url: z.string(),
      title: z.string(),
      value: z.unknown(),
    }),
  }),
  z.strictObject({
    name: z.literal("perform"),
    result: performResultSchema,
  }),
  z.strictObject({
    name: z.literal("snapshot"),
    snapshot: snapshotSchema,
  }),
  z.strictObject({
    name: z.literal("recording-state"),
    state: z.strictObject({
      url: z.string(),
      title: z.string(),
      documentRevision: z.number().int().nonnegative(),
      loading: z.boolean(),
    }),
  }),
  z.strictObject({
    name: z.literal("recording-screenshot"),
    pngBase64: z.string(),
  }),
  z.strictObject({ name: z.literal("finish") }),
  z.strictObject({
    name: z.literal("find-gate"),
    gate: z
      .strictObject({ url: z.string(), target: z.string() })
      .nullable(),
  }),
  z.strictObject({
    name: z.literal("http-fetch"),
    response: interceptedResponseSchema,
  }),
]);

const rpcResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("extension-rpc-result"),
    requestId: z.string().min(1),
    epoch: z.string().min(1),
    ok: z.literal(true),
    result: rpcResultSchema,
  }),
  z.strictObject({
    type: z.literal("extension-rpc-result"),
    requestId: z.string().min(1),
    epoch: z.string().min(1),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "invalid-request",
        "stale-epoch",
        "unknown-session",
        "deadline-exceeded",
        "backend-error",
      ]),
      message: z.string(),
    }),
  }),
]);

const brokerMessageSchema = z.union([
  helloResultSchema,
  rpcRequestSchema,
  z.strictObject({
    type: z.literal("extension-ping"),
    nonce: z.string().min(1),
  }),
]);

const extensionMessageSchema = z.union([
  helloSchema,
  rpcResponseSchema,
  z.strictObject({
    type: z.literal("extension-pong"),
    nonce: z.string().min(1),
    epoch: z.string().min(1),
  }),
]);

/**
 * Whether a kept tab is still at the place it was kept: same origin and path.
 * Query and hash are ignored because sign-in pages rewrite them (state nonces,
 * hash routing) without leaving the sign-in flow; a change of path or origin
 * means the flow moved on and the gate must dissolve.
 */
export function sameGatePlace(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

export function decodeExtensionHello(value: unknown): ExtensionHello {
  return helloSchema.parse(value);
}

export function negotiateExtensionHello(
  value: unknown,
  requiredCapabilities: readonly string[] = REQUIRED_EXTENSION_CAPABILITIES
): ExtensionHello {
  const hello = decodeExtensionHello(value);
  if (hello.protocolMajor !== EXTENSION_PROTOCOL_MAJOR) {
    throw new Error(
      `incompatible extension protocol major ${hello.protocolMajor}; broker requires ${EXTENSION_PROTOCOL_MAJOR}`
    );
  }
  const missing = requiredCapabilities.filter(
    (capability) => !hello.capabilities.includes(capability)
  );
  if (missing.length > 0) {
    throw new Error(
      `extension is missing required capabilities: ${missing.join(", ")}`
    );
  }
  return hello;
}

export function decodeBrokerExtensionMessage(
  value: unknown
): BrokerExtensionMessage {
  return brokerMessageSchema.parse(value) as BrokerExtensionMessage;
}

export function decodeExtensionBrokerMessage(
  value: unknown
): ExtensionBrokerMessage {
  return extensionMessageSchema.parse(value) as ExtensionBrokerMessage;
}

export function decodeExtensionRpcRequest(
  value: unknown,
  expectedEpoch: string,
  now = Date.now()
): ExtensionRpcRequest {
  const request = rpcRequestSchema.parse(value) as ExtensionRpcRequest;
  if (request.epoch !== expectedEpoch) {
    throw new Error(
      `stale extension epoch ${request.epoch}; current epoch is ${expectedEpoch}`
    );
  }
  if (request.deadline < now) {
    throw new Error(`extension RPC ${request.requestId} deadline exceeded`);
  }
  return request;
}

export function decodeExtensionRpcResponse(
  value: unknown,
  expectedEpoch: string
): ExtensionRpcResponse {
  const response = rpcResponseSchema.parse(value) as ExtensionRpcResponse;
  if (response.epoch !== expectedEpoch) {
    throw new Error(
      `stale extension epoch ${response.epoch}; current epoch is ${expectedEpoch}`
    );
  }
  return response;
}
