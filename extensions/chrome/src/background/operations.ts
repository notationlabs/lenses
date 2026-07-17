import { executeLens, type DomResolver, type EngineIO, type LensSpec } from "@djgrant/lens";
import { interceptedResponses } from "./intercepts.js";
import { bindObservedTab, bindTab, closeIfCreated, reloadTab, tabMessage } from "./tabs.js";

export async function observePage(target: string, waitMs: number) {
  const bound = await bindObservedTab(target);
  try {
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    const requests = interceptedResponses(bound.tabId).slice(-40).map((capture) => ({
      method: capture.method,
      url: capture.url,
      status: capture.status,
      bodyPreview: capture.body.slice(0, 2000),
    }));
    const snapshot = await tabMessage<{ url: string; title: string; text: string }>(bound.tabId, {
      type: "snapshot",
      maxChars: 6000,
    });
    return { kind: "value" as const, value: { snapshot, requests } };
  } finally {
    await closeIfCreated(bound, { kind: "value" });
  }
}

export async function callLens(
  spec: LensSpec,
  target: string,
  args: Record<string, unknown>
) {
  const bound = await bindTab(spec, target);
  const io: EngineIO = {
    getIntercepted: async () => interceptedResponses(bound.tabId),
    reload: () => reloadTab(bound.tabId),
    domExtract: (resolver: DomResolver) =>
      tabMessage(bound.tabId, { type: "dom_extract", spec: resolver }),
    snapshot: (maxChars: number) => tabMessage(bound.tabId, { type: "snapshot", maxChars }),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  let result;
  try {
    result = await executeLens(spec, target, args, io);
    return result;
  } finally {
    await closeIfCreated(bound, result ?? { kind: "error" });
  }
}
