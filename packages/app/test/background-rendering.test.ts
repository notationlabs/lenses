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

describe.skipIf(!canRun)("a lens tab renders while in the background", () => {
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
    for (const page of await harness.pages()) await harness.control("close", page.id).catch(() => {});
    await expect.poll(() => harness.pages()).toEqual([]);
  });

  async function openFeed() {
    const page = await broker.newPage({ background: true });
    await page.goto(`${origin}/feed`);
    expect(await harness.pages()).toEqual([expect.objectContaining({ kind: "lens", active: false })]);
    return page;
  }

  it("runs animation frames", async () => {
    const page = await openFeed();
    // Chromium takes a moment to judge a new tab's visibility.
    const frames = () => page.evaluate(() => (window as any).frames_ as number);
    await expect.poll(frames, { timeout: 5_000 }).toBeGreaterThan(0);
    const before = await frames();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Near the display's rate: 60 a second would be 30.
    expect((await frames()) - before).toBeGreaterThan(20);
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

  it("keeps rendering under a user's tab on show, while the user's background tabs draw nothing", async () => {
    const background = await harness.control<number>("openUserTab", `${origin}/feed`);
    const page = await openFeedBehind(await harness.control<number>("openUserTab", `${origin}/feed`));
    const frames = () => page.evaluate(() => (window as any).frames_ as number);
    await expect.poll(frames, { timeout: 5_000 }).toBeGreaterThan(0);
    await page.evaluate(() => document.querySelector("#sentinel")!.scrollIntoView());
    await expect.poll(() => page.$$eval("#items p", (items) => items.length), { timeout: 5_000 }).toBe(2);
    const userFrames = () => harness.control<number>("evaluate", background, "window.frames_");
    const before = await userFrames();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Not drawn, though Chromium still reports it visible (as it did when tabs were parked).
    expect((await userFrames()) - before).toBe(0);
  });

  /** A lens tab opened while a user's tab is on show. */
  async function openFeedBehind(shown: number) {
    const page = await broker.newPage({ background: true });
    await page.goto(`${origin}/feed`);
    expect(await harness.pages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shown, kind: "user", active: true }),
      expect.objectContaining({ kind: "lens", active: false }),
    ]));
    return page;
  }
});
