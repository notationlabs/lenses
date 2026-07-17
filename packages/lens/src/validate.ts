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

const lensSpecSchema = z.strictObject({
  lens: z.string().regex(/^[a-z0-9_-]+\/[a-z0-9_-]+$/, {
    message: 'must be a namespaced name like "hn/top"',
  }),
  version: z.number().int().positive(),
  description: z.string().optional(),
  accepts: z.array(z.string()).min(1),
  returns: z.unknown().optional(),
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
  return result.data;
}
