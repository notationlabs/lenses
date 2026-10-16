import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { authProof } from "../src/broker-auth.js";

const state = vi.hoisted(() => ({
  browser: undefined as unknown,
  leaseDeadlines: [] as Array<{ expiresAt: number; observedAt: number }>,
}));
vi.mock("../src/auth-leases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth-leases.js")>();
  return {
    ...actual,
    createBrokerAuthLeases: (...args: Parameters<typeof actual.createBrokerAuthLeases>) => {
      const leases = actual.createBrokerAuthLeases(...args);
      return {
        ...leases,
        wait: (...waitArgs: Parameters<typeof leases.wait>) => {
          state.leaseDeadlines.push({ expiresAt: waitArgs[2], observedAt: Date.now() });
          return leases.wait(...waitArgs);
        },
      };
    },
  };
});
vi.mock("../src/cdp-host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cdp-host.js")>();
  return {
    ...actual,
    createCdpBackend: (log: (message: string) => void, transport?: import("../src/cdp-host.js").CdpTransport) =>
      actual.createCdpBackend(log, transport ?? {
        name: "cdp", pollForConnection: false, retryConnect: false,
        looksReady: () => true, probeLive: async () => true,
        connect: async () => state.browser as Awaited<ReturnType<typeof puppeteer.launch>>,
        connectHint: () => "test Chrome", staleHint: () => "test Chrome",
      }),
  };
});
vi.mock("../src/chrome-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/chrome-paths.js")>(),
  playwrightExtensionInstalled: async () => false,
}));
vi.mock("../src/launch-browser.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/launch-browser.js")>(),
  browserRunning: async () => true,
  raiseChrome: async () => {},
}));
const token = "test-broker-credential-with-at-least-32-characters";
vi.mock("../src/broker-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/broker-auth.js")>(),
  loadBrokerAuth: () => ({ version: 1, brokerToken: "test-broker-credential-with-at-least-32-characters" }),
}));

const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome");

describe.skipIf(!existsSync(chrome))("broker WebSocket auth lease", () => {
  it.each(["same tab", "replaced tab"])("returns one final value through a two-page login (%s)", async (mode) => {
    const server = createServer((req, res) => {
      const path = req.url?.split("?")[0];
      if (path === "/protected" && !req.headers.cookie?.includes("signed=1")) {
        res.writeHead(302, { location: "/login" }).end();
      } else if (path === "/login") {
        res.end('<title>Login</title><a href="/login/password">Next</a>');
      } else if (path === "/login/password") {
        res.end('<title>Password</title><a href="/finish">Sign in</a>');
      } else if (path === "/finish") {
        res.writeHead(302, { location: "/protected", "set-cookie": "signed=1; Path=/" }).end();
      } else {
        res.end('<title>Protected</title><h1>Signed in</h1>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://127.0.0.1:${address.port}`;
    const reservation = createTcpServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const reserved = reservation.address();
    if (!reserved || typeof reserved === "string") throw new Error("missing broker port");
    const port = reserved.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const oldArg = process.argv[2];
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    let socket: WebSocket | undefined;
    state.leaseDeadlines.length = 0;
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
      state.browser = browser;
      process.argv[2] = String(port);
      // The daemon is a process entry point; reload it for each isolated port.
      vi.resetModules();
      await import("../src/broker-daemon.js");
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const current = socket;
      const frames: Array<{ type: string; id?: string; message?: string; nonce?: string; result?: unknown }> = [];
      current.on("message", (data) => frames.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => current.once("open", resolve).once("error", reject));
      const nonce = "test-client-nonce-that-is-long-enough";
      current.send(JSON.stringify({ type: "client-auth", nonce }));
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "auth-challenge")).toBe(true));
      const challenge = frames.find((frame) => frame.type === "auth-challenge")!;
      current.send(JSON.stringify({ type: "auth-response", proof: authProof(token, "client", nonce, challenge.nonce!) }));
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "status")).toBe(true));
      current.send(JSON.stringify({
        type: "call", id: "multi-page", timeoutMs: 8000, authLeaseMs: 12_000,
        deadline: Date.now() + 8000, params: {},
        spec: {
          name: "@test/protected", url: `${origin}/protected`, effects: { reads: [origin], writes: [] },
          exceptions: { needs_auth: { matches: "$contains($page.url, '/login')" } },
          resolve: [{ kind: "dom", fields: { heading: { selector: "h1" } } }],
        },
      }));
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === "progress" &&
        frame.message?.includes("waiting for sign-in"))).toHaveLength(1), { timeout: 12_000 });
      expect(state.leaseDeadlines).not.toHaveLength(0);
      expect(state.leaseDeadlines[0].expiresAt - state.leaseDeadlines[0].observedAt)
        .toBeGreaterThan(11_000);
      expect(state.leaseDeadlines[0].expiresAt - state.leaseDeadlines[0].observedAt)
        .toBeLessThanOrEqual(12_000);
      const login = (await browser.pages()).find((page) => page.url().endsWith("/login"));
      expect(login).toBeDefined();
      let form = login!;
      if (mode === "replaced tab") {
        // The extension may lose its Page when the login opens another tab.
        // That must not end the client's lease or open yet another sign-in tab.
        form = await browser.newPage();
        await form.goto(`${origin}/login/password`);
        await login!.close();
      } else {
        await form.click("a");
      }
      let createdDuringPoll = 0;
      const created = () => { createdDuringPoll++; };
      browser.on("targetcreated", created);
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      expect(state.leaseDeadlines.length).toBeGreaterThan(1);
      expect(state.leaseDeadlines.every(({ expiresAt }) => expiresAt === state.leaseDeadlines[0].expiresAt)).toBe(true);
      expect(createdDuringPoll).toBe(0);
      expect(frames.filter((frame) => frame.type === "result" && frame.id === "multi-page")).toHaveLength(0);
      expect(form.url()).toBe(`${origin}/login/password`);
      await form.click("a");
      await vi.waitFor(() => expect(frames.filter((frame) => frame.type === "result" &&
        frame.id === "multi-page")).toHaveLength(1), { timeout: 12_000 });
      expect(frames.find((frame) => frame.type === "result" && frame.id === "multi-page")?.result)
        .toMatchObject({ kind: "value" });
      expect(createdDuringPoll).toBe(0);
      browser.off("targetcreated", created);
      current.send(JSON.stringify({ type: "control", id: "shutdown", action: "shutdown" }));
      await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 12_000 });
    } finally {
      if (socket?.readyState === WebSocket.OPEN && !exit.mock.calls.length) {
        socket.send(JSON.stringify({ type: "control", id: "cleanup", action: "shutdown" }));
        await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 12_000 }).catch(() => {});
      }
      socket?.close();
      process.argv[2] = oldArg;
      exit.mockRestore();
      await browser?.close().catch(() => browser?.process()?.kill());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 45_000);
});
