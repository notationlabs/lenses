import * as z from "zod/v4";
import type {
  DomResolver,
  InterceptedResponse,
} from "./types.js";
import type { PageSnapshot } from "./page-functions.js";

export const EXTENSION_PROTOCOL_MAJOR = 1;
export const REQUIRED_EXTENSION_CAPABILITIES = [
  "sessions",
  "cursor-delta",
  "dom-extract",
  "snapshot-html",
] as const;

export type ExtensionCapability =
  (typeof REQUIRED_EXTENSION_CAPABILITIES)[number];

export interface ExtensionHello {
  type: "extension-hello";
  protocolMajor: number;
  extensionVersion: string;
  capabilities: string[];
  epoch: string;
  ua?: string;
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
  | {
      name: "snapshot";
      sessionId: string;
      maxChars: number;
      html?: boolean;
      maxHtmlChars?: number;
    }
  | {
      name: "finish";
      sessionId: string;
      disposition: "close-if-created" | "keep";
    };

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
  | { name: "snapshot"; snapshot: PageSnapshot }
  | { name: "finish" };

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
  sibling: z.boolean().optional(),
});

const domResolverSchema = z.strictObject({
  kind: z.literal("dom"),
  detect: z.record(z.string(), z.string()).optional(),
  item: z.string().optional(),
  fields: z.record(z.string(), domFieldSchema).optional(),
  post: z.string().optional(),
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
    name: z.literal("snapshot"),
    sessionId: z.string().min(1),
    maxChars: z.number().int().nonnegative(),
    html: z.boolean().optional(),
    maxHtmlChars: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    name: z.literal("finish"),
    sessionId: z.string().min(1),
    disposition: z.enum(["close-if-created", "keep"]),
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
    name: z.literal("snapshot"),
    snapshot: snapshotSchema,
  }),
  z.strictObject({ name: z.literal("finish") }),
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
