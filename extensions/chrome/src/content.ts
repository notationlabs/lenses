/** Relay page intercepts and serve service-worker extraction requests. */

import {
  pageDomExtract,
  pagePerformClick,
  pagePerformCount,
  pagePerformFill,
  pagePerformPress,
  pagePerformSubmit,
  pageSnapshot,
  type DomResolver,
} from "@djgrant/lenses-core";
import { formatError } from "./errors.js";

export {};

const MARK = "__lens_host__";

let orphaned = false;
window.addEventListener("message", (event) => {
  const data = event.data;
  if (
    !data ||
    data.source !== MARK ||
    data.kind !== "intercepted" ||
    orphaned
  ) {
    return;
  }
  try {
    chrome.runtime
      .sendMessage({
        type: "intercepted",
        response: {
          url: data.url,
          method: data.method,
          status: data.status,
          body: data.body,
          timestamp: data.timestamp,
        },
      })
      .catch(() => {});
  } catch {
    orphaned = true;
  }
});

chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    try {
      if (message.type === "ping") {
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "dom_extract") {
        sendResponse(
          pageDomExtract(message.spec as DomResolver)
        );
        return false;
      }
      // The service worker owns wait polling and navigation; only
      // single-shot probes run here.
      if (message.type === "perform_fill") {
        sendResponse(
          pagePerformFill({ selector: message.selector, value: message.value })
        );
        return false;
      }
      if (message.type === "perform_click") {
        sendResponse(pagePerformClick({ selector: message.selector }));
        return false;
      }
      if (message.type === "perform_submit") {
        sendResponse(pagePerformSubmit({ selector: message.selector, form: message.form }));
        return false;
      }
      if (message.type === "perform_press") {
        sendResponse(pagePerformPress({ key: message.key }));
        return false;
      }
      if (message.type === "perform_count") {
        sendResponse({ count: pagePerformCount({ selector: message.selector }) });
        return false;
      }
      if (message.type === "snapshot") {
        sendResponse(
          pageSnapshot({
            maxChars: message.maxChars,
            html: message.html,
            maxHtmlChars: message.maxHtmlChars,
          })
        );
        return false;
      }
    } catch (error) {
      sendResponse({ error: formatError(error) });
    }
    return false;
  }
);
