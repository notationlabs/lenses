import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "puppeteer-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canRun, startHarness, type Harness } from "./electron.js";

/**
 * What a page that renders on demand needs from the tab it is in: a feed that
 * loads more when its sentinel scrolls into view (IntersectionObserver), a
 * lazy image, and animation frames. A lens tab is in the background, never on
 * show, and the broker reads it all the same.
 */
const FEED = `<title>Feed</title>
  <div id="items"><p>first</p></div>
  <div style="height: 3000px"></div>
  <img id="lazy" loading="lazy" src="/pixel.png" width="10" height="10">
  <div id="sentinel">more</div>
  <script>
    window.frames_ = 0;
    const tick = () => { window.frames_++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting))
        document.querySelector("#items").insertAdjacentHTML("beforeend", "<p>loaded</p>");
    }).observe(document.querySelector("#sentinel"));
  </script>`;

// A 1x1 PNG.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

describe.skipIf(!canRun)("a lens page renders while out of sight", () => {
  let harness: Harness;
  let server: Server;
  let origin: string;
  let broker: Browser;
  let pixelRequests = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/pixel.png") {
        pixelRequests++;
        return res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
      }
      res.writeHead(200, { "content-type": "text/html" }).end(FEED);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.stop();
    await new Promise((resolve) => server?.close(resolve));
  });

  beforeEach(async () => {
    broker = await harness.broker();
    pixelRequests = 0;
  });

  afterEach(async () => {
    await broker.disconnect().catch(() => {});
    await harness.control("closeWindow");
    for (const page of await harness.pages()) await harness.control("close", page.id).catch(() => {});
    await expect.poll(() => harness.pages()).toEqual([]);
  });

  /** A lens page on the feed, out of sight, and its id in the app. */
  async function openFeed() {
    const before = new Set((await harness.pages()).map((entry) => entry.id));
    const page = await broker.newPage({ background: true });
    await page.goto(`${origin}/feed`);
    const id = (await harness.pages()).find((entry) => !before.has(entry.id))!.id;
    expect(await harness.pages()).toContainEqual(expect.objectContaining({ id, shown: false }));
    return Object.assign(page, { appId: id });
  }

  /** Animation frames the page ran in half a second, once it has started. */
  async function frameRate(page: Awaited<ReturnType<typeof openFeed>>) {
    const frames = () => page.evaluate(() => (window as any).frames_ as number);
    await expect.poll(frames, { timeout: 5_000 }).toBeGreaterThan(0);
    const before = await frames();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return (await frames()) - before;
  }

  it("runs animation frames", async () => {
    // Chromium takes a moment to judge a new page's visibility; near the
    // display's rate after that (60 a second would be 30).
    expect(await frameRate(await openFeed())).toBeGreaterThan(20);
  });

  it("loads more of a feed when the broker scrolls to its end", async () => {
    const page = await openFeed();
    await page.evaluate(() => document.querySelector("#sentinel")!.scrollIntoView());
    await expect.poll(() => page.$$eval("#items p", (items) => items.length), { timeout: 5_000 }).toBe(2);
  });

  it("loads a lazy image when the broker scrolls to it", async () => {
    const page = await openFeed();
    expect(pixelRequests).toBe(0);
    await page.evaluate(() => document.querySelector("#lazy")!.scrollIntoView());
    await expect.poll(() => page.$eval("#lazy", (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(1);
  });

  it("keeps rendering while another page is on show in the window", async () => {
    const other = await openFeed();
    const page = await openFeed();
    await harness.control("open", other.appId);
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: other.appId });
    // Near the display's rate: 60 a second would be 30.
    expect(await frameRate(page)).toBeGreaterThan(20);
    await page.evaluate(() => document.querySelector("#sentinel")!.scrollIntoView());
    await expect.poll(() => page.$$eval("#items p", (items) => items.length), { timeout: 5_000 }).toBe(2);
  });

  it("keeps rendering after the user has looked at it and closed the window", async () => {
    const page = await openFeed();
    await harness.control("open", page.appId);
    await expect.poll(() => harness.control("window")).toEqual({ visible: true, shown: page.appId });
    await harness.control("closeWindow");
    await expect.poll(() => harness.control("window")).toEqual({ visible: false, shown: null });
    expect(await frameRate(page)).toBeGreaterThan(20);
  });
});
