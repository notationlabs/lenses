/**
 * Functions executed inside the target page, via CDP `Runtime.evaluate` or a
 * content script. Each exported function must remain fully self-contained —
 * hosts serialize the single function's source, so it cannot reference
 * imports, module state, or sibling functions.
 */
import type { DomFieldSpec, DomResolver } from "./types.js";

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  html?: string;
}

export function pageDomExtract(spec: Pick<DomResolver, "item" | "fields">): {
  url: string;
  title: string;
  value: unknown;
} {
  function extractField(root: Element, f: DomFieldSpec): string | null {
    const scope = f.sibling ? root.nextElementSibling : root;
    if (!scope) return null;
    const el = f.selector === ":self" ? scope : scope.querySelector(f.selector);
    if (!el) return null;
    if (f.attr) {
      const v = el.getAttribute(f.attr);
      if (v && (f.attr === "href" || f.attr === "src")) {
        try {
          return new URL(v, location.href).href;
        } catch {
          return v;
        }
      }
      return v;
    }
    return (el.textContent ?? "").trim();
  }

  let value: unknown = null;
  if (spec.item && spec.fields) {
    const items: Record<string, string | null>[] = [];
    for (const el of document.querySelectorAll(spec.item)) {
      const row: Record<string, string | null> = {};
      for (const [name, f] of Object.entries(spec.fields)) row[name] = extractField(el, f);
      items.push(row);
    }
    value = items;
  } else if (spec.fields) {
    const row: Record<string, string | null> = {};
    for (const [name, f] of Object.entries(spec.fields)) row[name] = extractField(document.documentElement, f);
    value = row;
  }

  return { url: location.href, title: document.title, value };
}

export function pageSnapshot(opts: { maxChars?: number; html?: boolean; maxHtmlChars?: number }): PageSnapshot {
  /** Body markup for selector authoring: no scripts, styles, or comments. */
  function pageHtml(maxChars: number): string {
    const root = (document.body ?? document.documentElement).cloneNode(true) as Element;
    for (const el of root.querySelectorAll("script, style, noscript, template")) el.remove();
    return root.outerHTML.replace(/<!--[\s\S]*?-->/g, "").slice(0, maxChars);
  }

  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, opts.maxChars ?? 20000),
    ...(opts.html ? { html: pageHtml(opts.maxHtmlChars ?? 80000) } : {}),
  };
}
