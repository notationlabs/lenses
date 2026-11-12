import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canRun, startHarness, type Harness } from "./electron.js";

function siteServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    switch (url.pathname) {
      case "/":
        return html(`<title>Site</title>
          <form id="post" action="/echo" method="post" target="_blank">
            <input name="q" value="v1">
          </form>
          <form id="multipart" action="/echo" method="post" enctype="multipart/form-data" target="_blank">
            <input name="q" value="v2">
          </form>
          <a id="data" href="data:text/html,<title>Data</title>" target="_blank">Data</a>`);
      case "/echo": {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const parsed = new URLSearchParams(body).get("q") ?? /name="q"\r\n\r\n(.*)\r\n/.exec(body)?.[1];
          html(`<title>${req.method} ${parsed}</title>`);
        });
        return;
      }
    }
    res.writeHead(404).end();
  });
}

describe.skipIf(!canRun)("what a lens page may open and use", () => {
  let harness: Harness;
  let server: Server;
  let site: (path: string) => string;
  let broker: Browser;

  beforeAll(async () => {
    server = siteServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    site = (path) => `http://127.0.0.1:${port}${path}`;
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.stop();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    broker = await harness.broker();
  });

  afterEach(async () => {
    await broker.disconnect().catch(() => {});
    for (const page of await harness.pages()) await harness.control("close", page.id).catch(() => {});
    await expect.poll(() => harness.pages()).toEqual([]);
  });

  const click = (page: Page, selector: string) => page.$eval(selector, (element) => (element as HTMLElement).click());

  async function openSite(): Promise<Page> {
    const page = await broker.newPage({ background: true });
    await page.goto(site("/"));
    return page;
  }

  it.each([
    ["#post", "POST v1"],
    ["#multipart", "POST v2"],
  ])("a form (%s) posted to a new tab keeps its method and body", async (selector, title) => {
    const page = await openSite();
    await page.$eval(selector, (form) => (form as HTMLFormElement).submit());
    await expect.poll(async () => (await broker.pages()).map((tab) => tab.url())).toContain(site("/echo"));
    const echo = (await broker.pages()).find((tab) => tab.url() === site("/echo"))!;
    await expect.poll(() => echo.title()).toBe(title);
  });

  it("a page cannot read the clipboard, but can write to it", async () => {
    const page = await openSite();
    const state = (name: string) =>
      page.evaluate((name) => navigator.permissions.query({ name: name as PermissionName }).then((status) => status.state), name);
    expect(await state("clipboard-read")).toBe("denied");
    expect(await state("clipboard-write")).toBe("granted");
  });

  it("a new window to a non-web scheme is denied and nothing loads it", async () => {
    const page = await openSite();
    // Chromium itself blocks a renderer's navigation to data:, but not one loadURL makes.
    await click(page, "#data").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const urls = (await harness.pages()).map((tab) => tab.url);
    expect(urls).toEqual([site("/")]);
  });
});
