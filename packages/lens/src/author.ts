/**
 * Typed authoring DSL for lenses. Authors write plain TypeScript that compiles
 * to the EXACT canonical JSON the engine runs — the wire format is frozen, so
 * every builder here just constructs the canonical shapes from `types.ts`.
 *
 * Executable fields (`map`, `detect`, `items`, `post`, `body`, DOM `type` text)
 * are JSONata expression STRINGS, never JS closures. They are typed as the
 * branded `Expr` so the author can see, at the type level, which fields the
 * engine will evaluate as JSONata.
 */

import type {
  DomResolver,
  InterceptResolver,
  LensSpec,
  LlmResolver,
} from "./types.js";
import { validateSpec } from "./validate.js";

/* ------------------------------------------------------------------ *
 * Expr — a branded JSONata string
 * ------------------------------------------------------------------ */

/** A JSONata expression string. The phantom `T` documents its result type. */
export type Expr<T = unknown> = string & { readonly __expr?: T };

/** Tag a raw string as a JSONata expression. */
export function expr<T = unknown>(s: string): Expr<T> {
  return s as Expr<T>;
}

/* ------------------------------------------------------------------ *
 * Schema tokens — the string literals the engine's `returns` shape uses
 * ------------------------------------------------------------------ */

export const string = "string" as const;
export const datetime = "datetime" as const;
export const duration = "duration" as const;

/** A cache TTL, in seconds. Identity — exists to read well at the call site. */
export function seconds(n: number): number {
  return n;
}

export type SchemaToken = typeof string | typeof datetime | typeof duration;

/** Any node in a `returns` / `outcomes` schema tree. */
export type Schema =
  | SchemaToken
  | LensRef
  | ObjectSchema
  | ArraySchema
  | { [key: string]: Schema };

export interface ObjectSchema {
  type: "object";
  fields: Record<string, Schema>;
}

export interface ArraySchema {
  type: "array";
  items: Schema;
}

export interface LensRef {
  $lens: string;
  target?: Expr;
}

/** `{ type: "object", fields }` */
export function shape(fields: Record<string, Schema>): ObjectSchema {
  return { type: "object", fields };
}

/** `{ type: "array", items }` */
export function stream(items: Schema): ArraySchema {
  return { type: "array", items };
}

/** A lens reference: `{ $lens }` or `{ $lens, target }`. */
export function lens(url: string, target?: Expr): LensRef {
  return target === undefined ? { $lens: url } : { $lens: url, target };
}

/* ------------------------------------------------------------------ *
 * url — tagged template producing an `accepts` pattern
 * ------------------------------------------------------------------ */

/** A URL pattern string with `{hole}` syntax, as parsed by url-pattern.ts. */
export type Pattern = string & { readonly __pattern?: true };

/**
 * Tagged template for accept patterns. Interpolated string names become named
 * holes:
 *   url`https://x.com/${"handle"}/status/${"id"}`
 *     -> "https://x.com/{handle}/status/{id}"
 * Literal text (including a trailing `*` wildcard) is passed through verbatim.
 * Compose several with a plain array: `accepts: [url`…`, url`…`]`.
 */
export function url(
  strings: TemplateStringsArray,
  ...holes: string[]
): Pattern {
  let out = strings[0];
  for (let i = 0; i < holes.length; i++) {
    out += `{${holes[i]}}` + strings[i + 1];
  }
  return out as Pattern;
}

/* ------------------------------------------------------------------ *
 * Resolver builders — typed pass-throughs that stamp `kind`
 * ------------------------------------------------------------------ */

/**
 * Intercept tier. Covers BOTH forms:
 *   - single `request` shorthand (+ optional `items`/`map`/`detect`)
 *   - `sources` fan-out with an object-`map` drawing from each binding
 * plus the `fire` write form.
 */
export function intercept(
  cfg: Omit<InterceptResolver, "kind">
): InterceptResolver {
  return { kind: "intercept", ...cfg };
}

/** DOM tier: `item`/`fields`/`post`/`actions`/`detect`. */
export function dom(cfg: Omit<DomResolver, "kind">): DomResolver {
  return { kind: "dom", ...cfg };
}

/** LLM tier: `prompt`/`maxSnapshotChars`. */
export function llm(cfg: Omit<LlmResolver, "kind">): LlmResolver {
  return { kind: "llm", ...cfg };
}

/* ------------------------------------------------------------------ *
 * defineLens input
 * ------------------------------------------------------------------ */

/**
 * The authored shape. Structurally identical to `LensSpec` but with the DSL's
 * richer field types (`Pattern`, `Schema`). A plain canonical JSON object also
 * satisfies this, keeping back-compat: `defineLens(rawJson)` still works.
 */
export interface LensInput extends Omit<LensSpec, "accepts" | "returns"> {
  accepts: (Pattern | string)[];
  returns?: Schema;
}

/** Compile + validate an authored lens to canonical JSON. */
export function compileLens(input: LensInput | LensSpec): LensSpec {
  return validateSpec(input);
}
