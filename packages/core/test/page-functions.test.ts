import { afterEach, describe, expect, it } from "vitest";
import { pageDomExtract, pagePerformSubmit } from "../src/page-functions.js";

/**
 * A shim rather than a DOM: it fixes what `innerText` returns instead of
 * deriving it from layout, so these cover which property is preferred and the
 * whitespace handling, not the browser's own rendering rules.
 */
interface FakeElement {
  innerText?: unknown;
  textContent?: string | null;
}

function element(el: FakeElement, children: Record<string, FakeElement> = {}) {
  return {
    innerText: el.innerText,
    textContent: el.textContent ?? null,
    getAttribute: () => null,
    querySelector: (selector: string) =>
      selector in children ? element(children[selector]) : null,
    nextElementSibling: null,
  };
}

/** Extract one field named "f", selected as ".f", from a page holding `el`. */
function extractOne(el: FakeElement | null): string | null {
  (globalThis as Record<string, unknown>).document = {
    documentElement: element({}, el ? { ".f": el } : {}),
    title: "Test",
    querySelectorAll: () => [],
  };
  (globalThis as Record<string, unknown>).location = { href: "https://example.com/" };

  const { value } = pageDomExtract({ fields: { f: { selector: ".f" } } });
  return (value as Record<string, string | null>).f;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).location;
  for (const name of [
    "HTMLFormElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "Element",
    "InputEvent",
  ]) delete (globalThis as Record<string, unknown>)[name];
});

/**
 * A row and the ancestor holding the context it lacks: `.panel` wraps the rows
 * and carries the year, which no descendant selector on a row can reach.
 */
function panelPage(rows: { own: string; next?: string }[], panelYear: string) {
  const child = (text: string) => ({
    innerText: text,
    textContent: text,
    getAttribute: () => null,
    querySelector: () => null,
    nextElementSibling: null,
  });
  const panel = {
    innerText: "",
    textContent: "",
    getAttribute: () => null,
    querySelector: (s: string) => (s === ".year" ? child(panelYear) : null),
    matches: (s: string) => s === ".panel",
    nextElementSibling: null,
  };
  const element = (own: string, next?: string): unknown => ({
    innerText: own,
    textContent: own,
    getAttribute: () => null,
    querySelector: (s: string) => (s === ".own" ? child(own) : null),
    matches: (s: string) => s === ".row",
    closest: (s: string) => (s === ".panel" ? panel : null),
    nextElementSibling:
      next === undefined
        ? null
        : {
            innerText: next,
            textContent: next,
            getAttribute: () => null,
            querySelector: (s: string) => (s === ".next" ? child(next) : null),
            matches: (s: string) => s === ".sub",
            closest: () => panel,
            nextElementSibling: null,
          },
  });

  (globalThis as Record<string, unknown>).document = {
    documentElement: {},
    title: "Test",
    querySelectorAll: () => rows.map((r) => element(r.own, r.next)),
  };
  (globalThis as Record<string, unknown>).location = { href: "https://example.com/" };
}

describe("pagePerformSubmit", () => {
  it("uses native requestSubmit so validation and submit events are preserved", () => {
    let submissions = 0;
    class FakeForm {
      requestSubmit() { submissions += 1; }
    }
    const form = new FakeForm();
    (globalThis as Record<string, unknown>).HTMLFormElement = FakeForm;
    (globalThis as Record<string, unknown>).document = {
      querySelectorAll: () => [form],
    };

    expect(pagePerformSubmit({ selector: "#checkout" })).toEqual({ ok: true });
    expect(submissions).toBe(1);
  });

  it("populates native controls, adds missing hidden fields, then submits", () => {
    const events: string[] = [];
    class FakeElement {
      dispatchEvent(event: Event) { events.push(event.type); return true; }
    }
    class FakeInput extends FakeElement {
      type = "text";
      name = "";
      private currentValue = "";
      private currentChecked = false;
      get value() { return this.currentValue; }
      set value(value: string) { this.currentValue = value; }
      get checked() { return this.currentChecked; }
      set checked(value: boolean) { this.currentChecked = value; }
    }
    class FakeTextArea extends FakeElement {
      private currentValue = "";
      get value() { return this.currentValue; }
      set value(value: string) { this.currentValue = value; }
    }
    class FakeSelect extends FakeTextArea {}
    const description = new FakeInput();
    const appended: FakeInput[] = [];
    let submittedValue: string | undefined;
    class FakeForm extends FakeElement {
      elements = {
        namedItem: (name: string) => name === "journal_set[description]" ? description : null,
      };
      appendChild(input: FakeInput) { appended.push(input); }
      requestSubmit() { submittedValue = description.value; }
    }
    const form = new FakeForm();
    Object.assign(globalThis, {
      Element: FakeElement,
      HTMLFormElement: FakeForm,
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: FakeTextArea,
      HTMLSelectElement: FakeSelect,
      InputEvent: class extends Event {},
      document: {
        querySelectorAll: () => [form],
        createElement: () => new FakeInput(),
      },
    });

    expect(pagePerformSubmit({
      selector: "#journal_set",
      form: {
        "journal_set[description]": "published",
        "journal_set[token]": "secret",
      },
    })).toEqual({ ok: true });
    expect(submittedValue).toBe("published");
    expect(events).toEqual(["input", "change"]);
    expect(appended).toMatchObject([
      { type: "hidden", name: "journal_set[token]", value: "secret" },
    ]);
  });

  it("rejects a non-form target", () => {
    class FakeForm {}
    (globalThis as Record<string, unknown>).HTMLFormElement = FakeForm;
    (globalThis as Record<string, unknown>).document = {
      querySelectorAll: () => [{}],
    };

    expect(pagePerformSubmit({ selector: "#checkout" })).toEqual({
      ok: false,
      message: 'submit "#checkout" target is not a form',
    });
  });
});

describe("pageDomExtract field scope", () => {
  it("reaches an ancestor a descendant selector cannot", () => {
    panelPage([{ own: "a" }, { own: "b" }], "2024");
    const { value } = pageDomExtract({
      item: ".row",
      fields: { own: { selector: ".own" }, year: { selector: ".year", scope: ".panel" } },
    });
    // Every row picks up the year from the panel enclosing it.
    expect(value).toEqual([
      { own: "a", year: "2024" },
      { own: "b", year: "2024" },
    ]);
  });

  it('crosses to the next sibling with "+"', () => {
    panelPage([{ own: "a", next: "score-a" }], "2024");
    const { value } = pageDomExtract({
      item: ".row",
      fields: { score: { selector: ".next", scope: "+" } },
    });
    expect(value).toEqual([{ score: "score-a" }]);
  });

  it('accepts "sibling": true as the older spelling of "+"', () => {
    panelPage([{ own: "a", next: "score-a" }], "2024");
    const { value } = pageDomExtract({
      item: ".row",
      fields: { score: { selector: ".next", sibling: true } },
    });
    expect(value).toEqual([{ score: "score-a" }]);
  });

  it('requires the sibling to match when "+ sel" names one', () => {
    panelPage([{ own: "a", next: "score-a" }], "2024");
    const matched = pageDomExtract({
      item: ".row",
      fields: { score: { selector: ".next", scope: "+ .sub" } },
    });
    expect(matched.value).toEqual([{ score: "score-a" }]);

    const missed = pageDomExtract({
      item: ".row",
      fields: { score: { selector: ".next", scope: "+ .other" } },
    });
    expect(missed.value).toEqual([{ score: null }]);
  });

  it("yields null when the ancestor is absent rather than falling back to the row", () => {
    panelPage([{ own: "a" }], "2024");
    const { value } = pageDomExtract({
      item: ".row",
      fields: { year: { selector: ".year", scope: ".missing" } },
    });
    expect(value).toEqual([{ year: null }]);
  });
});

describe("pageDomExtract text reading", () => {
  it("keeps a <br> boundary that textContent alone would lose", () => {
    // The browser renders "2/3<br>17 Example Street" with a line break.
    expect(
      extractOne({ innerText: "2/3\n17 Example Street", textContent: "2/317 Example Street" })
    ).toBe("2/3\n17 Example Street");
  });

  it("keeps paragraph breaks and caps blank-line runs at one", () => {
    // innerText renders a paragraph gap as \n\n; comment threads depend on it.
    expect(extractOne({ innerText: "first para \n\n second para\n\n\n\nthird" })).toBe(
      "first para\n\nsecond para\n\nthird"
    );
  });

  it("falls back to textContent where innerText is undefined", () => {
    // SVG and MathML elements have no innerText.
    expect(extractOne({ textContent: " a  b " })).toBe("a b");
  });

  it("collapses &nbsp; runs, which content-managed markup is dense with", () => {
    expect(extractOne({ innerText: "7 November 2026" })).toBe("7 November 2026");
    expect(extractOne({ innerText: "  Total:   £10.56 " })).toBe(
      "Total: £10.56"
    );
  });

  it("distinguishes a blank element from a missed selector", () => {
    // "" means present and empty; null means the selector matched nothing.
    expect(extractOne({ innerText: "" })).toBe("");
    expect(extractOne({ innerText: "     \n " })).toBe("");
    expect(extractOne(null)).toBeNull();
  });
});
