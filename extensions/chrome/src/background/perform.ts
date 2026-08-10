/**
 * Perform steps against a bound tab. The in-page primitives (fill, click,
 * press, count) run in the content script via the shared page functions, so
 * this backend acts on a page exactly like the CDP host; wait polling and
 * navigation live here in the service worker, where the timeout and the tab
 * APIs already are.
 */
import { urlOrigin, type PerformResult, type PerformStep, type PerformWait } from "@djgrant/lenses-core";
import { navigateTab, reloadTab, tabMessage } from "./tabs.js";

const PERFORM_POLL_MS = 150;
const PERFORM_WAIT_DEFAULT_MS = 10_000;

export interface PerformTarget {
  tabId: number;
  /** the expanded lens URL the session was bound to */
  target: string;
  loadTimeoutMs: number;
}

type StepOutcome = { ok: true } | { ok: false; message: string } | { error: string };

export async function performSteps(
  bound: PerformTarget,
  steps: PerformStep[]
): Promise<PerformResult> {
  for (const [index, step] of steps.entries()) {
    let failure: string | undefined;
    try {
      failure = await performStep(bound, step);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      return { failedStep: index, message: failure, ...(await tabPlace(bound.tabId)) };
    }
  }
  return tabPlace(bound.tabId);
}

/** One step; a string is the failure message, undefined is success. */
async function performStep(
  bound: PerformTarget,
  step: PerformStep
): Promise<string | undefined> {
  if ("fill" in step) {
    return stepOutcome(
      await tabMessage<StepOutcome>(bound.tabId, {
        type: "perform_fill",
        selector: step.fill,
        value: step.value,
      })
    );
  }
  if ("click" in step) {
    return stepOutcome(
      await tabMessage<StepOutcome>(bound.tabId, {
        type: "perform_click",
        selector: step.click,
      })
    );
  }
  if ("press" in step) {
    return stepOutcome(
      await tabMessage<StepOutcome>(bound.tabId, { type: "perform_press", key: step.press })
    );
  }
  if ("wait" in step) return performWait(bound.tabId, step.wait);
  return navigateFresh(bound);
}

function stepOutcome(outcome: StepOutcome): string | undefined {
  if ("error" in outcome) return outcome.error;
  return outcome.ok ? undefined : outcome.message;
}

/**
 * Host-side wait polling over the shared count probe: `appears` is count ≥ 1,
 * `gone` is count = 0, `increases` is count > the baseline sampled once at
 * step entry. A probe that fails mid-navigation (the content script is being
 * replaced) counts as "not yet", not as a failure — the condition gets the
 * full timeout to come true.
 */
async function performWait(tabId: number, wait: PerformWait): Promise<string | undefined> {
  const form =
    wait.appears !== undefined ? "appears" : wait.gone !== undefined ? "gone" : "increases";
  const selector = wait.appears ?? wait.gone ?? wait.increases;
  if (selector === undefined) return "wait step names no selector";
  const timeoutMs = wait.timeoutMs ?? PERFORM_WAIT_DEFAULT_MS;
  const deadline = Date.now() + timeoutMs;
  const probe = async (): Promise<number | undefined> => {
    try {
      const outcome = await tabMessage<{ count: number } | { error: string }>(tabId, {
        type: "perform_count",
        selector,
      });
      return "error" in outcome ? undefined : outcome.count;
    } catch {
      return undefined;
    }
  };
  let baseline = 0;
  if (form === "increases") {
    const sampled = await probe();
    if (sampled === undefined) return `wait increases "${selector}" could not sample its baseline`;
    baseline = sampled;
  }
  for (;;) {
    const matches = await probe();
    if (matches !== undefined) {
      if (form === "appears" && matches >= 1) return undefined;
      if (form === "gone" && matches === 0) return undefined;
      if (form === "increases" && matches > baseline) return undefined;
    }
    if (Date.now() >= deadline) {
      return `wait ${form} "${selector}" timed out after ${timeoutMs}ms`;
    }
    await new Promise((resolve) => setTimeout(resolve, PERFORM_POLL_MS));
  }
}

/**
 * Serve a `navigate: "fresh"` step: reload when the tab is still on the
 * lens's origin, otherwise go back to the lens URL (an earlier step may have
 * taken the tab elsewhere).
 */
async function navigateFresh(bound: PerformTarget): Promise<string | undefined> {
  const tab = await chrome.tabs.get(bound.tabId);
  if (urlOrigin(tab.url ?? "") === urlOrigin(bound.target)) {
    await reloadTab(bound.tabId, bound.loadTimeoutMs);
  } else {
    await navigateTab(bound.tabId, bound.target, bound.loadTimeoutMs);
  }
  return undefined;
}

async function tabPlace(tabId: number): Promise<{ url: string; title: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? "", title: tab.title ?? "" };
  } catch {
    return { url: "", title: "" };
  }
}
