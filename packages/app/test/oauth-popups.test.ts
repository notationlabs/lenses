import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canRun, startHarness, type Harness } from "./electron.js";

/**
 * A site that signs in with a provider in a popup, the usual OAuth shape:
 * the popup goes to the provider, is redirected to its login page, and on
 * approval comes back to the site's callback, which posts the code to
 * window.opener and closes itself. The site is served as 127.0.0.1 and the
 * provider as localhost, so the two are different origins.
 */
function oauthServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    const provider = url.hostname === "localhost";
    if (provider) {
      switch (url.pathname) {
        case "/authorize":
          // Redirected before the broker can have attached to the popup.
          return res.writeHead(302, { location: `/login${url.search}` }).end();
        case "/login":
          return html(`<title>Provider</title>
            <form action="/approve">
              <input type="hidden" name="redirect_uri" value="${url.searchParams.get("redirect_uri")}">
              <input type="hidden" name="state" value="${url.searchParams.get("state")}">
              <button id="allow">Allow</button>
            </form>`);
        case "/approve": {
          const back = new URL(url.searchParams.get("redirect_uri")!);
          back.searchParams.set("code", "c123");
          back.searchParams.set("state", url.searchParams.get("state")!);
          return res.writeHead(302, { location: back.href }).end();
        }
      }
    } else {
      switch (url.pathname) {
        case "/":
          return html(`<title>Site</title>
            <button id="signin">Sign in with Provider</button>
            <button id="blank">Sign in with Provider (blank first)</button>
            <a id="docs" href="/docs" target="_blank">Docs</a>
            <script>
              const provider = location.href.replace("127.0.0.1", "localhost");
              const callback = location.origin + "/callback";
              document.querySelector("#signin").onclick = () => window.open(
                new URL("/authorize?state=s1&redirect_uri=" + encodeURIComponent(callback), provider),
                "oauth", "popup,width=480,height=640");
              document.querySelector("#blank").onclick = () => {
                const popup = window.open("", "oauth", "popup,width=480,height=640");
                setTimeout(() => {
                  popup.location.href = new URL("/authorize?state=s1&redirect_uri=" + encodeURIComponent(callback), provider);
                }, 100);
              };
              addEventListener("message", (event) => {
                if (event.origin === location.origin && event.data?.type === "oauth")
                  location.href = "/signed-in?code=" + event.data.code;
              });
            </script>`);
        case "/callback":
          return html(`<title>Callback</title><script>
            if (window.opener) {
              window.opener.postMessage({ type: "oauth", code: new URLSearchParams(location.search).get("code") }, location.origin);
              window.close();
            } else document.title = "No opener";
          </script>`);
        case "/signed-in":
          return html(`<title>Signed in</title><h1>Signed in</h1>`);
        case "/docs":
          return html(`<title>Docs</title>`);
      }
    }
    res.writeHead(404).end();
  });
}

describe.skipIf(!canRun)("OAuth popups", () => {
  let harness: Harness;
  let server: Server;
  let site: (path: string) => string;
  let provider: (path: string) => string;
  let broker: Browser;

  beforeAll(async () => {
    server = oauthServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    site = (path) => `http://127.0.0.1:${port}${path}`;
    provider = (path) => `http://localhost:${port}${path}`;
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.stop();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    broker = await harness.broker();
    await harness.control("forward");
  });

  afterEach(async () => {
    await broker.disconnect().catch(() => {});
    await harness.control("closeWindow");
    for (const page of await harness.pages()) await harness.control("close", page.id).catch(() => {});
    await expect.poll(() => harness.pages()).toEqual([]);
  });

  /**
   * Click as the broker does, with element.click() in the page. Puppeteer's
   * page.click waits for the element to be painted, and a background tab
   * draws nothing.
   */
  const click = (page: Page, selector: string) => page.$eval(selector, (element) => (element as HTMLElement).click());

  /** A lens tab on the site, as the broker opens one, and the popup its sign-in button opens. */
  async function openSignIn(): Promise<{ page: Page; popup: Page }> {
    const page = await broker.newPage({ background: true });
    await page.goto(site("/"));
    const popup = new Promise<Page | null>((resolve) => page.once("popup", resolve));
    await click(page, "#signin");
    const opened = await popup;
    if (!opened) throw new Error("no popup page");
    await opened.waitForSelector("#allow");
    return { page, popup: opened };
  }

  const pageAt = async (prefix: string) => (await harness.pages()).find((page) => page.url.startsWith(prefix));

  it("a lens page's sign-in popup reaches the broker as a page opened by it, out of sight", async () => {
    const { page, popup } = await openSignIn();
    expect(popup.url()).toMatch(provider("/login?"));
    expect(popup.target().opener()).toBe(page.target());
    // The broker opened it: it stays out of sight, like any lens page.
    expect(await pageAt(provider("/login"))).toMatchObject({ popup: true, exposed: true, shown: false });
    expect(await harness.control("forward")).toEqual([]);
  });

  it("the broker can finish the sign-in: the popup posts the code to its opener and closes", async () => {
    const { page, popup } = await openSignIn();
    const closed = new Promise((resolve) => popup.once("close", resolve));
    await click(popup, "#allow");
    await closed;
    await page.waitForFunction(() => location.pathname === "/signed-in");
    expect(page.url()).toBe(site("/signed-in?code=c123"));
    expect(await pageAt(provider("/"))).toBeUndefined();
    expect(await pageAt(site("/callback"))).toBeUndefined();
  });

  it("the user can finish the sign-in while the broker watches", async () => {
    const { page, popup } = await openSignIn();
    const closed = new Promise((resolve) => popup.once("close", resolve));
    const login = await pageAt(provider("/login"));
    await harness.control("evaluate", login!.id, `document.querySelector("#allow").click()`);
    await closed;
    await page.waitForFunction(() => location.pathname === "/signed-in");
    expect(page.url()).toBe(site("/signed-in?code=c123"));
  });

  it("a broker that reconnects mid sign-in finds the popup still open", async () => {
    await openSignIn();
    await broker.disconnect();
    broker = await harness.broker();
    const urls = async () => (await broker.pages()).map((page) => page.url());
    await expect.poll(urls).toEqual(expect.arrayContaining([site("/"), expect.stringMatching(provider("/login?"))]));
    const popup = (await broker.pages()).find((page) => page.url().startsWith(provider("/login")))!;
    const page = (await broker.pages()).find((page) => page.url() === site("/"))!;
    await click(popup, "#allow");
    await page.waitForFunction(() => location.pathname === "/signed-in");
  });

  it("a popup the user opens from a page on show comes forward", async () => {
    const page = await broker.newPage({ background: true });
    await page.goto(site("/"));
    const lens = (await pageAt(site("/")))!;
    await harness.control("open", lens.id);
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: lens.id });
    // The user clicks the sign-in button in the page they are looking at.
    await harness.control("evaluate", lens.id, `document.querySelector("#signin").click()`);
    await expect.poll(() => pageAt(provider("/login"))).toMatchObject({ popup: true, exposed: true, shown: true });
  });

  it("a link from a lens page to a new tab opens a lens page the broker can drive", async () => {
    const page = await broker.newPage({ background: true });
    await page.goto(site("/"));
    const docs = broker.waitForTarget((target) => target.url() === site("/docs"));
    await click(page, "#docs");
    const tab = await (await docs).page();
    expect(await tab!.title()).toBe("Docs");
    expect(await pageAt(site("/docs"))).toMatchObject({ popup: false, exposed: true, shown: false });
  });

  it("a popup opened blank reaches the broker, and its URL follows it to the provider", async () => {
    const page = await broker.newPage({ background: true });
    await page.goto(site("/"));
    const popup = new Promise<Page | null>((resolve) => page.once("popup", resolve));
    await click(page, "#blank");
    const opened = (await popup)!;
    await opened.waitForSelector("#allow");
    await expect.poll(() => opened.target().url()).toMatch(provider("/login?"));
    const closed = new Promise((resolve) => opened.once("close", resolve));
    await click(opened, "#allow");
    await closed;
    await page.waitForFunction(() => location.pathname === "/signed-in");
  });
});
