import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canRun, connectBroker, freePort, startHarness, type BrokerClient, type Harness } from "./electron.js";

/**
 * A site whose content needs a session, and whose login page offers the two
 * usual ways to sign in with a provider: a popup that posts the code back to
 * the login page, or a redirect of the login tab itself. The site is
 * 127.0.0.1 and the provider localhost: different origins.
 */
function signInServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    const site = `http://127.0.0.1:${url.port}`;
    const provider = `http://localhost:${url.port}`;
    const authorize = (back: string, page = "signin") =>
      `${provider}/authorize?state=s1&page=${page}&redirect_uri=${encodeURIComponent(site + back)}`;
    if (url.hostname === "localhost") {
      switch (url.pathname) {
        case "/authorize":
          // page=login: a provider whose page the lens's needs_auth (/login) matches too.
          return res.writeHead(302, { location: `/${url.searchParams.get("page") === "login" ? "oauth/login" : "signin"}${url.search}` }).end();
        case "/signin":
        case "/oauth/login":
          return html(`<title>Provider</title>
            <form action="/approve">
              <input type="hidden" name="redirect_uri" value="${url.searchParams.get("redirect_uri")}">
              <input type="hidden" name="state" value="${url.searchParams.get("state")}">
              <button id="allow">Allow</button>
            </form>`);
        case "/approve": {
          const back = new URL(url.searchParams.get("redirect_uri")!);
          back.searchParams.set("code", "c123");
          return res.writeHead(302, { location: back.href }).end();
        }
      }
    } else {
      switch (url.pathname) {
        case "/protected":
          if (!req.headers.cookie?.includes("session=1")) return res.writeHead(302, { location: "/login" }).end();
          return html(`<title>Protected</title><h1>Signed in</h1>`);
        case "/login":
          return html(`<title>Login</title>
            <button id="popup">Sign in with Provider</button>
            <button id="blank-popup">Sign in with Provider (blank first)</button>
            <a id="redirect" href="${authorize("/session")}">Continue with Provider</a>
            <a id="redirect-login" href="${authorize("/session", "login")}">Continue with Provider (its login page)</a>
            <script>
              document.querySelector("#popup").onclick = () =>
                window.open(${JSON.stringify(authorize("/callback"))}, "oauth", "popup,width=480,height=640");
              // As OAuth libraries do: open the popup inside the click, then
              // point it at the provider once the URL is ready.
              document.querySelector("#blank-popup").onclick = () => {
                const popup = window.open("", "oauth", "popup,width=480,height=640");
                setTimeout(() => { popup.location.href = ${JSON.stringify(authorize("/callback"))}; }, 100);
              };
              addEventListener("message", (event) => {
                if (event.origin === location.origin && event.data?.type === "oauth")
                  location.href = "/session?code=" + event.data.code;
              });
            </script>`);
        case "/callback":
          return html(`<title>Callback</title><script>
            window.opener.postMessage({ type: "oauth", code: new URLSearchParams(location.search).get("code") }, location.origin);
            window.close();
          </script>`);
        case "/session":
          if (url.searchParams.get("code") !== "c123") return res.writeHead(400).end();
          return res.writeHead(302, { location: "/protected", "set-cookie": "session=1; Path=/" }).end();
      }
    }
    res.writeHead(404).end();
  });
}

describe.skipIf(!canRun)("signing in while a lens call waits", () => {
  const token = "harness-broker-token-with-at-least-32-characters";
  let harness: Harness;
  let server: Server;
  let site: (path: string) => string;
  let provider: (path: string) => string;
  let broker: BrokerClient;
  let calls = 0;

  beforeAll(async () => {
    server = signInServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    site = (path) => `http://127.0.0.1:${port}${path}`;
    provider = (path) => `http://localhost:${port}${path}`;
    const dir = mkdtempSync(join(tmpdir(), "lenses-app-broker-"));
    const authFile = join(dir, "broker-auth.json");
    writeFileSync(authFile, JSON.stringify({ version: 1, brokerToken: token }), { mode: 0o600 });
    const brokerPort = await freePort();
    harness = await startHarness({
      HARNESS_BROKER_PORT: String(brokerPort),
      LENS_BROKER_AUTH_FILE: authFile,
      LENS_CACHE_DIR: dir,
    });
    broker = await connectBroker(brokerPort, token);
  });

  afterAll(async () => {
    broker?.close();
    await harness?.stop();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    await harness.control("forward");
  });

  afterEach(async () => {
    await harness.control("closeWindow");
    // Sign out again, and close every page.
    for (const page of await harness.pages()) {
      await harness.control("evaluate", page.id, `document.cookie = "session=; Max-Age=0; Path=/"`).catch(() => {});
      await harness.control("close", page.id).catch(() => {});
    }
    await expect.poll(() => harness.pages()).toEqual([]);
  });

  /** A lens call on the protected page, as the CLI sends it, with time to sign in. */
  function call(): string {
    const id = `call-${++calls}`;
    broker.send({
      type: "call", id, params: {}, timeoutMs: 20_000, authLeaseMs: 25_000, deadline: Date.now() + 20_000,
      spec: {
        name: "@test/protected", url: site("/protected"), effects: { reads: [site("")], writes: [] },
        exceptions: { needs_auth: { matches: "$contains($page.url, '/login')" } },
        resolve: [{ kind: "dom", fields: { heading: { selector: "h1" } } }],
      },
    });
    return id;
  }

  const pageAt = async (prefix: string) => (await harness.pages()).find((page) => page.url.startsWith(prefix));
  const result = (id: string) => broker.framesFor(id).find((frame) => frame.type === "result");

  /**
   * The call has stopped at the login page: it is in the inbox, and a notice
   * says so. Nothing came forward: the window stays shut, the page unseen.
   */
  async function waitingForSignIn(id: string) {
    await expect
      .poll(() => broker.framesFor(id).some((frame) => frame.type === "progress" && frame.message?.includes("waiting for sign-in")), { timeout: 15_000 })
      .toBe(true);
    const login = await pageAt(site("/login"));
    expect(login).toMatchObject({ popup: false, exposed: true, shown: false });
    await expect.poll(() => harness.control("inbox")).toEqual([
      expect.objectContaining({ page: login!.id, site: "127.0.0.1", need: "needs_auth", ignored: false }),
    ]);
    await expect.poll(() => harness.control("notice")).toEqual({ page: login!.id, title: "Sign in to 127.0.0.1", more: 0, focusable: false });
    expect(await harness.control("noticeText")).toContain("Sign in to 127.0.0.1");
    expect(await harness.control("window")).toEqual({ visible: false, shown: null });
    expect(await harness.control("forward")).toEqual([]);
    // With the broker's banner telling the user what to do.
    await expect
      .poll(() => harness.control("evaluate", login!.id, `document.querySelector("[data-lenses-auth]") !== null`))
      .toBe(true);
    return login!;
  }

  /** The user clicks Open on the notice: the window opens on the login page. */
  async function userOpens(login: { id: number }) {
    await harness.control("noticeClick", "open");
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: login.id });
    expect(await harness.control("notice")).toBeNull();
    // Coming forward now is the user's doing.
    expect(await harness.control<string[]>("forward")).toContain("app.focus");
  }

  /** Signed in: the call has its value, and nothing is left in the inbox. */
  async function signedIn(id: string) {
    await expect.poll(() => result(id), { timeout: 15_000 }).toBeDefined();
    expect(result(id)!.result).toMatchObject({ kind: "value" });
    expect(JSON.stringify(result(id)!.result)).toContain("Signed in");
    await expect.poll(() => harness.control("inbox")).toEqual([]);
    expect(await harness.control("notice")).toBeNull();
  }

  async function userClicks(prefix: string, selector: string) {
    await expect.poll(async () => !!(await pageAt(prefix)), { timeout: 10_000 }).toBe(true);
    const page = await pageAt(prefix);
    await expect
      .poll(() => harness.control("evaluate", page!.id, `!!document.querySelector(${JSON.stringify(selector)})`))
      .toBe(true);
    await harness.control("evaluate", page!.id, `document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  it("the user opens the notice and signs in with a popup, and the call returns", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await userOpens(login);
    await userClicks(site("/login"), "#popup");
    // Asked for from the page on show, the popup comes forward.
    await expect.poll(() => pageAt(provider("/signin"))).toMatchObject({ popup: true, shown: true });
    await userClicks(provider("/signin"), "#allow");
    await signedIn(id);
    // The popup closed itself; no sign-in page is left over.
    expect(await pageAt(provider(""))).toBeUndefined();
    expect(await pageAt(site("/login"))).toBeUndefined();
  });

  it("the user opens the notice and signs in by redirect, and the call returns", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await userOpens(login);
    await userClicks(site("/login"), "#redirect");
    await userClicks(provider("/signin"), "#allow");
    await signedIn(id);
  });

  it("ignoring the notice leaves the item in the inbox, and the call waiting, until the user deals with it", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await harness.control("noticeClick", "ignore");
    await expect.poll(() => harness.control("notice")).toBeNull();
    expect(await harness.control("inbox")).toEqual([expect.objectContaining({ page: login.id, ignored: true })]);
    // Past a few of the broker's one-second sign-in checks: no new notice, nothing forward.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await harness.control("notice")).toBeNull();
    expect(await harness.control("forward")).toEqual([]);
    expect(result(id)).toBeUndefined();
    // Later, from the menu bar.
    await harness.control("open", login.id);
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: login.id });
    await userClicks(site("/login"), "#redirect");
    await userClicks(provider("/signin"), "#allow");
    await signedIn(id);
  });

  it("the user closes the popup without signing in: the call keeps waiting, and a later sign-in still returns it", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await userOpens(login);
    await userClicks(site("/login"), "#popup");
    await expect.poll(async () => !!(await pageAt(provider("/signin")))).toBe(true);
    await harness.control("close", (await pageAt(provider("/signin")))!.id);
    // Past a few of the broker's one-second sign-in checks.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(result(id)).toBeUndefined();
    expect(await pageAt(site("/login"))).toMatchObject({ id: login.id, shown: true });
    expect(await harness.control("inbox")).toEqual([expect.objectContaining({ page: login.id })]);
    await userClicks(site("/login"), "#redirect");
    await userClicks(provider("/signin"), "#allow");
    await signedIn(id);
  });

  it("the user signs in with a popup opened blank and then sent to the provider", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await userOpens(login);
    await userClicks(site("/login"), "#blank-popup");
    await userClicks(provider("/signin"), "#allow");
    await signedIn(id);
  });

  it("the broker leaves the page alone while it is on a provider page its needs_auth also matches", async () => {
    const id = call();
    const login = await waitingForSignIn(id);
    await userOpens(login);
    await userClicks(site("/login"), "#redirect-login");
    await expect.poll(async () => (await pageAt(provider("/oauth/login")))?.id).toBe(login.id);
    // Past a few of the broker's one-second sign-in checks: still there, no result.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await pageAt(provider("/oauth/login")))?.id).toBe(login.id);
    expect(result(id)).toBeUndefined();
    await userClicks(provider("/oauth/login"), "#allow");
    await signedIn(id);
  });
});
