import type { Page } from "puppeteer-core";
import {
  createCaptureBuffer,
  pushCapture,
  resetCaptureBuffer,
  type CaptureBuffer,
} from "@notation/lenses-core";
import type { BindRequest } from "./browser-backend.js";

export const MAX_BODY_BYTES = 512 * 1024;

/** The intercept buffer each page records its JSON and text responses into. */
export function createPageCaptures() {
  const captureBuffers = new WeakMap<Page, CaptureBuffer>();
  /** A file lens's larger body limit, for the page it last bound. */
  const captureLimits = new WeakMap<Page, number>();
  function limitCaptures(page: Page, request: BindRequest): void {
    if (request.maxBodyBytes) captureLimits.set(page, request.maxBodyBytes);
    else captureLimits.delete(page);
  }

  function captures(page: Page): CaptureBuffer {
    let state = captureBuffers.get(page);
    if (state) return state;
    state = createCaptureBuffer();
    captureBuffers.set(page, state);
    const owned = state;
    page.on("response", (response) => {
      void (async () => {
        const contentType = response.headers()["content-type"] ?? "";
        if (!/json|text|^$/.test(contentType)) return;
        try {
          const body = await response.text();
          const trimmed = body.trimStart();
          const looksJson =
            contentType.includes("json") ||
            trimmed.startsWith("{") ||
            trimmed.startsWith("[");
          if (!looksJson || body.length > (captureLimits.get(page) ?? MAX_BODY_BYTES)) return;
          pushCapture(owned, {
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
            body,
            timestamp: Date.now(),
          });
        } catch {
          // Chrome may evict a response body during navigation.
        }
      })();
    });
    return state;
  }

  function resetCaptures(page: Page): CaptureBuffer {
    const state = captures(page);
    resetCaptureBuffer(state);
    return state;
  }

  return { limitCaptures, captures, resetCaptures };
}
