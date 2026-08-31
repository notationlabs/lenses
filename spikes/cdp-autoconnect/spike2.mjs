// Spike 2: JSON response capture on an API-driven page, including requests
// fired before page scripts run.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ channel: "chrome" });
const page = await browser.newPage();
const captured = [];
page.on("response", async (res) => {
  const ct = res.headers()["content-type"] ?? "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    captured.push({ status: res.status(), method: res.request().method(), url: res.url(), len: body.length, preview: body.slice(0, 100) });
  } catch (e) {
    captured.push({ status: res.status(), url: res.url(), bodyError: String(e).slice(0, 60) });
  }
});
await page.goto("https://github.com/trending", { waitUntil: "networkidle2", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2000));
console.log(captured.length, "JSON responses:");
for (const c of captured) console.log(" -", c.status, c.method ?? "", c.url.slice(0, 90), c.bodyError ?? `${c.len}B ${c.preview.slice(0, 60)}`);
await page.close();
await browser.disconnect();
console.log("DONE");
