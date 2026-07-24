import type { InterceptedResponse } from "@djgrant/lens";

const BUFFER_CAP = 200;

interface CaptureEntry {
  cursor: number;
  capture: InterceptedResponse;
}

interface CaptureBuffer {
  entries: CaptureEntry[];
  nextCursor: number;
  waiters: Set<() => void>;
}

interface InterceptDelta {
  captures: InterceptedResponse[];
  nextCursor: number;
  truncated: boolean;
}

const buffers = new Map<number, CaptureBuffer>();

export function listenForIntercepts(): void {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message?.type !== "intercepted" ||
      sender.tab?.id === undefined
    ) {
      return;
    }
    const state = buffer(sender.tab.id);
    state.entries.push({
      cursor: state.nextCursor++,
      capture: message.response as InterceptedResponse,
    });
    if (state.entries.length > BUFFER_CAP) {
      state.entries.splice(0, state.entries.length - BUFFER_CAP);
    }
    wake(state);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const state = buffers.get(tabId);
    if (state) wake(state);
    buffers.delete(tabId);
  });
}

export function resetIntercepts(tabId: number): void {
  const state = buffer(tabId);
  state.entries = [];
  wake(state);
}

export async function readIntercepts(
  tabId: number,
  cursor: number,
  deadline: number
): Promise<InterceptDelta> {
  const state = buffer(tabId);
  while (cursor >= state.nextCursor && Date.now() < deadline) {
    await waitForCapture(state, deadline);
  }
  const oldestCursor = state.entries[0]?.cursor ?? state.nextCursor;
  const truncated = cursor < oldestCursor;
  const effectiveCursor = truncated ? oldestCursor : cursor;
  return {
    captures: state.entries
      .filter((entry) => entry.cursor >= effectiveCursor)
      .map((entry) => entry.capture),
    nextCursor: state.nextCursor,
    truncated,
  };
}

function buffer(tabId: number): CaptureBuffer {
  let state = buffers.get(tabId);
  if (!state) {
    state = { entries: [], nextCursor: 0, waiters: new Set() };
    buffers.set(tabId, state);
  }
  return state;
}

function waitForCapture(
  state: CaptureBuffer,
  deadline: number
): Promise<void> {
  return new Promise((resolve) => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      state.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, remaining);
    state.waiters.add(done);
  });
}

function wake(state: CaptureBuffer): void {
  for (const waiter of [...state.waiters]) waiter();
}
