import { describe, expect, it } from "vitest";
import { specWarnings, validateSpec } from "../src/validate.js";

const validSpec = {
  name: "@example/web/page",
  url: "https://example.com/{page}",
  params: { page: "string" },
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom", fields: { title: { selector: "h1" } } }],
};

describe("validateSpec", () => {
  it("returns a fully validated lens document", () => {
    expect(validateSpec(validSpec)).toEqual(validSpec);
  });

  it("accepts a positive page load timeout", () => {
    const spec = { ...validSpec, loadTimeoutMs: 45_000 };
    expect(validateSpec(spec)).toEqual(spec);
  });

  it("accepts a $defs entry that references itself", () => {
    const spec = {
      ...validSpec,
      $defs: {
        comment: {
          type: "object",
          fields: { text: "string", replies: { type: "array", items: { $ref: "comment" } } },
        },
      },
      returns: { type: "object", fields: { comments: { type: "array", items: { $ref: "comment" } } } },
    };
    expect(validateSpec(spec)).toEqual(spec);
  });

  it("rejects a $ref that names no $defs entry", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        returns: { type: "object", fields: { comments: { type: "array", items: { $ref: "comment" } } } },
      })
    ).toThrow(/"\$ref": "comment" names no entry/);
  });

  it("rejects undeclared URL parameters", () => {
    expect(() => validateSpec({ ...validSpec, params: undefined })).toThrow(/not declared/);
  });

  it("rejects an invalid canonical URL", () => {
    expect(() => validateSpec({ ...validSpec, url: "example/{page}" })).toThrow(/absolute URL/);
  });

  it("rejects a parameter default with the wrong type", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "integer", default: "one" } },
      })
    ).toThrow(/default.*page.*integer/);
  });

  it("accepts a string parameter with an enum and an in-enum default", () => {
    const spec = {
      ...validSpec,
      params: { page: { type: "string", enum: ["a", "b"], default: "a" } },
    };
    expect(validateSpec(spec)).toEqual(spec);
  });

  it("rejects an enum on a non-string parameter", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "integer", enum: ["1"] } },
      })
    ).toThrow(/enum.*only string parameters/);
  });

  it("rejects a parameter default outside its enum", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "string", enum: ["a", "b"], default: "c" } },
      })
    ).toThrow(/default.*page.*enum/);
  });

  it("accepts a {$lens, field} parameter default with literal params", () => {
    const spec = {
      ...validSpec,
      params: {
        page: {
          type: "string",
          default: { $lens: "@example/web/home", field: "page", params: { limit: 1 } },
        },
      },
    };
    expect(validateSpec(spec)).toEqual(spec);
  });

  // Membership can only be judged against the resolved value, so an enum with
  // a ref default is structurally fine here and checked by the host per call.
  it("accepts an enum parameter with a ref default", () => {
    const spec = {
      ...validSpec,
      params: {
        page: {
          type: "string",
          enum: ["a", "b"],
          default: { $lens: "@example/web/home", field: "page" },
        },
      },
    };
    expect(validateSpec(spec)).toEqual(spec);
  });

  it("rejects a ref default without a field", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "string", default: { $lens: "@example/web/home" } } },
      })
    ).toThrow(/field/);
  });

  it("rejects a ref default whose target is not a scoped lens name", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: { page: { type: "string", default: { $lens: "web/home", field: "page" } } },
      })
    ).toThrow(/default.*page.*scoped lens name/);
  });

  it("rejects non-literal params on a ref default", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        params: {
          page: {
            type: "string",
            default: {
              $lens: "@example/web/home",
              field: "page",
              params: { limit: { nested: true } },
            },
          },
        },
      })
    ).toThrow(/params/);
  });

  it("rejects a non-positive page load timeout", () => {
    expect(() => validateSpec({ ...validSpec, loadTimeoutMs: 0 })).toThrow(/loadTimeoutMs/);
  });

  it("rejects malformed nested resolver fields before execution", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        resolve: [{ kind: "dom", fields: { title: { selector: 42 } } }],
      })
    ).toThrow(/selector/);
  });

  it("rejects ambiguous intercept inputs", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        resolve: [{
          kind: "intercept",
          request: "GET https://example.com/api",
          sources: { page: { request: "GET https://example.com/api" } },
        }],
      })
    ).toThrow(/either.*request.*sources/i);
  });

  it("rejects return contracts the engine cannot enforce", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        returns: { type: "list", items: { title: "string" } },
      })
    ).toThrow(/returns/);
  });

  it("names the failing path as a JSON pointer with the expected forms", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        returns: { type: "object", fields: { stories: { type: "list" } } },
      })
    ).toThrow(/at \/returns\/fields\/stories\/type: Invalid option: expected one of/);
  });

  it("summarises the accepted return forms when no branch gets further", () => {
    expect(() =>
      validateSpec({ ...validSpec, returns: 42 })
    ).toThrow(/at \/returns: must be a primitive type \("string" \| "number"/);
  });

  it("points at malformed resolver fields", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        resolve: [{ kind: "dom", fields: { title: { selector: 42 } } }],
      })
    ).toThrow(/at \/resolve\/0\/fields\/title\/selector/);
  });

  describe("perform", () => {
    const writeSpec = {
      ...validSpec,
      effects: { reads: ["example.com"], writes: ["example.com"] },
    };

    it("accepts every step opcode", () => {
      const spec = {
        ...writeSpec,
        perform: [
          { wait: { appears: "[data-testid='send']" } },
          { fill: "#composer", value: "$message" },
          { click: "[data-testid='send']" },
          { press: "Enter" },
          { wait: { increases: ".turn", timeoutMs: 30000 } },
          { wait: { gone: ".spinner" } },
          { navigate: "fresh" },
        ],
      };
      expect(validateSpec(spec)).toEqual(spec);
    });

    it("rejects an empty step list", () => {
      expect(() => validateSpec({ ...writeSpec, perform: [] })).toThrow(/perform/);
    });

    it("rejects an unknown opcode, naming the step", () => {
      expect(() =>
        validateSpec({ ...writeSpec, perform: [{ click: "#a" }, { hover: "#b" }] })
      ).toThrow(/at \/perform\/1: must be one perform step/);
    });

    it("rejects an unknown key on a known opcode", () => {
      expect(() =>
        validateSpec({ ...writeSpec, perform: [{ click: "#a", waitMs: 100 }] })
      ).toThrow(/at \/perform\/0/);
    });

    it("rejects a wait naming no condition", () => {
      expect(() => validateSpec({ ...writeSpec, perform: [{ wait: {} }] })).toThrow(
        /exactly one of "appears", "gone", or "increases"/
      );
    });

    it("rejects a wait naming two conditions", () => {
      expect(() =>
        validateSpec({ ...writeSpec, perform: [{ wait: { appears: "#a", gone: "#b" } }] })
      ).toThrow(/exactly one of "appears", "gone", or "increases"/);
    });

    it("rejects a non-positive wait timeout", () => {
      expect(() =>
        validateSpec({ ...writeSpec, perform: [{ wait: { appears: "#a", timeoutMs: 0 } }] })
      ).toThrow(/at \/perform\/0\/wait\/timeoutMs/);
    });

    it('rejects a navigate target other than "fresh"', () => {
      expect(() =>
        validateSpec({ ...writeSpec, perform: [{ navigate: "reload" }] })
      ).toThrow(/at \/perform\/0/);
    });

    it("rejects perform without a writes declaration", () => {
      expect(() =>
        validateSpec({ ...validSpec, perform: [{ click: "#send" }] })
      ).toThrow(/"effects.writes" must name what they write to/);
    });

    it("rejects perform with a positive result cache", () => {
      expect(() =>
        validateSpec({
          ...writeSpec,
          effects: { ...writeSpec.effects, cache: 60 },
          perform: [{ click: "#send" }],
        })
      ).toThrow(/"effects.cache" must be absent or 0/);
    });

    it("accepts perform with an explicit zero cache", () => {
      const spec = {
        ...writeSpec,
        effects: { ...writeSpec.effects, cache: 0 },
        perform: [{ click: "#send" }],
      };
      expect(validateSpec(spec)).toEqual(spec);
    });

    it("rejects an idempotent claim on non-navigate steps", () => {
      expect(() =>
        validateSpec({
          ...writeSpec,
          effects: { ...writeSpec.effects, idempotent: true },
          perform: [{ click: "#send" }],
        })
      ).toThrow(/idempotent.*unless every step is a navigate/);
    });

    // A clear-the-thread lens reloads and nothing else; reloading twice is
    // still one cleared thread, so its idempotence claim stands.
    it("accepts an idempotent claim on a navigate-only perform", () => {
      const spec = {
        ...writeSpec,
        effects: { ...writeSpec.effects, idempotent: true },
        perform: [{ navigate: "fresh" }],
      };
      expect(validateSpec(spec)).toEqual(spec);
    });
  });

  it("accepts nullable primitive return fields", () => {
    expect(() =>
      validateSpec({
        ...validSpec,
        returns: {
          type: "object",
          fields: { resets_at: { type: "string", nullable: true } },
        },
      })
    ).not.toThrow();
  });
});

describe("specWarnings", () => {
  const withDetect = (detect: Record<string, string>, outcomes?: Record<string, unknown>) =>
    validateSpec({
      ...validSpec,
      ...(outcomes ? { outcomes } : {}),
      resolve: [{ kind: "dom", detect, fields: { title: { selector: "h1" } } }],
    });

  it("says nothing when every detected outcome is declared", () => {
    expect(specWarnings(withDetect({ needs_auth: "true" }, { needs_auth: { hint: "Sign in." } })))
      .toEqual([]);
  });

  it("flags a resolver detect naming an outcome the document does not declare", () => {
    const [warning] = specWarnings(withDetect({ needs_auth: "true" }));
    expect(warning).toContain('detect names the outcome "needs_auth"');
  });

  // The author who hit this declared `description` and shipped 16 dead strings,
  // so the remediation has to name the one key that is actually read.
  it("names hint and shows a copyable declaration", () => {
    const [warning] = specWarnings(withDetect({ needs_auth: "true" }));
    expect(warning).toContain('"outcomes": { "needs_auth": { "hint": "<how to recover>" } }');
    expect(warning).toContain('"hint" is the only key read from the declaration');
  });

  it("steers a sibling field onto scope, naming what scope buys", () => {
    const spec = validateSpec({
      ...validSpec,
      resolve: [
        { kind: "dom", item: ".row", fields: { s: { selector: ".score", sibling: true } } },
      ],
    });
    const [warning] = specWarnings(spec);
    expect(warning).toContain('"scope": "+"');
    expect(warning).toContain("also reaches ancestors");
  });

  it("says nothing about a field that already uses scope", () => {
    const spec = validateSpec({
      ...validSpec,
      resolve: [{ kind: "dom", item: ".row", fields: { s: { selector: ".y", scope: ".panel" } } }],
    });
    expect(specWarnings(spec)).toEqual([]);
  });

  it("flags a spec-level detect too", () => {
    const spec = validateSpec({ ...validSpec, detect: { rate_limited: "true" } });
    expect(specWarnings(spec)).toHaveLength(1);
  });

  it("does not flag an outcome declared with a null body", () => {
    const spec = validateSpec({
      ...validSpec,
      outcomes: { needs_auth: null },
      detect: { needs_auth: "true" },
    });
    expect(specWarnings(spec)).toEqual([]);
  });
});
