/** Relay page intercepts and serve service-worker extraction requests. */

import {
  pageDomExtract,
  pageSnapshot,
  type DomResolver,
} from "@djgrant/lens";
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
