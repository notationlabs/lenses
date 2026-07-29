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
  /**
   * `innerText` is what `pageSnapshot` reports and what the page renders, so a
   * `<br>` reads as a line break rather than vanishing. It is undefined outside
   * HTML elements (SVG, MathML), hence the `textContent` fallback.
   *
   * Runs of horizontal whitespace collapse to one space: that covers the
   * &nbsp; content-managed markup is dense with, so lenses need no `$norm`
   * helper of their own. Line breaks survive — `innerText` renders `<br>` as
   * `\n` and paragraph gaps as `\n\n` — with blank-line runs capped at one.
   * The `textContent` fallback collapses fully: its newlines are source-markup
   * formatting, not rendered breaks. An element that is present but blank
   * stays "" — only a missed selector yields null.
   */
  function readText(el: Element): string {
    const rendered = (el as HTMLElement).innerText;
    if (typeof rendered !== "string") {
      return (el.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    return rendered
      .replace(/[^\S\n]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Where this field's selector is run from. A row often loses context that
   * lives on an enclosing element — a tax year on the tab panel wrapping the
   * table — which no descendant selector can reach, so `scope` moves the root
   * first: "+" (or "+ sel") crosses to the next sibling, anything else is an
   * ancestor selector resolved with closest(). `sibling: true` is the older
   * spelling of "+".
   */
  function fieldRoot(root: Element, f: DomFieldSpec): Element | null {
    const scope = f.scope ?? (f.sibling ? "+" : undefined);
    if (!scope) return root;
    if (scope === "+" || scope.startsWith("+ ")) {
      const next = root.nextElementSibling;
      const want = scope.slice(1).trim();
      return next && (want === "" || next.matches(want)) ? next : null;
    }
    return root.closest(scope);
  }

  function extractField(root: Element, f: DomFieldSpec): string | null {
    const scope = fieldRoot(root, f);
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
    return readText(el);
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
