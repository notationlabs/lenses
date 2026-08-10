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

/**
 * Fill an editor with literal text. Contenteditable editors (ProseMirror
 * etc.) ignore property writes, so text goes in via focus → select-all →
 * `insertText`. For `<input>`/`<textarea>` the native setter is used and an
 * InputEvent dispatched, which React requires.
 *
 * The selector must match exactly one element.
 */
export function pagePerformFill(spec: { selector: string; value: string }):
  | { ok: true }
  | { ok: false; message: string } {
  const matches = document.querySelectorAll(spec.selector);
  if (matches.length !== 1) {
    return {
      ok: false,
      message: `fill "${spec.selector}" matched ${matches.length} elements, need exactly 1`,
    };
  }
  const el = matches[0] as HTMLElement;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, spec.value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: spec.value, inputType: "insertText" }));
    return { ok: true };
  }
  document.execCommand("selectAll", false);
  if (!document.execCommand("insertText", false, spec.value)) {
    return { ok: false, message: `fill "${spec.selector}" could not insert text` };
  }
  return { ok: true };
}

/**
 * Click the first visible match. Pages often render hidden duplicates of a
 * control, so hidden elements are skipped (offsetParent/client-rect check).
 * A disabled or aria-disabled target is an error: the page is not ready.
 */
export function pagePerformClick(spec: { selector: string }):
  | { ok: true }
  | { ok: false; message: string } {
  const matches = [...document.querySelectorAll(spec.selector)];
  if (matches.length === 0) {
    return { ok: false, message: `click "${spec.selector}" matched nothing` };
  }
  const visible = matches.find(
    (el) => (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0
  );
  if (!visible) {
    return { ok: false, message: `click "${spec.selector}" matched no visible element` };
  }
  if (
    (visible as HTMLButtonElement).disabled === true ||
    visible.getAttribute("aria-disabled") === "true"
  ) {
    return { ok: false, message: `click "${spec.selector}" target is disabled` };
  }
  (visible as HTMLElement).click();
  return { ok: true };
}

/**
 * Dispatch keydown/keyup for a named key ("Enter", "Meta+Enter") to the
 * focused element. Synthetic events are untrusted, so trust-checking handlers
 * and native form submits will not fire — click the submit control instead.
 */
export function pagePerformPress(spec: { key: string }):
  | { ok: true }
  | { ok: false; message: string } {
  const parts = spec.key.split("+");
  const key = parts[parts.length - 1];
  if (!key) return { ok: false, message: `press "${spec.key}" names no key` };
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    metaKey: modifiers.includes("meta") || modifiers.includes("cmd"),
    ctrlKey: modifiers.includes("ctrl") || modifiers.includes("control"),
    altKey: modifiers.includes("alt"),
    shiftKey: modifiers.includes("shift"),
  };
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { ok: true };
}

/**
 * Match count for the wait forms. Hosts poll this for all three: `appears` is
 * count ≥ 1, `gone` is count = 0, `increases` is count > the baseline the
 * host sampled at step entry. One probe keeps the wait semantics in the host,
 * where the timeout and poll interval already live.
 */
export function pagePerformCount(spec: { selector: string }): number {
  return document.querySelectorAll(spec.selector).length;
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
