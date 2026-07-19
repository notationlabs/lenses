import { executeLens, expandUrl, type DomResolver, type EngineIO, type LensSpec } from "@djgrant/lens";
import { interceptedResponses } from "./intercepts.js";
import { bindObservedTab, bindTab, closeIfCreated, reloadTab, tabMessage } from "./tabs.js";

export async function observePage(
  target: string,
  waitMs: number,
  progress: (message: string) => void = () => {}
) {
  progress(`binding browser tab for ${target}`);
  const bound = await bindObservedTab(target);
  try {
    progress(`collecting page activity for ${waitMs}ms`);
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
    progress(`collected ${requests.length} captured requests`);
    return { kind: "value" as const, value: { snapshot, requests } };
  } finally {
    await closeIfCreated(bound, { kind: "value" });
  }
}

export async function callLens(
  spec: LensSpec,
  params: Record<string, unknown>,
  progress: (message: string) => void = () => {}
) {
  const target = expandUrl(spec.url, params);
  progress(`binding browser tab for ${target}`);
  const bound = await bindTab(spec, target);
  progress(`bound tab ${bound.tabId}${bound.created ? " (created)" : " (existing)"}`);
  let navigationIsFresh = bound.navigated;
  const io: EngineIO = {
    getIntercepted: async () => interceptedResponses(bound.tabId),
    reload: async () => {
      if (navigationIsFresh) {
        navigationIsFresh = false;
        progress("using the tab's fresh navigation for intercept capture");
        return;
      }
      await reloadTab(bound.tabId, spec.loadTimeoutMs);
    },
    domExtract: (resolver: DomResolver) =>
      tabMessage(bound.tabId, { type: "dom_extract", spec: resolver }),
    snapshot: (maxChars: number) => tabMessage(bound.tabId, { type: "snapshot", maxChars }),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: progress,
  };

  let result;
  try {
    result = await executeLens(spec, params, io);
    return result;
  } finally {
    await closeIfCreated(bound, result ?? { kind: "error" });
  }
}
