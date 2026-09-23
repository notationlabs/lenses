import type { Page } from "puppeteer-core";

/** The page is untrusted: the callback carries no credentials or page data. */
export async function showAuthBanner(
  page: Page,
  site: string,
  onCancel: () => void
): Promise<{ update(expiresAt: number, count: number): void; dispose(): void }> {
  const key = `__lens_auth_${Math.random().toString(36).slice(2)}`;
  await page.exposeFunction(key, onCancel);
  let script: string | undefined;
  let disposed = false;
  let generation = 0;
  let pending = Promise.resolve();
  const update = (expiresAt: number, count: number) => {
    if (disposed) return;
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
        if (node instanceof HTMLElement) {
          try { node.hidePopover(); } catch { /* navigation or closed popover */ }
          node.remove();
        }
      }, key).catch(() => {});
      void page.removeExposedFunction(key).catch(() => {});
    },
  };
}

function paintAuthBanner({ key, site, expiresAt, count }: {
  key: string; site: string; expiresAt: number; count: number;
}): void {
  const mount = () => {
    document.getElementById(key)?.remove();
    const host = document.createElement("div");
    host.id = key;
    host.setAttribute("popover", "manual");
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host { position: fixed; inset: auto 16px 16px auto; margin: 0; border: 0; padding: 0; background: transparent; color: #fff; font: 14px system-ui; } section { max-width: 320px; padding: 12px 16px; border-radius: 9px; background: #20232a; box-shadow: 0 4px 24px #0008; } button { margin-left: 12px; cursor: pointer; } ");
    shadow.adoptedStyleSheets = [sheet];
    const box = document.createElement("section");
    const label = document.createElement("span");
    const button = document.createElement("button");
    button.textContent = "Cancel";
    button.addEventListener("click", () => { void (window as unknown as Record<string, () => Promise<void>>)[key]?.(); });
    box.append(label, button);
    shadow.replaceChildren(box);
    try { (host as HTMLElement).showPopover(); } catch { /* document not active */ }
    const tick = () => {
      if (!host?.isConnected) return;
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      label.textContent = `Sign in to ${site} to continue${count > 1 ? ` (${count} requests waiting)` : ""} — ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      if (seconds > 0) setTimeout(tick, 1000);
    };
    tick();
  };
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}
