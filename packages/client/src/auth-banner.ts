import type { Page } from "puppeteer-core";

/** Render a non-interactive banner without exposing broker callbacks to the page. */
export async function showAuthBanner(
  page: Page,
  site: string
): Promise<{ update(expiresAt: number, count: number): void; dispose(): void }> {
  const key = `__lens_auth_${Math.random().toString(36).slice(2)}`;
  let script: string | undefined;
  let disposed = false;
  let generation = 0;
  let last: string | undefined;
  let pending = Promise.resolve();
  const update = (expiresAt: number, count: number) => {
    if (disposed) return;
    const state = `${expiresAt}:${count}`;
    if (state === last) return;
    last = state;
    const current = ++generation;
    pending = pending.then(async () => {
      if (disposed || current !== generation) return;
      if (script) await page.removeScriptToEvaluateOnNewDocument(script).catch(() => {});
      if (disposed || current !== generation) return;
      script = (await page.evaluateOnNewDocument(paintAuthBanner, { key, site, expiresAt, count })).identifier;
      if (disposed || current !== generation) return;
      await page.evaluate(paintAuthBanner, { key, site, expiresAt, count }).catch(() => {});
    }).catch(() => {});
  };
  return {
    update,
    dispose() {
      disposed = true;
      generation++;
      void pending.then(async () => {
        if (script) await page.removeScriptToEvaluateOnNewDocument(script).catch(() => {});
      });
      void page.evaluate((id) => {
        const node = document.getElementById(id);
        node?.remove();
      }, key).catch(() => {});
    },
  };
}

function paintAuthBanner({ key, site, expiresAt, count }: {
  key: string; site: string; expiresAt: number; count: number;
}): void {
  type BannerHost = HTMLDivElement & { updateAuth?: (deadline: number, waiting: number) => void };
  const mount = () => {
    const existing = document.getElementById(key) as BannerHost | null;
    if (existing?.updateAuth) {
      existing.updateAuth(expiresAt, count);
      return;
    }
    existing?.remove();
    const host: BannerHost = document.createElement("div");
    host.id = key;
    host.setAttribute("data-lenses-auth", "");
    document.body.prepend(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host { display: block; position: relative; z-index: 2147483647; width: 100%; box-sizing: border-box; color: #fff; font: 14px system-ui; } section { display: flex; align-items: center; gap: 16px; padding: 14px 24px; background: #000; border-bottom: 3px solid #fff; box-shadow: 0 4px 24px #0008; } strong { color: #fff; letter-spacing: .04em; } span { flex: 1; } time { width: 8ch; flex: none; text-align: right; font-variant-numeric: tabular-nums; } ");
    shadow.adoptedStyleSheets = [sheet];
    const box = document.createElement("section");
    box.setAttribute("role", "status");
    const brand = document.createElement("strong");
    brand.textContent = "Lenses";
    const label = document.createElement("span");
    const timer = document.createElement("time");
    box.append(brand, label, timer);
    shadow.replaceChildren(box);
    let deadline = expiresAt;
    let waiting = count;
    let ticking = false;
    const tick = () => {
      if (!host.isConnected) { ticking = false; return; }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      label.textContent = `Sign in to ${site} to continue${waiting > 1 ? ` (${waiting} requests waiting)` : ""}`;
      timer.textContent = `(${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`;
      if (seconds > 0) setTimeout(tick, 1000);
      else ticking = false;
    };
    host.updateAuth = (nextDeadline, nextCount) => {
      deadline = nextDeadline;
      waiting = nextCount;
      if (!ticking) ticking = true;
      else {
        // Refresh the label now; the existing timer continues the countdown.
        label.textContent = `Sign in to ${site} to continue${waiting > 1 ? ` (${waiting} requests waiting)` : ""}`;
        return;
      }
      tick();
    };
    host.updateAuth(expiresAt, count);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
