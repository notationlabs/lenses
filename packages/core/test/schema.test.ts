import { describe, expect, it } from "vitest";
import { deriveJsonSchema, validateResult } from "../src/schema.js";
import type { LensSpec } from "../src/types.js";

const baseSpec = {
  name: "@example/web/page",
  url: "https://example.com/",
  effects: { reads: ["example.com"], writes: [] },
  resolve: [{ kind: "dom" as const, fields: { title: { selector: "h1" } } }],
};

function specWith(returns: unknown): LensSpec {
  return { ...baseSpec, returns };
}

describe("deriveJsonSchema", () => {
  it("emits a draft 2020-12 envelope named after the lens", () => {
    expect(deriveJsonSchema(specWith("string"))).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "lens:@example/web/page",
      title: "@example/web/page",
      type: "string",
    });
  });

  it("derives objects with required fields, nullable and $lens forms", () => {
    const schema = deriveJsonSchema(
      specWith({
        type: "object",
        fields: {
          title: "string",
          resets_at: { type: "string", nullable: true },
          next_page: { $lens: "@example/web/page", params: { p: "p" } },
        },
      })
    );
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        title: { type: "string" },
        resets_at: { anyOf: [{ type: "string" }, { type: "null" }] },
        next_page: { anyOf: [{ $ref: "#/$defs/lensRef" }, { type: "null" }] },
      },
      required: ["title", "resets_at", "next_page"],
      $defs: {
        lensRef: {
          type: "object",
          properties: { $lens: { type: "string" } },
          required: ["$lens"],
        },
      },
    });
  });

  it("derives array field maps as object items", () => {
    expect(deriveJsonSchema(specWith({ type: "array", items: { id: "string" } }))).toMatchObject({
      type: "array",
      items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("leaves shapeless declarations open", () => {
    expect(deriveJsonSchema(specWith({ type: "object" }))).toMatchObject({ type: "object" });
    expect(deriveJsonSchema(specWith({ type: "array" }))).toMatchObject({ type: "array" });
    expect(deriveJsonSchema(specWith(undefined))).not.toHaveProperty("type");
  });

  it("extracts a self-referencing $defs entry into JSON Schema $defs", () => {
    const spec: LensSpec = {
      ...baseSpec,
      $defs: {
        comment: {
          type: "object",
          fields: { text: "string", replies: { type: "array", items: { $ref: "comment" } } },
        },
      },
      returns: { type: "object", fields: { comments: { type: "array", items: { $ref: "comment" } } } },
    };
    const schema = deriveJsonSchema(spec) as any;
    const ref = schema.properties.comments.items.$ref as string;
    expect(ref).toMatch(/^#\/\$defs\//);
    const def = schema.$defs[ref.slice("#/$defs/".length)];
    expect(def.properties.replies.items.$ref).toBe(ref);

    // runtime validation follows the cycle
    const good = { comments: [{ text: "a", replies: [{ text: "b", replies: [] }] }] };
    expect(validateResult(spec, good)).toEqual([]);
    const bad = { comments: [{ text: "a", replies: [{ replies: [] }] }] };
    expect(validateResult(spec, bad)).toMatchObject([
      { path: "/comments/0/replies/0/text", missing: true },
    ]);
  });
});
