// Spike: can we drive the user's running default-profile Chrome via
// Chrome 144+ auto-connect (consent-gated CDP), covering everything the
// lenses EngineIO needs?
//
// Prereq: chrome://inspect/#remote-debugging enabled in the running Chrome.
// A consent dialog will appear in Chrome on connect — click Allow.
import puppeteer from "puppeteer-core";

const step = (name) => console.log(`\n== ${name}`);
const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

step("connect via channel (waiting for consent dialog — click Allow in Chrome)");
const browser = await puppeteer.connect({ channel: "chrome" });
console.log(ts(), "connected:", await browser.version());

step("enumerate existing pages (tab reuse feasibility)");
const pages = await browser.pages();
console.log(ts(), pages.length, "pages visible");
for (const p of pages.slice(0, 10)) console.log("  -", p.url().slice(0, 90));

step("create hidden-ish tab + network intercept capture (EngineIO.getIntercepted)");
const page = await browser.newPage();
const captured = [];
page.on("response", async (res) => {
  const ct = res.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    if (body.length <= 512 * 1024)
      captured.push({ method: res.request().method(), url: res.url(), status: res.status(), preview: body.slice(0, 120) });
  } catch {} // body may be evicted; fine for spike
});
await page.goto("https://news.ycombinator.com", { waitUntil: "networkidle2", timeout: 30_000 });
console.log(ts(), "navigated;", captured.length, "JSON responses captured");
for (const c of captured.slice(0, 5)) console.log("  -", c.status, c.method, c.url.slice(0, 80));

step("dom extract via page.evaluate (EngineIO.domExtract)");
const titles = await page.evaluate(() =>
  [...document.querySelectorAll(".titleline > a")].slice(0, 3).map((a) => ({ title: a.textContent, href: a.href }))
);
console.log(ts(), JSON.stringify(titles, null, 2));

step("snapshot (EngineIO.snapshot)");
const snap = await page.evaluate(() => ({ url: location.href, title: document.title, textLen: document.body.innerText.length }));
console.log(ts(), snap);

step("reload (EngineIO.reload)");
await page.reload({ waitUntil: "domcontentloaded" });
console.log(ts(), "reloaded ok");

step("consent stickiness: disconnect and reconnect (expect a SECOND dialog)");
await page.close();
await browser.disconnect();
const browser2 = await puppeteer.connect({ channel: "chrome" });
console.log(ts(), "reconnected:", await browser2.version(), "(did Chrome prompt again?)");
await browser2.disconnect();

console.log("\nSPIKE PASSED");
