import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import type { Page } from "puppeteer-core";
import {
  pagePerformClick,
  pagePerformCount,
  pagePerformDrop,
  pagePerformDropChunk,
  pagePerformFill,
  pagePerformPress,
  pagePerformSubmit,
  type PerformResult,
  type PerformStep,
  type PerformWait,
} from "@notation/lenses-core";
import { delay } from "./page-navigation.js";

const PERFORM_POLL_MS = 150;
const PERFORM_WAIT_DEFAULT_MS = 10_000;

/**
 * Run perform steps in order, stopping at the first failure. Both CDP
 * transports evaluate the same in-page primitives. A throw inside a step
 * (e.g. a click that navigates the page away mid-evaluation) fails that
 * step, not the session.
 */
export async function performSteps(
  page: Page,
  steps: PerformStep[],
  navigateFresh: () => Promise<void>
): Promise<PerformResult> {
  for (const [index, step] of steps.entries()) {
    let failure: string | undefined;
    try {
      failure = await performStep(page, step, navigateFresh);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== undefined) {
      return { failedStep: index, message: failure, ...(await pagePlace(page)) };
    }
  }
  return pagePlace(page);
}

/** One step; a string is the failure message, undefined is success. */
async function performStep(
  page: Page,
  step: PerformStep,
  navigateFresh: () => Promise<void>
): Promise<string | undefined> {
  if ("fill" in step) {
    const outcome = await page.evaluate(pagePerformFill, {
      selector: step.fill,
      value: step.value,
    });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("click" in step) {
    const outcome = await page.evaluate(pagePerformClick, {
      selector: step.click,
      ...(step.text !== undefined ? { text: step.text } : {}),
    });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("submit" in step) {
    const outcome = await page.evaluate(pagePerformSubmit, {
      selector: step.submit,
      form: step.form,
    });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("press" in step) {
    const outcome = await page.evaluate(pagePerformPress, { key: step.press });
    return outcome.ok ? undefined : outcome.message;
  }
  if ("drop" in step) {
    return performDrop(page, step);
  }
  if ("wait" in step) {
    const text = step.wait.text;
    return performWait(step.wait, (selector) =>
      page.evaluate(pagePerformCount, { selector, ...(text !== undefined ? { text } : {}) })
    );
  }
  await navigateFresh();
  return undefined;
}

/** Raw bytes per staged chunk: a multiple of 3, so each chunk is whole base64 quads. */
const DROP_CHUNK_BYTES = 3 * 256 * 1024;

const DROP_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

/**
 * Read the caller's file and drop it onto the page. The bytes cross in
 * chunks so no single CDP message carries the whole file.
 */
async function performDrop(
  page: Page,
  step: { drop: string; file: string }
): Promise<string | undefined> {
  if (!isAbsolute(step.file)) return `drop file "${step.file}" must be an absolute path`;
  let bytes: Buffer;
  try {
    bytes = readFileSync(step.file);
  } catch (error) {
    return `drop file "${step.file}" could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  for (let offset = 0; offset === 0 || offset < bytes.length; offset += DROP_CHUNK_BYTES) {
    await page.evaluate(pagePerformDropChunk, {
      chunk: bytes.subarray(offset, offset + DROP_CHUNK_BYTES).toString("base64"),
      first: offset === 0,
    });
  }
  const outcome = await page.evaluate(pagePerformDrop, {
    selector: step.drop,
    name: basename(step.file),
    type: DROP_TYPES[extname(step.file).toLowerCase()] ?? "application/octet-stream",
  });
  return outcome.ok ? undefined : outcome.message;
}

/**
 * Host-side wait polling over the shared pagePerformCount probe: `appears` is
 * count ≥ 1, `gone` is count = 0, `increases` is count > the baseline sampled
 * once at step entry. A probe that throws mid-navigation counts as "not yet",
 * not as a failure — the condition gets the full timeout to come true.
 */
async function performWait(
  wait: PerformWait,
  count: (selector: string) => Promise<number>,
  pollMs = PERFORM_POLL_MS
): Promise<string | undefined> {
  const form = wait.appears !== undefined ? "appears" : wait.gone !== undefined ? "gone" : "increases";
  const selector = wait.appears ?? wait.gone ?? wait.increases;
  if (selector === undefined) return "wait step names no selector";
  const timeoutMs = wait.timeoutMs ?? PERFORM_WAIT_DEFAULT_MS;
  const deadline = Date.now() + timeoutMs;
  const probe = async (): Promise<number | undefined> => {
    try {
      return await count(selector);
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
    await delay(pollMs);
  }
}

async function pagePlace(page: Page): Promise<{ url: string; title: string }> {
  try {
    return { url: page.url(), title: await page.title() };
  } catch {
    return { url: page.url(), title: "" };
  }
}
