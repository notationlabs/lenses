import type { InterceptedResponse } from "@djgrant/lens";

const BUFFER_CAP = 200;
const buffers = new Map<number, InterceptedResponse[]>();

export function listenForIntercepts(): void {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== "intercepted" || sender.tab?.id === undefined) return;

    const buffer = buffers.get(sender.tab.id) ?? [];
    buffer.push(msg.response as InterceptedResponse);
    if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
    buffers.set(sender.tab.id, buffer);
  });

  chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));
}

export function interceptedResponses(tabId: number): InterceptedResponse[] {
  return buffers.get(tabId) ?? [];
}

export function resetIntercepts(tabId: number): void {
  buffers.set(tabId, []);
}
