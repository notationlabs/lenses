import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionRpcOperation,
  ExtensionRpcResult,
} from "@djgrant/lenses-core";
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
    expect(leases()).toEqual([
      { tabId: 1, target: TARGET, keptUrl: TARGET },
    ]);
  });

  it("brings the kept tab to the front on a keep finish", async () => {
    const session = await bind();

    await finish(session.id, "keep");

    expect(chrome.activated).toEqual([1]);
    expect(chrome.focusedWindows).toEqual([1]);
  });

  it("posts a sign-in notification when Chrome lacks OS focus", async () => {
    chrome.setOsFocus(false);
    const session = await bind();
    chrome.setUrl(1, SIGN_IN);

    await finish(session.id, "keep");

    expect(chrome.notifications).toEqual([
      {
        id: "lens-gate:1",
        title: "Sign-in needed",
        message:
          "A lens call is waiting for you to sign in to example.com. Click to open the tab.",
      },
    ]);
  });

  it("posts no notification when a Chrome window holds OS focus", async () => {
    const session = await bind();

    await finish(session.id, "keep");

    expect(chrome.notifications).toEqual([]);
  });

  it("focuses the kept tab when its notification is clicked", async () => {
    const { watchGateNotifications } = await import(
      "../src/background/notifications.js"
    );
    watchGateNotifications();
    chrome.setOsFocus(false);
    const session = await bind();
    await finish(session.id, "keep");
    chrome.activated.length = 0;

    chrome.clickNotification("lens-gate:1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.activated).toEqual([1]);
    expect(chrome.notifications).toEqual([]);
  });

  it("does not steal focus on a close-if-created finish", async () => {
    const session = await bind();

    await finish(session.id, "close-if-created");

    expect(chrome.activated).toEqual([]);
    expect(chrome.focusedWindows).toEqual([]);
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

describe("find-gate", () => {
  const ORIGIN = "https://example.com";
  const findGate = async (origin = ORIGIN) => {
    const result = await run({ name: "find-gate", origin });
    if (result.name !== "find-gate") throw new Error("expected find-gate");
    return result.gate;
  };

  const keepSignedOutCall = async () => {
    const session = await bind();
    chrome.setUrl(1, SIGN_IN);
    await finish(session.id, "keep");
  };

  it("gates a site while its kept tab stays at the sign-in place", async () => {
    await keepSignedOutCall();

    expect(leases()).toEqual([
      { tabId: 1, target: TARGET, keptUrl: SIGN_IN },
    ]);
    await expect(findGate()).resolves.toEqual({
      url: SIGN_IN,
      target: TARGET,
    });
    await expect(findGate("https://other.com")).resolves.toBeNull();
  });

  it("keeps gating when the sign-in page rewrites its query", async () => {
    await keepSignedOutCall();
    chrome.setUrl(1, "https://example.com/login?next=/orders&state=fresh");

    await expect(findGate()).resolves.toEqual({
      url: "https://example.com/login?next=/orders&state=fresh",
      target: TARGET,
    });
  });

  it("dissolves when the tab leaves the sign-in place", async () => {
    await keepSignedOutCall();
    chrome.setUrl(1, TARGET);

    await expect(findGate()).resolves.toBeNull();
  });

  it("dissolves when the user closes the kept tab", async () => {
    await keepSignedOutCall();
    chrome.tabs.delete(1);

    await expect(findGate()).resolves.toBeNull();
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
    expect(leases()).toEqual([
      { tabId: 1, target: TARGET, keptUrl: TARGET },
    ]);
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
      { tabId: 1, target: TARGET, keptUrl: TARGET },
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
