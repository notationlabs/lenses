import {
  createCaptureBuffer,
  pushCapture,
  readCaptures,
  resetCaptureBuffer,
  wakeCaptureWaiters,
  type CaptureBuffer,
  type InterceptDelta,
  type InterceptedResponse,
} from "@djgrant/lenses-core";
import { configurePageInterceptor } from "../page.js";

const buffers = new Map<number, CaptureBuffer>();
const active = new Map<number, { token: string; references: number }>();
const MAX_BODY_CHARS = 512 * 1024;

export function listenForIntercepts(): void {
  chrome.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const response = decodeInterceptMessage(message, active.get(tabId)?.token);
    if (response) pushCapture(buffer(tabId), response);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const state = buffers.get(tabId);
    if (state) wakeCaptureWaiters(state);
    buffers.delete(tabId);
    active.delete(tabId);
  });
}

/** Start interception only while at least one browser session owns this tab. */
export async function acquireIntercepts(tabId: number): Promise<void> {
  const state = active.get(tabId);
  if (state) {
    state.references += 1;
    return;
  }
  const created = { token: crypto.randomUUID(), references: 1 };
  active.set(tabId, created);
  try {
    await install(tabId, created.token);
  } catch (error) {
    if (active.get(tabId) === created) active.delete(tabId);
    throw error;
  }
}

/** Reinstall after navigation replaced both page and isolated worlds. */
export async function refreshIntercepts(tabId: number): Promise<void> {
  const state = active.get(tabId);
  if (state) await install(tabId, state.token);
}

export async function releaseIntercepts(tabId: number): Promise<void> {
  const state = active.get(tabId);
  if (!state) return;
  state.references -= 1;
  if (state.references > 0) return;
  active.delete(tabId);
  const capture = buffers.get(tabId);
  if (capture) wakeCaptureWaiters(capture);
  buffers.delete(tabId);
  await Promise.allSettled([
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: ["remove", state.token],
      func: configurePageInterceptor,
    }),
    chrome.tabs.sendMessage(tabId, { type: "intercepts-disable", token: state.token }),
  ]);
}

async function install(tabId: number, token: string): Promise<void> {
  // Arm the isolated-world relay first so no page response can arrive in the
  // gap between patching fetch and teaching the relay its unguessable token.
  await chrome.tabs.sendMessage(tabId, { type: "intercepts-enable", token });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: ["install", token],
    func: configurePageInterceptor,
  });
}

export function resetIntercepts(tabId: number): void {
  const state = buffers.get(tabId);
  if (state) resetCaptureBuffer(state);
}

export function readIntercepts(
  tabId: number,
  cursor: number,
  deadline: number
): Promise<InterceptDelta> {
  if (!active.has(tabId)) {
    return Promise.resolve({ captures: [], nextCursor: cursor, truncated: false });
  }
  return readCaptures(buffer(tabId), cursor, deadline);
}

/** Strictly validate the hostile page-world relay before it reaches resolvers. */
export function decodeInterceptMessage(
  message: unknown,
  expectedToken: string | undefined
): InterceptedResponse | undefined {
  if (!expectedToken || typeof message !== "object" || message === null) return;
  const value = message as Record<string, unknown>;
  if (value.type !== "intercepted" || value.token !== expectedToken) return;
  const response = value.response;
  if (typeof response !== "object" || response === null) return;
  const item = response as Record<string, unknown>;
  if (
    typeof item.url !== "string" ||
    item.url.length > 16_384 ||
    typeof item.method !== "string" ||
    !/^[A-Z]+$/.test(item.method) ||
    item.method.length > 32 ||
    typeof item.status !== "number" ||
    !Number.isInteger(item.status) ||
    item.status < 0 ||
    item.status > 999 ||
    typeof item.body !== "string" ||
    item.body.length > MAX_BODY_CHARS ||
    typeof item.timestamp !== "number" ||
    !Number.isFinite(item.timestamp) ||
    item.timestamp < 0
  ) return;
  try {
    const url = new URL(item.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
  } catch {
    return;
  }
  return {
    url: item.url,
    method: item.method,
    status: item.status,
    body: item.body,
    timestamp: item.timestamp,
  };
}

function buffer(tabId: number): CaptureBuffer {
  let state = buffers.get(tabId);
  if (!state) {
    state = createCaptureBuffer();
    buffers.set(tabId, state);
  }
  return state;
}
