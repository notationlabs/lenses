import type { Page } from "puppeteer-core";

/**
 * Render a banner without exposing broker callbacks to the page; its only
 * control, a close button, acts on the page alone. `key` names the banner element; one key per tab means a banner left
 * behind (its removal can fail while the debugger is detached) is updated in
 * place rather than duplicated.
 */
export async function showAuthBanner(
  page: Page,
  site: string,
  key = `__lens_auth_${Math.random().toString(36).slice(2)}`
): Promise<{ update(expiresAt: number, count: number): void; dispose(): void }> {
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

/** Remove every Lenses sign-in banner from the page, including ones a detached debugger left behind. */
export async function clearAuthBanners(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("[data-lenses-auth]")) node.remove();
  }).catch(() => {});
}

function paintAuthBanner({ key, site, expiresAt, count }: {
  key: string; site: string; expiresAt: number; count: number;
}): void {
  type BannerHost = HTMLDivElement & { updateAuth?: (deadline: number, waiting: number) => void };
  const mount = () => {
    for (const node of document.querySelectorAll("[data-lenses-auth]")) if (node.id !== key) node.remove();
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
    sheet.replaceSync(":host { display: block; position: relative; z-index: 2147483647; width: 100%; box-sizing: border-box; color: #fff; font: 14px system-ui; } section { display: flex; align-items: center; gap: 16px; padding: 14px 24px; background: #000; border-bottom: 3px solid #fff; box-shadow: 0 4px 24px #0008; } strong { color: #fff; letter-spacing: .04em; } span { flex: 1; } time { width: 8ch; flex: none; text-align: right; font-variant-numeric: tabular-nums; } button { flex: none; margin: 0; padding: 0 4px; border: 0; background: none; color: inherit; font: 20px/1 system-ui; cursor: pointer; opacity: .7; } button:hover { opacity: 1; } ");
    shadow.adoptedStyleSheets = [sheet];
    const box = document.createElement("section");
    box.setAttribute("role", "status");
    const brand = document.createElement("strong");
    brand.textContent = "Lenses";
    const label = document.createElement("span");
    const timer = document.createElement("time");
    // Lenses cannot remove a banner from a tab taken out of the group, so
    // the user can. Closing it only hides it; the wait is unaffected.
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => host.remove());
    box.append(brand, label, timer, close);
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
