import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canRun, startHarness, type Harness } from "./electron.js";

/** The window's header, as the user sees it, for the page on show. */
const HEADER = `(() => {
  const $ = (selector) => document.querySelector(selector);
  return { address: $("#address").value, back: !$("#back").disabled, forward: !$("#forward").disabled };
})()`;

/** The user types in the address bar and presses a key. */
const type = (text: string, key = "Enter") => `(() => {
  const address = document.querySelector("#address");
  address.focus();
  address.value = ${JSON.stringify(text)};
  address.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)} }));
})()`;

const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click()`;

describe.skipIf(!canRun)("the address bar and back and forward", () => {
  let harness: Harness;
  let server: Server;
  let origin: string;
  let host: string;
  let broker: Browser;
  let id: number;

  const header = () => harness.control<{ address: string; back: boolean; forward: boolean }>("windowEvaluate", HEADER);
  const pageUrl = async () => (await harness.pages()).find((entry) => entry.id === id)?.url;

  beforeAll(async () => {
    server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>${req.url}</title>${req.url}`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    origin = `http://${host}`;
    harness = await startHarness();
    broker = await harness.broker();
    const page = await broker.newPage({ background: true });
    await page.goto(`${origin}/first`);
    id = (await harness.pages()).find((entry) => entry.url === `${origin}/first`)!.id;
    await harness.control("open", id);
  });

  afterAll(async () => {
    await broker?.disconnect().catch(() => {});
    await harness?.stop();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("shows the page's address", async () => {
    // Back to the blank page the broker opened it on.
    await expect.poll(header).toEqual({ address: `${origin}/first`, back: true, forward: false });
  });

  it("goes where the user types, a bare host included", async () => {
    await harness.control("windowEvaluate", type(`${host}/second`));
    await expect.poll(pageUrl).toBe(`${origin}/second`);
    await expect.poll(header).toEqual({ address: `${origin}/second`, back: true, forward: false });
  });

  it("goes back and forward", async () => {
    await harness.control("windowEvaluate", click("#back"));
    await expect.poll(pageUrl).toBe(`${origin}/first`);
    await expect.poll(header).toEqual({ address: `${origin}/first`, back: true, forward: true });
    await harness.control("windowEvaluate", click("#forward"));
    await expect.poll(pageUrl).toBe(`${origin}/second`);
    await expect.poll(header).toEqual({ address: `${origin}/second`, back: true, forward: false });
  });

  it("will not run script typed as an address", async () => {
    await harness.control("windowEvaluate", type("javascript:document.title='typed'"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await pageUrl()).toBe(`${origin}/second`);
    expect(await harness.control("evaluate", id, "document.title")).toBe("/second");
  });

  it("puts the address back when the user presses Escape", async () => {
    await harness.control("windowEvaluate", type("somewhere else", "Escape"));
    await expect.poll(header).toEqual({ address: `${origin}/second`, back: true, forward: false });
    expect(await pageUrl()).toBe(`${origin}/second`);
    if (process.env.HARNESS_CAPTURE) await harness.control("capture", "window", process.env.HARNESS_CAPTURE);
  });

  it("is there with no page on show, and opens a new page where the user types", async () => {
    await harness.control("closeWindow");
    await harness.control("open");
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: null });
    expect(await harness.control("windowEvaluate", `getComputedStyle(document.querySelector("#address")).display`)).not.toBe("none");
    await expect.poll(header).toEqual({ address: "", back: false, forward: false });

    await harness.control("windowEvaluate", type(`${origin}/typed`));
    await expect.poll(async () => (await harness.pages()).find((entry) => entry.url === `${origin}/typed`)).toMatchObject({ shown: true });
    await expect.poll(header).toMatchObject({ address: `${origin}/typed` });
    expect((await harness.pages()).find((entry) => entry.id === id)).toMatchObject({ url: `${origin}/second`, shown: false });
  });
});
