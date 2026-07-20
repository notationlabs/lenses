import * as z from "zod/v4";
import type { LensSpec } from "./types.js";

const expression = z.string();
const detect = z.record(z.string(), expression);

const sourceSchema = z.strictObject({
  request: z.string(),
  items: expression.optional(),
});

const interceptSchema = z
  .strictObject({
    kind: z.literal("intercept"),
    request: z.string().optional(),
    sources: z.record(z.string(), sourceSchema).optional(),
    items: expression.optional(),
    map: z.union([expression, z.record(z.string(), expression)]).optional(),
    detect: detect.optional(),
    reloadOnMiss: z.boolean().optional(),
    waitMs: z.number().int().nonnegative().optional(),
  })
  .refine((resolver) => Boolean(resolver.request) !== Boolean(resolver.sources), {
    message: 'intercept resolver needs either "request" or "sources", but not both',
  })
  .refine((resolver) => !resolver.sources || Object.keys(resolver.sources).length > 0, {
    message: 'intercept resolver "sources" must not be empty',
  });

const domFieldSchema = z.strictObject({
  selector: z.string(),
  attr: z.string().optional(),
  sibling: z.boolean().optional(),
});

const domSchema = z.strictObject({
  kind: z.literal("dom"),
  detect: detect.optional(),
  item: z.string().optional(),
  fields: z.record(z.string(), domFieldSchema).optional(),
  post: expression.optional(),
});

const llmSchema = z.strictObject({
  kind: z.literal("llm"),
  prompt: z.string(),
  maxSnapshotChars: z.number().int().positive().optional(),
});

const returnSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.enum(["string", "number", "boolean", "integer", "null"]),
    z.strictObject({
      type: z.enum(["string", "number", "boolean", "integer"]),
      nullable: z.literal(true),
    }),
    z.strictObject({
      $lens: z.string(),
      params: z.record(z.string(), expression).optional(),
    }),
    z.strictObject({
      type: z.literal("object"),
      fields: z.record(z.string(), returnSchema).optional(),
    }),
    z.strictObject({
      type: z.literal("array"),
      items: z.record(z.string(), returnSchema).optional(),
    }),
  ])
);

const lensSpecSchema = z.strictObject({
  name: z.string().regex(/^@[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/, {
    message: 'must be a scoped name like "@djgrant/hn/top"',
  }),
  description: z.string().optional(),
  url: z.string(),
  params: z
    .record(
      z.string(),
      z.union([
        z.enum(["string", "number", "integer", "boolean"]),
        z.strictObject({
          type: z.enum(["string", "number", "integer", "boolean"]),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
      ])
    )
    .optional(),
  loadTimeoutMs: z.number().int().positive().optional(),
  returns: returnSchema.optional(),
  outcomes: z.record(z.string(), z.unknown()).optional(),
  effects: z.strictObject({
    reads: z.array(z.string()),
    writes: z.array(z.string()),
    idempotent: z.boolean().optional(),
    cache: z.number().nonnegative().optional(),
  }),
  resolve: z.array(z.discriminatedUnion("kind", [interceptSchema, domSchema, llmSchema])).min(1),
});

export function validateSpec(raw: unknown): LensSpec {
  const result = lensSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`invalid lens spec:\n${z.prettifyError(result.error)}`);
  }
  const holes = [...result.data.url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(
    (match) => match[1]
  );
  for (const hole of holes) {
    if (!result.data.params?.[hole]) {
      throw new Error(`invalid lens spec:\n  URL parameter "${hole}" is not declared`);
    }
  }
  for (const [name, declaration] of Object.entries(result.data.params ?? {})) {
    if (typeof declaration === "string" || declaration.default === undefined) continue;
    const valid =
      declaration.type === "integer"
        ? Number.isInteger(declaration.default)
        : typeof declaration.default === declaration.type;
    if (!valid) {
      throw new Error(
        `invalid lens spec:\n  default for parameter "${name}" must be ${declaration.type}`
      );
    }
  }
  const checkUrl = result.data.url.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "value");
  try {
    new URL(checkUrl);
  } catch {
    throw new Error("invalid lens spec:\n  url must be an absolute URL template");
  }
  return result.data;
}
