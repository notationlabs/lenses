import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import type { LensBridgeRequest, LensResult } from "@djgrant/lenses-core";
import { createCdpBackend } from "../src/cdp-host.js";
import { createBrokerOrchestrator, type BrokerFrame } from "../src/broker-orchestrator.js";

vi.mock("../src/launch-browser.js", () => ({ raiseChrome: async () => {} }));

const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome");

const PDF = Buffer.from("%PDF-1.7 pre-advice");

// A bank-like page: tabs inside a web component's shadow root, document
// links whose labels share dates across tabs, and a save that clicks a
// detached <a download> on a blob URL after fetching the document.
const PAGE = `<!doctype html><html><body>
<x-tabs></x-tabs><ul id="docs"></ul>
<script>
const docs = {
  main: [{ id: "1", label: "02 Sep 2026 - 01 Oct 2026" }],
  preadvice: [{ id: "2", label: "02 Sep 2026 - 01 Oct 2026 - Pre-advice of charges" }],
};
function show(tab) {
  const list = document.getElementById("docs");
  list.innerHTML = "";
  for (const doc of docs[tab]) {
    const item = document.createElement("li");
    const link = document.createElement("x-link");
    link.className = "doc";
    link.innerHTML = "<span>" + doc.label + "</span>";
    link.addEventListener("click", () => save(doc.id));
    item.appendChild(link);
    list.appendChild(item);
  }
}
async function save(id) {
  const body = await (await fetch("/api/docs/" + id + "/")).json();
  const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  anchor.download = "doc-" + id + ".pdf";
  anchor.click();
}
window.save = save;
customElements.define("x-tabs", class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<div role="tablist"><button data-tab="main"><span>Statements</span></button>' +
      '<button data-tab="preadvice"><span>Pre-advice of<br>interest &amp; charges</span></button></div>';
    for (const button of root.querySelectorAll("button")) {
      button.addEventListener("click", () => show(button.dataset.tab));
    }
  }
});
show("main");
</script></body></html>`;

describe.skipIf(!existsSync(chrome))("real browser file lens", () => {
  it("clicks through a shadow-root tab, saves the document, and stops the page's own download", async () => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path.startsWith("/api/docs/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: PDF.toString("base64") }));
      } else {
        res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const origin = `http://127.0.0.1:${address.port}`;
    const outDir = mkdtempSync(join(tmpdir(), "lens-out-"));
    const downloads = mkdtempSync(join(tmpdir(), "lens-downloads-"));
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
      const control = await browser.target().createCDPSession();
      await control.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      const current = browser;
      const backend = createCdpBackend(() => {}, {
        name: "test", pollForConnection: false, retryConnect: false,
        looksReady: () => true, probeLive: async () => true,
        connect: async () => current,
        connectHint: () => "test", staleHint: () => "test",
      });
      await backend.acquire();
      const orchestrator = createBrokerOrchestrator([backend]);
      const message: Extract<LensBridgeRequest, { type: "call" }> = {
        type: "call", id: "file-e2e", timeoutMs: 15_000, deadline: Date.now() + 15_000, outDir,
        params: { tab: "Pre-advice", label: "02 Sep 2026 - 01 Oct 2026 - Pre-advice of charges", id: "2" },
        spec: {
          name: "@test/bank/document-pdf", url: `${origin}/statements`, tab: "reuse",
          params: { tab: "string", label: "string", id: "string" },
          returns: { type: "file" },
          effects: { reads: [origin], writes: [] },
          perform: [
            { click: "x-tabs >>> button", text: "{params.tab}" },
            { wait: { appears: ".doc", text: "{params.label}", timeoutMs: 5000 } },
            { click: ".doc", text: "{params.label}" },
          ],
          resolve: [{
            kind: "intercept",
            request: { method: "GET", url: `${origin}/api/docs/{params.id}/` },
            waitMs: 5000,
            map: {
              content: "$res.body.content",
              encoding: "'base64'",
              mimeType: "'application/pdf'",
              name: "'doc-' & $params.id & '.pdf'",
            },
          }],
        },
      };
      let result: LensResult | undefined;
      await orchestrator.handle(message, (frame: BrokerFrame) => {
        if (frame.type === "result") result = frame.result;
      });
      expect(result).toMatchObject({ kind: "value", value: { name: "doc-2.pdf", bytes: PDF.length } });
      expect(readFileSync(join(outDir, "doc-2.pdf"))).toEqual(PDF);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(readdirSync(downloads)).toEqual([]);

      // The guard lifts a few seconds after the call: the same save then downloads.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const [page] = (await browser.pages()).filter((candidate) => candidate.url().startsWith(origin));
      await page.evaluate(() => (window as unknown as { save(id: string): Promise<void> }).save("2"));
      const deadline = Date.now() + 5000;
      while (!readdirSync(downloads).includes("doc-2.pdf") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(readdirSync(downloads)).toContain("doc-2.pdf");
    } finally {
      await browser?.close();
      server.close();
    }
  }, 40_000);
});
