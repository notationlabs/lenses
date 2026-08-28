import { describe, expect, it } from "vitest";
import { browserAdvice, type BrowserAdviceState } from "../src/broker-advice.js";

const readyOnDemand: BrowserAdviceState = {
  extensionAvailable: false,
  cdpAvailable: false,
  extensionInstalled: true,
  extensionAttemptFailed: false,
  browserPresent: true,
  acquiring: false,
  extensionToken: true,
};

describe("broker browser advice", () => {
  it("does not turn normal lazy disconnection into an agent blocker", () => {
    expect(browserAdvice(readyOnDemand)).toBeUndefined();
    expect(browserAdvice({ ...readyOnDemand, extensionToken: false })).toBeUndefined();
    expect(browserAdvice({
      ...readyOnDemand,
      extensionInstalled: undefined,
      browserPresent: undefined,
    })).toBeUndefined();
  });

  it("requests approval only while an un-tokened acquisition is waiting", () => {
    expect(browserAdvice({
      ...readyOnDemand,
      acquiring: true,
      extensionToken: false,
    })).toBe(
      "Approve the Playwright Extension connect page to continue this browser acquisition."
    );
  });

  it("does not prescribe setup when the next call will launch Chrome", () => {
    expect(browserAdvice({
      ...readyOnDemand,
      browserPresent: false,
      extensionAttemptFailed: true,
    })).toBeUndefined();
  });

  it("retains actionable setup and failure advice while Chrome is present", () => {
    expect(browserAdvice({ ...readyOnDemand, extensionInstalled: false })).toContain(
      "not installed"
    );
    expect(browserAdvice({ ...readyOnDemand, extensionAttemptFailed: true })).toContain(
      "did not connect"
    );
  });
});
