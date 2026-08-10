/**
 * Compile lens documents into a GraphQL schema.
 *
 * Lenses group by site: `{ hn { top(page: 1) {…} } }`. Each lens becomes a
 * field on its group whose args are the lens params. Each $lens ref in a
 * returns contract becomes an object field of the target lens's type — named
 * without url-ish suffixes (item_url → item) — resolved by calling the lens
 * client, so refs are only followed when the query selects into them, and
 * array fields take `first` to bound how many rows resolve onward.
 *
 * Every resolved field is a live browser call, so execution is metered: the
 * per-operation context carries a call budget (exhaustion is a GraphQL error)
 * and collects per-call metadata (resolver tier, cache state, ttl, landed
 * URL) for the response's extensions.
 *
 * The `graphql` package is an optional peer dependency, loaded only through
 * this subpath export.
 */
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLFloat,
  GraphQLInt,
  type GraphQLInputType,
  GraphQLList,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import type { LensResult, LensSpec } from "./types.js";

/** Structurally the client package's LensClient; declared here so core does not depend on it. */
export interface GraphQLLensClient {
  call(input: {
    lens: string;
    params?: Record<string, unknown>;
    strict?: boolean;
  }): Promise<LensResult & { cached?: boolean }>;
}

/** One lens call made while executing an operation, for the response's extensions. */
export interface LensCallRecord {
  lens: string;
  params: Record<string, unknown>;
  /** which resolver tier produced the value (dom, intercept, …, or "reconciled") */
  resolver?: string;
  cached: boolean;
  /** the lens's declared cache ttl in seconds, when it has one */
  ttlSeconds?: number;
  /** where the value was read from — the landed URL, not the requested one */
  observed?: string;
  durationMs: number;
}

export interface GraphQLLensContext {
  client: GraphQLLensClient;
  /** remaining lens calls this operation may make; decremented per call */
  budget: { remaining: number };
  /** appended per lens call, in execution order */
  calls: LensCallRecord[];
}

/** The per-operation context `graphql()` must be executed with. */
export function createContext(
  client: GraphQLLensClient,
  maxCalls: number
): GraphQLLensContext {
  return { client, budget: { remaining: maxCalls }, calls: [] };
}

/** Untyped or unmapped values pass through as-is. */
const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
});

// scalar types serve as both output and input (arg) types
const SCALARS: Record<string, GraphQLScalarType> = {
  string: GraphQLString,
  integer: GraphQLInt,
  number: GraphQLFloat,
  boolean: GraphQLBoolean,
  null: JSONScalar,
};

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** '@djgrant/hn/top' → ['hn', 'top'] (scope dropped). */
const segmentsOf = (lens: string): string[] =>
  lens
    .replace(/^@[^/]+\//, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter((segment) => segment !== "");

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** 'byPopularity' → 'BY_POPULARITY'; the lens still receives the declared value. */
const enumValueName = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^([0-9])/, "_$1")
    .toUpperCase();

/** A ref field is named for what it joins to, not the url it came from. */
const refFieldName = (key: string, siblings: Record<string, unknown>): string => {
  const stripped = key.replace(/_?(url|link|href)$/i, "");
  return stripped !== "" && !(stripped in siblings) ? stripped : key;
};

const hostOf = (url: unknown): string | undefined => {
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).host;
  } catch {
    return undefined;
  }
};

/** One lens's `$defs`, with each def's compiled type memoised so self-references bind. */
interface DefScope {
  defs: Record<string, unknown>;
  types: Map<string, GraphQLOutputType>;
  /** prefix for def type names, e.g. "HnItem" + def "comments" → HnItemComments */
  baseName: string;
}

export function buildLensSchema(specs: LensSpec[]): GraphQLSchema {
  const typeByLens = new Map<string, GraphQLOutputType>();
  const usedNames = new Set<string>(["Query", "JSON"]);

  const specFor = (lens: string): LensSpec | undefined =>
    specs.find((candidate) => candidate.name === lens);

  const hintFor = (lens: string, outcome: string): string | undefined => {
    const declared = specFor(lens)?.outcomes?.[outcome];
    return isRecord(declared) && typeof declared.hint === "string" ? declared.hint : undefined;
  };

  async function callLens(
    context: GraphQLLensContext,
    lens: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (context.budget.remaining <= 0) {
      throw new GraphQLError(
        `lens call budget exhausted before calling ${lens}; ` +
          "select fewer ref fields, lower `first`, or raise the budget",
        { extensions: { lens, code: "LENS_BUDGET_EXHAUSTED" } }
      );
    }
    context.budget.remaining -= 1;
    const startedAt = Date.now();
    const result = await context.client.call({ lens, params, strict: false });
    const ttl = specFor(lens)?.effects.cache;
    context.calls.push({
      lens,
      params,
      resolver: "resolver" in result ? result.resolver : undefined,
      cached: result.cached === true,
      ...(typeof ttl === "number" ? { ttlSeconds: ttl } : {}),
      ...(result.kind === "value" && result.observed !== undefined
        ? { observed: result.observed }
        : {}),
      durationMs: Date.now() - startedAt,
    });
    if (result.kind === "outcome") {
      throw new GraphQLError(`${lens} returned outcome: ${result.name}`, {
        extensions: { lens, outcome: result.name, hint: hintFor(lens, result.name) },
      });
    }
    if (result.kind === "error") {
      throw new GraphQLError(result.message ?? `${lens} errored`, {
        extensions: { lens },
      });
    }
    return result.value;
  }

  const uniqueName = (base: string): string => {
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}${n++}`;
    usedNames.add(name);
    return name;
  };

  /** A field whose value is a materialised {$lens, params} ref: resolve by calling the lens. */
  const refField = (target: string, key: string): GraphQLFieldConfig<any, GraphQLLensContext> => ({
    type: typeForLens(target),
    description: `joins to ${target}${refFieldName(key, {}) === key ? "" : ` (via ${key})`}`,
    resolve: async (parent, _args, context) => {
      const ref = parent?.[key];
      if (!isRecord(ref) || typeof ref.$lens !== "string") return null;
      return callLens(context, ref.$lens, ref.params ?? {});
    },
  });

  const fieldConfig = (
    schema: unknown,
    key: string,
    owner: string,
    scope: DefScope
  ): GraphQLFieldConfig<any, GraphQLLensContext> => {
    if (isRecord(schema) && typeof schema.$lens === "string") {
      return refField(schema.$lens, key);
    }
    if (isRecord(schema) && schema.type === "array") {
      const items = schema.items;
      // items may be a bare field map (no type/$lens/$ref), a schema, or a scalar name
      const itemType =
        isRecord(items) &&
        items.type === undefined &&
        items.$lens === undefined &&
        items.$ref === undefined
          ? objectType(`${owner}${capitalise(key)}`, items, scope)
          : typeFor(items, key, owner, scope);
      return {
        type: new GraphQLList(itemType),
        args: {
          first: {
            type: GraphQLInt,
            description: "bound how many rows resolve onward",
          },
        },
        resolve: (parent, args) => {
          const value = parent?.[key];
          if (!Array.isArray(value)) return value ?? null;
          return typeof args.first === "number" ? value.slice(0, args.first) : value;
        },
      };
    }
    return { type: typeFor(schema, key, owner, scope) };
  };

  const typeFor = (
    schema: unknown,
    key: string,
    owner: string,
    scope: DefScope
  ): GraphQLOutputType => {
    if (typeof schema === "string") return SCALARS[schema] ?? JSONScalar;
    if (!isRecord(schema)) return JSONScalar;
    if (typeof schema.$lens === "string") return typeForLens(schema.$lens);
    if (typeof schema.$ref === "string") return typeForDef(schema.$ref, scope);
    if (schema.type === "object" && isRecord(schema.fields)) {
      return objectType(`${owner}${capitalise(key)}`, schema.fields, scope);
    }
    if (typeof schema.type === "string") {
      return SCALARS[schema.type] ?? JSONScalar;
    }
    return JSONScalar;
  };

  const objectType = (
    baseName: string,
    fields: Record<string, unknown>,
    scope: DefScope
  ): GraphQLObjectType<any, GraphQLLensContext> => {
    const name = uniqueName(baseName);
    return new GraphQLObjectType<any, GraphQLLensContext>({
      name,
      fields: () =>
        Object.fromEntries(
          Object.entries(fields).map(([key, sub]) =>
            isRecord(sub) && typeof sub.$lens === "string"
              ? [refFieldName(key, fields), refField(sub.$lens, key)]
              : [key, fieldConfig(sub, key, name, scope)]
          )
        ),
    });
  };

  /**
   * The type a `$defs` entry compiles to, memoised per lens so a def that
   * references itself (a comment's replies) resolves to one GraphQL type
   * rather than recursing. Safe to memoise after construction: the cycle only
   * re-enters through the fields thunk, which graphql-js runs later.
   */
  const typeForDef = (name: string, scope: DefScope): GraphQLOutputType => {
    const existing = scope.types.get(name);
    if (existing !== undefined) return existing;
    const def = scope.defs[name];
    const type =
      isRecord(def) && def.type === "object"
        ? objectType(`${scope.baseName}${capitalise(name)}`, isRecord(def.fields) ? def.fields : {}, scope)
        : JSONScalar;
    scope.types.set(name, type);
    return type;
  };

  /** The GraphQL type a lens resolves to; memoised so cyclic refs (next_page) work. */
  const typeForLens = (lens: string): GraphQLOutputType => {
    const existing = typeByLens.get(lens);
    if (existing !== undefined) return existing;
    const spec = specFor(lens);
    const baseName = segmentsOf(lens).map(capitalise).join("");
    const defs = spec?.$defs;
    const scope: DefScope = {
      defs: isRecord(defs) ? defs : {},
      types: new Map(),
      baseName,
    };
    const type =
      spec === undefined
        ? JSONScalar // ref into a lens we have no document for
        : (() => {
            const returns = spec.returns;
            if (isRecord(returns) && typeof returns.$ref === "string") {
              return typeForDef(returns.$ref, scope);
            }
            if (isRecord(returns) && returns.type === "object") {
              return objectType(baseName, returns.fields ?? {}, scope);
            }
            if (isRecord(returns) && returns.type === "array") {
              const items = returns.items;
              return new GraphQLList(
                isRecord(items) &&
                items.type === undefined &&
                items.$lens === undefined &&
                items.$ref === undefined
                  ? objectType(`${baseName}Item`, items, scope)
                  : typeFor(items, "item", baseName, scope)
              );
            }
            return JSONScalar;
          })();
    typeByLens.set(lens, type);
    return type;
  };

  /** An enum-declared param compiles to a named enum: hn/search's order → HnSearchOrder. */
  const argType = (
    declaration: unknown,
    key: string,
    baseName: string
  ): GraphQLInputType => {
    if (isRecord(declaration) && Array.isArray(declaration.enum)) {
      return new GraphQLEnumType({
        name: uniqueName(`${baseName}${capitalise(key)}`),
        values: Object.fromEntries(
          declaration.enum.map((value: string) => [enumValueName(value), { value }])
        ),
      });
    }
    const type = isRecord(declaration) ? declaration.type : declaration;
    return SCALARS[String(type)] ?? GraphQLString;
  };

  const argsFor = (params: LensSpec["params"], baseName: string) =>
    Object.fromEntries(
      Object.entries(params ?? {}).map(([key, declaration]) => {
        const declared = isRecord(declaration) ? declaration.default : undefined;
        // A {$lens} ref default is resolved by the client per call, and an
        // object is not a legal GraphQL defaultValue; the arg stays optional.
        const fallback = isRecord(declared) ? undefined : declared;
        return [
          key,
          {
            type: argType(declaration, key, baseName),
            ...(fallback !== undefined ? { defaultValue: fallback } : {}),
          },
        ];
      })
    );

  const lensField = (spec: LensSpec): GraphQLFieldConfig<unknown, GraphQLLensContext> => ({
    type: typeForLens(spec.name),
    args: argsFor(spec.params, segmentsOf(spec.name).map(capitalise).join("")),
    description: spec.description,
    resolve: (_source: unknown, args: any, context: GraphQLLensContext) =>
      callLens(context, spec.name, args),
  });

  // Register every lens type up front so cross-references bind by name.
  for (const spec of specs) typeForLens(spec.name);

  // One entity per lens group ('@djgrant/hn/top' → hn), described by its site.
  const groups = new Map<string, LensSpec[]>();
  for (const spec of specs) {
    const group = segmentsOf(spec.name)[0] ?? "lenses";
    groups.set(group, [...(groups.get(group) ?? []), spec]);
  }

  const groupField = (
    group: string,
    members: LensSpec[]
  ): GraphQLFieldConfig<unknown, GraphQLLensContext> => ({
    type: new GraphQLObjectType<unknown, GraphQLLensContext>({
      name: uniqueName(capitalise(group)),
      description: [...new Set(members.map((spec) => hostOf(spec.url)))]
        .filter((host) => host !== undefined)
        .join(", "),
      fields: () =>
        Object.fromEntries(
          members.map((spec) => [
            segmentsOf(spec.name).slice(1).join("_") || group,
            lensField(spec),
          ])
        ),
    }),
    resolve: () => ({}),
  });

  const query = new GraphQLObjectType<unknown, GraphQLLensContext>({
    name: "Query",
    fields: () =>
      Object.fromEntries(
        [...groups.entries()].map(([group, members]) =>
          // a single-lens name with no group segment sits directly on Query
          members.length === 1 && segmentsOf(members[0].name).length === 1
            ? [group, lensField(members[0])]
            : [group, groupField(group, members)]
        ),
      ),
  });

  return new GraphQLSchema({ query, types: [JSONScalar] });
}
