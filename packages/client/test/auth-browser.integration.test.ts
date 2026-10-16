import { createServer } from "node:http";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import type { LensBridgeRequest } from "@djgrant/lenses-core";
import { createCdpBackend } from "../src/cdp-host.js";
import { createBrokerOrchestrator, type BrokerFrame } from "../src/broker-orchestrator.js";
import { createBrokerAuthLeases } from "../src/auth-leases.js";

vi.mock("../src/launch-browser.js", () => ({ raiseChrome: async () => {} }));

const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome");

describe.skipIf(!existsSync(chrome))("real browser sign-in lease", () => {
  it("keeps a branded banner on the original tab through intermediate login pages and resolves after sign-in", async () => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/protected" && !req.headers.cookie?.includes("signed=1")) {
        res.writeHead(302, { location: "/login" }).end();
      } else if (path === "/login") {
        res.end('<html><title>Login</title><a href="/login/password">Next</a></html>');
      } else if (path === "/login/password") {
        res.end('<html><title>Password</title><a href="/finish">Sign in</a></html>');
      } else if (path === "/finish") {
        res.writeHead(302, { location: "/protected", "set-cookie": "signed=1; Path=/" }).end();
      } else {
        res.end('<html><title>Protected</title><h1>Signed in</h1></html>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
      const current = browser;
      const backend = createCdpBackend(() => {}, {
        name: "test", pollForConnection: false, retryConnect: false,
        looksReady: () => true, probeLive: async () => true,
        connect: async () => current,
        connectHint: () => "test", staleHint: () => "test",
      });
      await backend.acquire();
      const orchestrator = createBrokerOrchestrator([backend]);
      const leases = createBrokerAuthLeases(orchestrator);
      const message: Extract<LensBridgeRequest, { type: "call" }> = {
        type: "call", id: "auth-e2e", params: {}, timeoutMs: 10_000,
        spec: {
          name: "@test/protected", url: `${origin}/protected`, effects: { reads: [origin], writes: [] },
          exceptions: { needs_auth: { matches: "$contains($page.url, '/login')" } },
          resolve: [{ kind: "dom", fields: { heading: { selector: "h1" } } }],
        },
      };
      const attempt = async (authRetry = false) => {
        let result: Extract<BrokerFrame, { type: "result" }> | undefined;
        await orchestrator.handle({ ...message, deadline: Date.now() + 10_000 }, (frame) => {
          if (frame.type === "result") result = frame;
        }, { authRetry });
        if (!result) throw new Error("no result");
        return result;
      };
      const first = await attempt();
      expect(first.result).toMatchObject({ kind: "outcome", name: "needs_auth" });
      const login = (await current.pages()).find((page) => page.url().endsWith("/login"));
      expect(login).toBeDefined();
      const authExpiresAt = Date.now() + 12_000;
      const wait = (resume = false) => leases.wait(origin, `${origin}/protected`, authExpiresAt, undefined, resume);
      const waiting = wait();
      await vi.waitFor(async () => {
        expect(await login!.evaluate(() => document.querySelector('[data-lenses-auth]')?.shadowRoot)).toBeNull();
        expect(await login!.evaluate(() => document.querySelector('[data-lenses-auth]') !== null)).toBe(true);
      });
      // Closed shadow root: inspect the accessible banner, not site DOM.
      const cdp = await login!.createCDPSession();
      const tree = await cdp.send("Accessibility.getFullAXTree");
      const text = tree.nodes.map((node) => node.name?.value).join(" ");
      expect(text).toContain("Lenses");
      expect(text).toContain("Sign in to 127.0.0.1 to continue");
      expect(text).toMatch(/\(0:\d\d\)/);
      expect(text).not.toContain("Cancel");
      await cdp.detach();
      // The banner takes up layout space; it neither covers nor clicks through
      // to the login link beneath it.
      expect(await login!.evaluate(() => {
        const banner = document.querySelector('[data-lenses-auth]')!.getBoundingClientRect();
        const link = document.querySelector('a')!.getBoundingClientRect();
        return link.top >= banner.bottom;
      })).toBe(true);
      // A periodic retry must not replace the banner element or its shadow tree.
      await login!.evaluate(() => { (document.querySelector('[data-lenses-auth]') as any).__marker = 42; });
      expect(await waiting).toBe("poll");
      const pollingAgain = wait(true);
      await vi.waitFor(async () => expect(await login!.evaluate(() =>
        (document.querySelector('[data-lenses-auth]') as any)?.__marker)).toBe(42));
      await login!.click("a");
      expect(await pollingAgain).toBe("moved");
      expect(login!.url()).toBe(`${origin}/login/password`);
      const intermediate = await attempt(true);
      expect(intermediate.result).toMatchObject({ kind: "outcome", name: "needs_auth" });
      const waitingAgain = wait(true);
      await vi.waitFor(async () => expect(await login!.evaluate(() => document.querySelector('[data-lenses-auth]') !== null)).toBe(true));
      await login!.click("a");
      expect(await waitingAgain).toBe("moved");
      expect((await attempt(true)).result).toMatchObject({ kind: "value" });
      expect((await current.pages()).filter((page) => page.url().includes("/login"))).toHaveLength(0);
      await backend.release();
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45_000);
});
