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
  scope: z.string().optional(),
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

const RETURNS_HINT =
  'must be a primitive type ("string" | "number" | "integer" | "boolean" | "null"), ' +
  'a nullable primitive {"type": ..., "nullable": true}, a lens reference {"$lens": ..., "params"?}, ' +
  '{"type": "object", "fields"?: {...}}, or {"type": "array", "items"?: <field map>}';

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
  ], { error: RETURNS_HINT })
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
  detect: detect.optional(),
  effects: z.strictObject({
    reads: z.array(z.string()),
    writes: z.array(z.string()),
    idempotent: z.boolean().optional(),
    cache: z.number().nonnegative().optional(),
  }),
  resolve: z.array(z.discriminatedUnion("kind", [interceptSchema, domSchema, llmSchema])).min(1),
});

/**
 * Non-fatal problems with an otherwise valid document.
 *
 * A `detect` naming an outcome the document does not declare still fires, so
 * the call returns that outcome and the caller is handed nothing to do about
 * it. The remediation has to name `hint` explicitly: it is the only key read
 * from a declaration, an author who writes `description` instead ships dead
 * strings, and the result looks correct in `lens list` either way.
 */
export function specWarnings(spec: LensSpec): string[] {
  const warnings: string[] = [];
  for (const resolver of spec.resolve) {
    if (resolver.kind !== "dom") continue;
    for (const [name, field] of Object.entries(resolver.fields ?? {})) {
      if (field.sibling && !field.scope) {
        warnings.push(
          `field "${name}" uses "sibling": true, which is the older spelling of ` +
            `"scope": "+". Prefer "scope", which also reaches ancestors — ` +
            `"scope": ".tab-panel" runs the selector from the enclosing panel.`
        );
      }
    }
  }

  const declared = new Set(Object.keys(spec.outcomes ?? {}));
  const detected = new Set(Object.keys(spec.detect ?? {}));
  for (const resolver of spec.resolve) {
    if ("detect" in resolver && resolver.detect) {
      for (const name of Object.keys(resolver.detect)) detected.add(name);
    }
  }
  for (const name of detected) {
    if (declared.has(name)) continue;
    warnings.push(
      `detect names the outcome "${name}", which "outcomes" does not declare, ` +
        `so a caller that hits it is given no way to recover. Declare it as ` +
        `"outcomes": { "${name}": { "hint": "<how to recover>" } } — "hint" is the ` +
        `only key read from the declaration, so "description" and the like reach nobody.`
    );
  }
  return warnings;
}

function pointerOf(path: PropertyKey[]): string {
  if (path.length === 0) return "/";
  return `/${path
    .map((segment) => String(segment).replace(/~/g, "~0").replace(/\//g, "~1"))
    .join("/")}`;
}

interface SpecIssue {
  path: PropertyKey[];
  message: string;
}

/**
 * A union failure is reported at the union node; when one branch got further
 * (its issues sit deeper than the union itself), those deeper issues locate
 * the actual mistake, so surface them instead of the union's summary.
 */
function flattenIssues(issues: readonly z.core.$ZodIssue[]): SpecIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === "invalid_union") {
      const branchIssues = issue.errors.flatMap((branch) =>
        flattenIssues(branch).map((inner) => ({
          path: [...issue.path, ...inner.path],
          message: inner.message,
        }))
      );
      const deepest = Math.max(...branchIssues.map((inner) => inner.path.length), 0);
      if (deepest > issue.path.length) {
        return branchIssues.filter((inner) => inner.path.length === deepest);
      }
    }
    return [{ path: [...issue.path], message: issue.message }];
  });
}

export function validateSpec(raw: unknown): LensSpec {
  const result = lensSpecSchema.safeParse(raw);
  if (!result.success) {
    const lines = flattenIssues(result.error.issues).map(
      (issue) => `  at ${pointerOf(issue.path)}: ${issue.message}`
    );
    throw new Error(`invalid lens spec:\n${[...new Set(lines)].join("\n")}`);
  }
  const holesIn = (template: string) =>
    [...template.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]);
  for (const hole of holesIn(result.data.url)) {
    if (!result.data.params?.[hole]) {
      throw new Error(`invalid lens spec:\n  URL parameter "${hole}" is not declared`);
    }
  }
  // Selectors take the same holes. Catching an undeclared one here beats a
  // selector that silently keeps its braces and misses everything at runtime.
  for (const resolver of result.data.resolve) {
    if (resolver.kind !== "dom") continue;
    const selectors = [
      ...(resolver.item ? [resolver.item] : []),
      ...Object.values(resolver.fields ?? {}).flatMap((field) =>
        field.scope ? [field.selector, field.scope] : [field.selector]
      ),
    ];
    for (const selector of selectors) {
      for (const hole of holesIn(selector)) {
        if (!result.data.params?.[hole]) {
          throw new Error(`invalid lens spec:\n  selector parameter "${hole}" is not declared`);
        }
      }
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
