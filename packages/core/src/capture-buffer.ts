/**
 * A cursor-addressed ring buffer of intercepted responses, shared by every
 * browser backend so cursor semantics —
 * capping, truncation reporting, long-poll wakeups — are defined once.
 */
import type { InterceptedResponse } from "./types.js";

const CAPTURE_BUFFER_CAP = 200;

interface CaptureEntry {
  cursor: number;
  capture: InterceptedResponse;
}

export interface CaptureBuffer {
  entries: CaptureEntry[];
  nextCursor: number;
  waiters: Set<() => void>;
}

export interface InterceptDelta {
  captures: InterceptedResponse[];
  nextCursor: number;
  truncated: boolean;
}

export function createCaptureBuffer(): CaptureBuffer {
  return { entries: [], nextCursor: 0, waiters: new Set() };
}

export function pushCapture(
  state: CaptureBuffer,
  capture: InterceptedResponse
): void {
  state.entries.push({ cursor: state.nextCursor++, capture });
  if (state.entries.length > CAPTURE_BUFFER_CAP) {
    state.entries.splice(0, state.entries.length - CAPTURE_BUFFER_CAP);
  }
  wakeCaptureWaiters(state);
}

export function resetCaptureBuffer(state: CaptureBuffer): void {
  state.entries = [];
  wakeCaptureWaiters(state);
}

/** Releases every pending readCaptures poll immediately. */
export function wakeCaptureWaiters(state: CaptureBuffer): void {
  for (const waiter of [...state.waiters]) waiter();
}

/**
 * Captures at or after `cursor`, long-polling until the deadline when none
 * have arrived yet. A cursor older than the buffer's tail reports truncation.
 */
export async function readCaptures(
  state: CaptureBuffer,
  cursor: number,
  deadline: number
): Promise<InterceptDelta> {
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

function waitForCapture(state: CaptureBuffer, deadline: number): Promise<void> {
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
