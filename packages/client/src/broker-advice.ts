import { PLAYWRIGHT_EXTENSION_INSTALL_URL } from "./playwright-relay/protocol.js";

export interface BrowserAdviceState {
  extensionAvailable: boolean;
  cdpAvailable: boolean;
  extensionInstalled: boolean | undefined;
  extensionAttemptFailed: boolean;
  browserPresent: boolean | undefined;
  acquiring: boolean;
  extensionToken: boolean;
}

/** Only report an action the user must take; lazy idle disconnect is healthy. */
export function browserAdvice(state: BrowserAdviceState): string | undefined {
  if (state.extensionAvailable || state.cdpAvailable) return undefined;
  if (state.extensionInstalled === false) {
    return (
      `Playwright Extension is not installed; install it from ${PLAYWRIGHT_EXTENSION_INSTALL_URL} ` +
      "or enable chrome://inspect/#remote-debugging for the CDP fallback (Chrome will ask you to click Allow)"
    );
  }
  if (state.extensionAttemptFailed) {
    return (
      "Playwright Extension did not connect; using CDP until the next acquire or broker restart. " +
      "Enable chrome://inspect/#remote-debugging (Chrome will ask you to click Allow)"
    );
  }
  if (state.browserPresent === false) {
    return "Chrome is not running; start it, then retry the browser call";
  }
  if (
    state.extensionInstalled === undefined ||
    !state.acquiring ||
    state.extensionToken
  ) {
    return undefined;
  }
  return "Approve the Playwright Extension connect page to continue this browser acquisition.";
}
