import {
  createCaptureBuffer,
  pushCapture,
  readCaptures,
  resetCaptureBuffer,
  wakeCaptureWaiters,
  type CaptureBuffer,
  type InterceptDelta,
  type InterceptedResponse,
} from "@djgrant/lens";

const buffers = new Map<number, CaptureBuffer>();

export function listenForIntercepts(): void {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message?.type !== "intercepted" ||
      sender.tab?.id === undefined
    ) {
      return;
    }
    pushCapture(buffer(sender.tab.id), message.response as InterceptedResponse);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const state = buffers.get(tabId);
    if (state) wakeCaptureWaiters(state);
    buffers.delete(tabId);
  });
}

export function resetIntercepts(tabId: number): void {
  resetCaptureBuffer(buffer(tabId));
}

export function readIntercepts(
  tabId: number,
  cursor: number,
  deadline: number
): Promise<InterceptDelta> {
  return readCaptures(buffer(tabId), cursor, deadline);
}

function buffer(tabId: number): CaptureBuffer {
  let state = buffers.get(tabId);
  if (!state) {
    state = createCaptureBuffer();
    buffers.set(tabId, state);
  }
  return state;
}
