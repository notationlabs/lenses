import * as z from "zod/v4";
import { httpRequestMethod, httpResolverWrites } from "./http-request.js";
import { checkExpression, checkTemplate, RESERVED_VARIABLES, type ExprSite, type ReservedVariable } from "./expr-check.js";
import type { ExceptionMap, HttpBody, HttpSource, LensSpec, MapSpec } from "./types.js";
import { HOLE } from "./url-pattern.js";

const expression = z.string();
const REQUEST_HINT =
  'must be an object {"method": "GET", "url": "https://…/{params.id}"}; the "METHOD url" string form is removed';
const requestSchema = z.strictObject(
  {
    method: z.string().regex(/^[A-Za-z]+$/, { message: 'must be an HTTP method such as "GET"' }),
    url: z.string(),
  },
  { error: (issue) => (typeof issue.input === "string" ? REQUEST_HINT : undefined) }
);
/** A map: one expression, or an object of expressions and nested objects. */
const mapSchema: z.ZodType<MapSpec> = z.lazy(() =>
  z.union([expression, z.record(z.string(), mapSchema)])
);
export const exceptionEntrySchema = z.strictObject({
  matches: expression.nullable().optional(),
  hint: z.string().optional(),
  $lens: z.string().optional(),
  params: z.record(z.string(), expression).optional(),
});
export const exceptionsSchema = z.record(z.string(), exceptionEntrySchema.nullable());

/** Validate catalog scope entries even when no lens in this directory matches. */
export function validateExceptions(raw: unknown): LensSpec["exceptions"] {
  const result = exceptionsSchema.safeParse(raw);
  if (!result.success) throw new Error(`invalid scope exceptions: ${result.error.message}`);
  for (const [name, entry] of Object.entries(result.data)) {
    for (const [label, expr] of exceptionExpressions(name, entry)) {
      const error = checkExpression(expr, { label, vars: DOCUMENT_EXCEPTION_VARS });
      if (error) throw new Error(`invalid scope exceptions: ${error}`);
    }
  }
  return result.data;
}

/**
 * A document (or catalog scope) exception runs against every page and every
 * response, so it may read either; the one not being checked is undefined.
 */
const DOCUMENT_EXCEPTION_VARS: readonly ReservedVariable[] = ["page", "res", "params"];

function exceptionExpressions(
  name: string,
  entry: NonNullable<ExceptionMap[string]> | null
): [string, string][] {
  if (!entry) return [];
  return [
    ...(typeof entry.matches === "string" ? [[`exceptions.${name}.matches`, entry.matches] as [string, string]] : []),
    ...Object.entries(entry.params ?? {}).map(
      ([key, expr]) => [`exceptions.${name}.params.${key}`, expr] as [string, string]
    ),
  ];
}
const bodyFields = z.record(z.string(), expression);
const httpBodySchema = z.union([
  z.strictObject({ json: expression }),
  z.strictObject({ form: bodyFields }),
  z.strictObject({ search: bodyFields }),
  z.strictObject({ text: expression }),
]);
const credentials = z.union([z.boolean(), z.literal("same-origin-page")]);
const httpSourceSchema = z.strictObject({
  request: requestSchema,
  body: httpBodySchema.optional(),
  credentials: credentials.optional(),
  headers: z.record(z.string(), expression).optional(),
  items: expression.optional(),
});

const httpSchema = z
  .strictObject({
    kind: z.literal("http"),
    request: requestSchema.optional(),
    body: httpBodySchema.optional(),
    sources: z.record(z.string(), httpSourceSchema).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    credentials: credentials.optional(),
    items: expression.optional(),
    map: mapSchema.optional(),
    exceptions: exceptionsSchema.optional(),
  })
  .refine((resolver) => !(resolver.items !== undefined && resolver.sources), {
    message: 'http resolver "items" belongs on each source when "sources" is used',
  })
  .refine((resolver) => !(resolver.request && resolver.sources), {
    message: 'http resolver takes either "request" or "sources", not both',
  })
  .refine((resolver) => !resolver.sources || Object.keys(resolver.sources).length > 0, {
    message: 'http resolver "sources" must not be empty',
  })
  .refine((resolver) => !(resolver.body && resolver.sources), {
    message: 'http resolver body belongs on each source when "sources" is used',
  });

const sourceSchema = z.strictObject({
  request: requestSchema,
  items: expression.optional(),
});

const interceptSchema = z
  .strictObject({
    kind: z.literal("intercept"),
    request: requestSchema.optional(),
    sources: z.record(z.string(), sourceSchema).optional(),
    items: expression.optional(),
    map: mapSchema.optional(),
    exceptions: exceptionsSchema.optional(),
    reloadOnMiss: z.boolean().optional(),
    waitMs: z.number().int().nonnegative().optional(),
  })
  .refine((resolver) => Boolean(resolver.request) !== Boolean(resolver.sources), {
    message: 'intercept resolver needs either "request" or "sources", but not both',
  })
  .refine((resolver) => !resolver.sources || Object.keys(resolver.sources).length > 0, {
    message: 'intercept resolver "sources" must not be empty',
  })
  .refine((resolver) => !(resolver.items !== undefined && resolver.sources), {
    message: 'intercept resolver "items" belongs on each source when "sources" is used',
  });

const domFieldSchema = z.strictObject({
  selector: z.string(),
  attr: z.string().optional(),
  scope: z.string().optional(),
  sibling: z.boolean().optional(),
});

const domSchema = z.strictObject({
  kind: z.literal("dom"),
  exceptions: exceptionsSchema.optional(),
  item: z.string().optional(),
  fields: z.record(z.string(), domFieldSchema).optional(),
  post: expression.optional(),
});

const llmSchema = z.strictObject({
  kind: z.literal("llm"),
  prompt: z.string(),
  maxSnapshotChars: z.number().int().positive().optional(),
});

const waitSchema = z
  .strictObject({
    appears: z.string().optional(),
    gone: z.string().optional(),
    increases: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine(
    (wait) =>
      [wait.appears, wait.gone, wait.increases].filter((sel) => sel !== undefined).length === 1,
    { message: 'wait takes exactly one of "appears", "gone", or "increases"' }
  );

const PERFORM_HINT =
  'must be one perform step: {"fill": <sel>, "value": <expr>}, {"click": <sel>}, ' +
  '{"submit": <form-sel>, "form"?: {<field>: <expr>}}, {"press": <key>}, ' +
  '{"drop": <sel>, "file": <param>}, ' +
  '{"wait": {"appears" | "gone" | "increases": <sel>, "timeoutMs"?: <ms>}}, ' +
  'or {"navigate": "fresh"}';

// A closed opcode set: unknown keys and unknown opcodes fail here rather than
// reaching a page as a silent no-op mid-write. The opcode gate runs before the
// union so an unknown opcode reports the step's hint, not five branch misses.
const performStepSchema = z
  .record(z.string(), z.unknown(), { error: PERFORM_HINT })
  .refine(
    (step) => ["fill", "click", "submit", "press", "drop", "wait", "navigate"].some((opcode) => opcode in step),
    { message: PERFORM_HINT }
  )
  .pipe(
    z.union(
      [
        z.strictObject({ fill: z.string(), value: expression }),
        z.strictObject({ click: z.string() }),
        z.strictObject({ submit: z.string(), form: bodyFields.optional() }),
        z.strictObject({ press: z.string() }),
        z.strictObject({ drop: z.string(), file: z.string() }),
        z.strictObject({ wait: waitSchema }),
        z.strictObject({ navigate: z.literal("fresh") }),
      ],
      { error: PERFORM_HINT }
    )
  );

const RETURNS_HINT =
  'must be a primitive type ("string" | "number" | "integer" | "boolean" | "null"), ' +
  'a nullable primitive {"type": ..., "nullable": true}, a lens reference {"$lens": ..., "params"?}, ' +
  'a def reference {"$ref": <name in $defs>}, ' +
  '{"type": "object", "fields"?: {...}}, or {"type": "array", "items"?: <field map> | {"$ref": ...}}';

const defRefSchema = z.strictObject({ $ref: z.string() });

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
    defRefSchema,
    z.strictObject({
      type: z.literal("object"),
      fields: z.record(z.string(), returnSchema).optional(),
    }),
    z.strictObject({
      type: z.literal("array"),
      items: z.union([defRefSchema, z.record(z.string(), returnSchema)]).optional(),
    }),
  ], { error: RETURNS_HINT })
);

// A def is always an object shape: refs exist so a field map can contain
// itself, and only object types can carry the recursive edge.
const defSchema = z.strictObject({
  type: z.literal("object"),
  fields: z.record(z.string(), returnSchema).optional(),
});

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
          default: z
            .union([
              z.string(),
              z.number(),
              z.boolean(),
              // A {$lens, field} default the host resolves by calling the
              // target lens; params are literals only — no expressions.
              z.strictObject({
                $lens: z.string(),
                field: z.string(),
                params: z
                  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                  .optional(),
              }),
            ])
            .optional(),
          enum: z.array(z.string()).min(1).optional(),
        }),
      ])
    )
    .optional(),
  loadTimeoutMs: z.number().int().positive().optional(),
  tab: z.literal("reuse").optional(),
  navigate: z.literal("in-page").optional(),
  ready: z.string().min(1).optional(),
  returns: returnSchema.optional(),
  $defs: z.record(z.string(), defSchema).optional(),
  exceptions: exceptionsSchema.optional(),
  helpers: z.record(z.string(), expression).optional(),
  effects: z.strictObject({
    reads: z.array(z.string()),
    writes: z.array(z.string()),
    idempotent: z.boolean().optional(),
    cache: z.number().nonnegative().optional(),
  }),
  perform: z.array(performStepSchema).min(1).optional(),
  resolve: z
    .array(z.discriminatedUnion("kind", [httpSchema, interceptSchema, domSchema, llmSchema]))
    .min(1),
});

/** Non-fatal authoring warnings. */
export function specWarnings(spec: LensSpec): string[] {
  const warnings: string[] = [];
  for (const resolver of spec.resolve) {
    if (resolver.kind !== "dom") continue;
    for (const [name, field] of Object.entries(resolver.fields ?? {})) {
      if (field.sibling && !field.scope) warnings.push(
        `field "${name}" uses "sibling": true; prefer "scope": "+", which also reaches ancestors.`
      );
    }
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
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const legacyResolver = Array.isArray(record.resolve)
      ? record.resolve.find((r) => r && typeof r === "object" && "detect" in r) as Record<string, unknown> | undefined
      : undefined;
    if ("detect" in record || legacyResolver) {
      const legacy = "detect" in record ? record.detect : legacyResolver?.detect;
      const name = typeof legacy === "object" && legacy !== null ? Object.keys(legacy)[0] : "<name>";
      throw new Error(`invalid lens spec: "detect" is removed; use exceptions.${name}.matches`);
    }
    if ("outcomes" in record) throw new Error('invalid lens spec: "outcomes" is removed; use "exceptions"');
  }
  const result = lensSpecSchema.safeParse(raw);
  if (!result.success) {
    const lines = flattenIssues(result.error.issues).map(
      (issue) => `  at ${pointerOf(issue.path)}: ${issue.message}`
    );
    throw new Error(`invalid lens spec:\n${[...new Set(lines)].join("\n")}`);
  }
  const defs = result.data.$defs ?? {};
  const refsIn = (schema: unknown): string[] => {
    if (schema === null || typeof schema !== "object") return [];
    if (Array.isArray(schema)) return schema.flatMap(refsIn);
    const record = schema as Record<string, unknown>;
    if (typeof record.$ref === "string") return [record.$ref];
    return Object.values(record).flatMap(refsIn);
  };
  for (const ref of refsIn([result.data.returns, defs])) {
    if (!(ref in defs)) {
      throw new Error(`invalid lens spec:\n  "$ref": "${ref}" names no entry in "$defs"`);
    }
  }
  checkExpressionsAndTemplates(result.data);
  // A drop reads a local file into the page, so its path must come from the
  // caller: a declared string param with no default, never a document literal.
  for (const step of result.data.perform ?? []) {
    if (!("drop" in step)) continue;
    const declaration = result.data.params?.[step.file];
    const type = typeof declaration === "string" ? declaration : declaration?.type;
    if (type !== "string") {
      throw new Error(
        `invalid lens spec:\n  drop file "${step.file}" must name a declared string parameter`
      );
    }
    if (typeof declaration === "object" && declaration.default !== undefined) {
      throw new Error(
        `invalid lens spec:\n  drop file parameter "${step.file}" must not declare a default`
      );
    }
  }
  for (const [name, declaration] of Object.entries(result.data.params ?? {})) {
    if (typeof declaration === "string") continue;
    if (declaration.enum && declaration.type !== "string") {
      throw new Error(
        `invalid lens spec:\n  parameter "${name}" declares "enum", which only string parameters may`
      );
    }
    if (declaration.default === undefined) continue;
    if (typeof declaration.default === "object") {
      // Structural check only: type agreement with the target's field and enum
      // membership are the host's to verify at resolution time, because a
      // single document cannot see the target lens.
      if (!/^@[a-z0-9_-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(declaration.default.$lens)) {
        throw new Error(
          `invalid lens spec:\n  default for parameter "${name}" must reference a scoped lens name like "@djgrant/hn/top"`
        );
      }
      continue;
    }
    const valid =
      declaration.type === "integer"
        ? Number.isInteger(declaration.default)
        : typeof declaration.default === declaration.type;
    if (!valid) {
      throw new Error(
        `invalid lens spec:\n  default for parameter "${name}" must be ${declaration.type}`
      );
    }
    if (declaration.enum && !declaration.enum.includes(String(declaration.default))) {
      throw new Error(
        `invalid lens spec:\n  default for parameter "${name}" must be one of its enum values`
      );
    }
  }
  const writeHttpResolvers = result.data.resolve.filter(
    (resolver) => resolver.kind === "http" && httpResolverWrites(resolver)
  );
  for (const resolver of result.data.resolve) {
    if (resolver.kind !== "http") continue;
    const requests = resolver.sources
      ? Object.values(resolver.sources)
      : [{ request: resolver.request, body: resolver.body }];
    for (const request of requests) {
      if (request.body && ["GET", "HEAD"].includes(httpRequestMethod(request.request))) {
        throw new Error(
          `invalid lens spec:\n  an http ${httpRequestMethod(request.request)} request cannot declare a body`
        );
      }
    }
  }
  // Consent keys off the declaration, so every executable write must say what
  // it writes and must never serve a cached result.
  if (result.data.perform || writeHttpResolvers.length > 0) {
    if (result.data.effects.writes.length === 0) {
      throw new Error(
        'invalid lens spec:\n  write operations require a declaration: "effects.writes" must name what they write to'
      );
    }
    if ((result.data.effects.cache ?? 0) > 0) {
      throw new Error(
        'invalid lens spec:\n  a write result must not be cached — "effects.cache" must be absent or 0'
      );
    }
  }
  // A perform document may only claim idempotence when its steps are
  // navigate-only (a reload is; a send is not).
  if (result.data.perform) {
    const navigateOnly = result.data.perform.every((step) => "navigate" in step);
    if (result.data.effects.idempotent === true && !navigateOnly) {
      throw new Error(
        'invalid lens spec:\n  "effects.idempotent": true contradicts "perform" unless every step is a navigate'
      );
    }
  }
  const checkUrl = result.data.url.replace(HOLE, "value");
  try {
    new URL(checkUrl);
  } catch {
    throw new Error("invalid lens spec:\n  url must be an absolute URL template");
  }
  return result.data;
}

/**
 * Every expression is checked against the variables its site binds, and every
 * template against the holes its site can fill. Which variables a site binds
 * is the language's contract; SKILL.md's variable table mirrors this function.
 */
function checkExpressionsAndTemplates(spec: LensSpec): void {
  const params = Object.keys(spec.params ?? {});
  const helpers = Object.keys(spec.helpers ?? {});
  const fail = (message: string): never => {
    throw new Error(`invalid lens spec:\n  ${message}`);
  };
  const expr = (
    source: string | null | undefined,
    site: Omit<ExprSite, "helpers" | "params">
  ) => {
    if (typeof source !== "string") return;
    const error = checkExpression(source, { ...site, helpers, params });
    if (error) fail(error);
  };
  const map = (
    spec: MapSpec | undefined,
    label: string,
    site: Omit<ExprSite, "helpers" | "params" | "label">
  ) => {
    if (spec === undefined) return;
    if (typeof spec === "string") return expr(spec, { ...site, label });
    for (const [field, inner] of Object.entries(spec)) map(inner, `${label}.${field}`, site);
  };
  const template = (source: string | undefined, label: string, sources?: string[], allSources?: string[]) => {
    if (source === undefined) return;
    const error = checkTemplate(source, { label, params, sources, allSources });
    if (error) fail(error);
  };

  for (const name of helpers) {
    if ((RESERVED_VARIABLES as readonly string[]).includes(name)) {
      fail(`helper "${name}" takes a reserved variable name ($${name})`);
    }
    // Helper bodies are lambdas compiled on their own: they read only their arguments.
    const error = checkExpression(spec.helpers![name], { label: `helpers.${name}`, vars: [] });
    if (error) fail(error);
  }

  template(spec.url, "url");

  const tierVars = (resolver: LensSpec["resolve"][number]): readonly ReservedVariable[] =>
    resolver.kind === "dom"
      ? ["page", "value", "params"]
      : "sources" in resolver && resolver.sources
        ? ["sources", "params"]
        : ["res", "params"];
  const exceptions = (
    entries: ExceptionMap | undefined,
    prefix: string,
    vars: readonly ReservedVariable[],
    sources?: string[]
  ) => {
    for (const [name, entry] of Object.entries(entries ?? {})) {
      if (!entry) continue;
      // A tier entry without its own predicate lends its params to the
      // inherited one, which runs against a page or response.
      const ownMatches = typeof entry.matches === "string";
      for (const [label, source] of exceptionExpressions(name, entry)) {
        const isParams = !label.endsWith(".matches");
        const siteVars = isParams && !ownMatches
          ? [...new Set([...vars, ...DOCUMENT_EXCEPTION_VARS])]
          : vars;
        expr(source, { label: `${prefix}${label}`, vars: siteVars, sources, allSources: sources });
      }
    }
  };
  exceptions(spec.exceptions, "", DOCUMENT_EXCEPTION_VARS);

  // $lens reference params read the object the reference sits in, as $item.
  const refs = (schema: unknown, path: string): void => {
    if (schema === null || typeof schema !== "object") return;
    if (Array.isArray(schema)) return schema.forEach((inner, index) => refs(inner, `${path}/${index}`));
    const record = schema as Record<string, unknown>;
    if (typeof record.$lens === "string" && record.params && typeof record.params === "object") {
      for (const [key, source] of Object.entries(record.params as Record<string, string>)) {
        expr(source, { label: `${path} $lens params.${key}`, vars: ["item", "params"] });
      }
      return;
    }
    for (const [key, inner] of Object.entries(record)) refs(inner, `${path}/${key}`);
  };
  refs(spec.returns, "returns");
  refs(spec.$defs, "$defs");

  spec.perform?.forEach((step, index) => {
    const at = `perform[${index}]`;
    if ("fill" in step) {
      template(step.fill, `${at}.fill`);
      if (step.value !== "") expr(step.value, { label: `${at}.value`, vars: ["params"] });
    } else if ("click" in step) template(step.click, `${at}.click`);
    else if ("submit" in step) {
      template(step.submit, `${at}.submit`);
      for (const [field, source] of Object.entries(step.form ?? {})) {
        if (source !== "") expr(source, { label: `${at}.form.${field}`, vars: ["params"] });
      }
    } else if ("drop" in step) template(step.drop, `${at}.drop`);
    else if ("wait" in step) {
      template(step.wait.appears ?? step.wait.gone ?? step.wait.increases, `${at}.wait`);
    }
  });

  spec.resolve.forEach((resolver, index) => {
    const at = `resolve[${index}]`;
    if (resolver.kind === "llm") return;
    const sourceNames = "sources" in resolver && resolver.sources ? Object.keys(resolver.sources) : undefined;
    exceptions(resolver.exceptions, `${at}.`, tierVars(resolver), sourceNames);
    if (resolver.kind === "dom") {
      template(resolver.item, `${at}.item`);
      for (const [name, field] of Object.entries(resolver.fields ?? {})) {
        template(field.selector, `${at}.fields.${name}.selector`);
        template(field.scope, `${at}.fields.${name}.scope`);
      }
      expr(resolver.post, { label: `${at}.post`, vars: ["value", "params"] });
      return;
    }
    if (resolver.kind === "http") {
      for (const [name, value] of Object.entries(resolver.headers ?? {})) {
        template(value, `${at}.headers.${name}`);
      }
    }
    if (sourceNames) {
      const earlier: string[] = [];
      for (const name of sourceNames) {
        const source = (resolver.sources as Record<string, HttpSource>)[name];
        const sat = `${at}.sources.${name}`;
        if (resolver.kind === "http") {
          template(source.request.url, `${sat}.request.url`, [...earlier], sourceNames);
          const site = { vars: ["sources", "params"] as ReservedVariable[], sources: [...earlier], allSources: sourceNames };
          for (const [header, value] of Object.entries(source.headers ?? {})) {
            expr(value, { ...site, label: `${sat}.headers.${header}` });
          }
          bodyExpressions(source.body).forEach(([label, value]) =>
            expr(value, { ...site, label: `${sat}.body.${label}` })
          );
          expr(source.items, {
            label: `${sat}.items`,
            vars: ["res", "sources", "params"],
            sources: [...earlier],
            allSources: sourceNames,
          });
        } else {
          template(source.request.url, `${sat}.request.url`);
          expr(source.items, { label: `${sat}.items`, vars: ["res", "params"] });
        }
        earlier.push(name);
      }
      map(resolver.map, `${at}.map`, { vars: ["sources", "params"], sources: sourceNames, allSources: sourceNames });
      return;
    }
    template(resolver.request?.url, `${at}.request.url`);
    if (resolver.kind === "http") {
      bodyExpressions(resolver.body).forEach(([label, source]) =>
        expr(source, { label: `${at}.body.${label}`, vars: ["params"] })
      );
    }
    expr(resolver.items, { label: `${at}.items`, vars: ["res", "params"] });
    map(resolver.map, `${at}.map`, {
      vars: resolver.items !== undefined ? ["item", "res", "params"] : ["res", "params"],
    });
  });
}

function bodyExpressions(body: HttpBody | undefined): [string, string][] {
  if (!body) return [];
  if ("json" in body) return [["json", body.json]];
  if ("text" in body) return [["text", body.text]];
  const fields = "form" in body ? body.form : body.search;
  const kind = "form" in body ? "form" : "search";
  return Object.entries(fields).map(([name, source]) => [`${kind}.${name}`, source]);
}
