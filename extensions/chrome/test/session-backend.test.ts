import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionRpcOperation,
  ExtensionRpcResult,
} from "@djgrant/lens";
import { createFakeChrome, type FakeChrome } from "./fake-chrome.js";
import {
  createExtensionSessionBackend,
  reapAbandonedTabLeases,
  type ExtensionSessionBackend,
} from "../src/background/session-backend.js";

const LEASES_KEY = "createdTabLeases";
const TARGET = "https://example.com/orders";
const SIGN_IN = "https://example.com/login?next=/orders";

let chrome: FakeChrome;
let backend: ExtensionSessionBackend;

const run = async (
  operation: ExtensionRpcOperation
): Promise<ExtensionRpcResult> =>
  backend.handle({
    type: "extension-rpc",
    requestId: crypto.randomUUID(),
    epoch: "test-epoch",
    deadline: Date.now() + 5000,
    operation,
  });

const bind = async (
  target = TARGET,
  navigation: "reuse" | "fresh" = "fresh"
) => {
  const result = await run({
    name: "bind",
    target,
    loadTimeoutMs: 1000,
    navigation,
  });
  if (result.name !== "bind") throw new Error("expected a bind result");
  return result.session;
};

const finish = (sessionId: string, disposition: "close-if-created" | "keep") =>
  run({ name: "finish", sessionId, disposition });

const leases = () => chrome.storage.get(LEASES_KEY);

beforeEach(() => {
  chrome = createFakeChrome();
  vi.stubGlobal("chrome", chrome.api);
  backend = createExtensionSessionBackend();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("created-tab leases", () => {
  it("closes a created tab and drops its lease on a close-if-created finish", async () => {
    const session = await bind();
    expect(session.created).toBe(true);
    expect(chrome.createdUrls).toEqual([TARGET]);
    expect(leases()).toEqual([{ tabId: 1, target: TARGET }]);

    await finish(session.id, "close-if-created");

    expect(chrome.removed).toEqual([1]);
    expect(chrome.tabs.size).toBe(0);
    expect(leases()).toEqual([]);
  });

  it("keeps a created tab and its lease on a keep finish", async () => {
    const session = await bind();

    await finish(session.id, "keep");

    // The regression in 9ad7340: dropping the lease here left the tab open and
    // untracked, so nothing could ever collect it.
    expect(chrome.removed).toEqual([]);
    expect(chrome.tabs.has(1)).toBe(true);
    expect(leases()).toEqual([{ tabId: 1, target: TARGET }]);
  });

  it("never closes a tab it did not create, under either disposition", async () => {
    for (const disposition of ["close-if-created", "keep"] as const) {
      chrome = createFakeChrome();
      vi.stubGlobal("chrome", chrome.api);
      backend = createExtensionSessionBackend();
      const existing = chrome.addTab(TARGET);

      const session = await bind();
      expect(session).toMatchObject({ created: false });
      expect(chrome.createdUrls).toEqual([]);
      expect(leases()).toBeUndefined();

      await finish(session.id, disposition);

      expect(chrome.removed).toEqual([]);
      expect(chrome.tabs.has(existing.id)).toBe(true);
    }
  });

  it("closes an in-flight created tab when the socket drops", async () => {
    await bind();

    await backend.close();

    expect(chrome.removed).toEqual([1]);
    expect(leases()).toEqual([]);
  });
});

describe("find-page", () => {
  it("reports whether any tab is showing the url", async () => {
    chrome.addTab(SIGN_IN);

    await expect(run({ name: "find-page", url: SIGN_IN })).resolves.toEqual({
      name: "find-page",
      found: true,
    });
    await expect(run({ name: "find-page", url: TARGET })).resolves.toEqual({
      name: "find-page",
      found: false,
    });
  });
});

describe("reapAbandonedTabLeases", () => {
  it("collects a kept tab left by a previous run", async () => {
    const kept = chrome.addTab(SIGN_IN);
    const untracked = chrome.addTab("https://example.com/other");
    chrome.storage.set(LEASES_KEY, [{ tabId: kept.id, target: TARGET }]);

    await reapAbandonedTabLeases();

    expect(chrome.removed).toEqual([kept.id]);
    expect(chrome.tabs.has(untracked.id)).toBe(true);
    expect(leases()).toBeUndefined();
  });

  it("reads a lease written before leases carried a target", async () => {
    const kept = chrome.addTab(SIGN_IN);
    chrome.storage.set(LEASES_KEY, [kept.id]);

    await reapAbandonedTabLeases();

    expect(chrome.removed).toEqual([kept.id]);
  });

  it("survives a lease whose tab the user already closed", async () => {
    chrome.storage.set(LEASES_KEY, [{ tabId: 99, target: TARGET }]);

    await expect(reapAbandonedTabLeases()).resolves.toBeUndefined();
  });
});

describe("rebinding a kept tab", () => {
  it("reuses the tab it opened for the target after a redirect moved it", async () => {
    const first = await bind();
    await finish(first.id, "keep");
    // needs_auth: the target bounced the tab onto a sign-in form.
    chrome.setUrl(1, SIGN_IN);

    const second = await bind();

    expect(chrome.createdUrls).toEqual([TARGET]);
    expect(second).toMatchObject({ created: false, navigated: true });
    expect(chrome.navigations).toEqual([[1, TARGET]]);
    expect(chrome.tabs.size).toBe(1);

    // The lease belongs to the call that kept the tab. This one borrowed it,
    // so it may not close it, even on a disposition that closes its own tabs.
    await finish(second.id, "close-if-created");
    expect(chrome.removed).toEqual([]);
    expect(chrome.tabs.has(1)).toBe(true);
    expect(leases()).toEqual([{ tabId: 1, target: TARGET }]);
  });

  it("does not accumulate a tab per call across a run of signed-out calls", async () => {
    for (let call = 0; call < 5; call++) {
      const session = await bind();
      await finish(session.id, "keep");
      chrome.redirectAll(TARGET, SIGN_IN);
    }

    expect(chrome.tabs.size).toBe(1);
    expect(chrome.createdUrls).toEqual([TARGET]);
  });

  it("keeps leases for different targets apart", async () => {
    const other = "https://example.com/invoices";
    const first = await bind();
    await finish(first.id, "keep");
    chrome.setUrl(1, SIGN_IN);

    const second = await bind(other);

    expect(second.created).toBe(true);
    expect(chrome.createdUrls).toEqual([TARGET, other]);
    expect(leases()).toEqual([
      { tabId: 1, target: TARGET },
      { tabId: 2, target: other },
    ]);
  });

  it("creates a fresh tab when the user closed the leased one", async () => {
    const first = await bind();
    await finish(first.id, "keep");
    chrome.tabs.delete(1);

    const second = await bind();

    expect(second.created).toBe(true);
    expect(chrome.createdUrls).toEqual([TARGET, TARGET]);
  });

  it("reuses a leased tab still sitting on the target without renavigating it", async () => {
    const first = await bind();
    await finish(first.id, "keep");

    const second = await bind(TARGET, "reuse");

    expect(chrome.createdUrls).toEqual([TARGET]);
    expect(second).toMatchObject({ created: false, navigated: false });
    expect(chrome.navigations).toEqual([]);
  });
});
