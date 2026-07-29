import type { EngineIO, LensResult, LensSpec, Resolver, ResolverMiss } from "./types.js";
import { materialiseLenses } from "./materialise.js";
import { runIntercept } from "./resolvers/intercept.js";
import { runDom } from "./resolvers/dom.js";
import { runLlm } from "./resolvers/llm.js";
import { isPlainObject } from "./util.js";
import { fillAbsent, satisfiesReturns } from "./reconcile.js";

/**
 * Run resolvers in cost order, filling fields until `returns` is satisfied.
 * Outcomes return immediately; incomplete values become LLM context or partial results.
 */
export async function executeLens(
  spec: LensSpec,
  input: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult> {
  let params: Record<string, unknown>;
  try {
    params = resolveParams(spec, input);
  } catch (error) {
    return { kind: "error", message: (error as Error).message };
  }

  let lastMiss = "no resolvers defined";
  let gathered: unknown;
  // Where the tiers that contributed were actually reading. A tier that missed
  // says nothing about the value, so only contributors update it.
  let observed: string | undefined;
  const contributors: Resolver["kind"][] = [];
  for (const resolver of spec.resolve) {
    io.log?.(`trying ${resolver.kind} resolver`);
    let result: LensResult | ResolverMiss;
    switch (resolver.kind) {
      case "intercept":
        result = await runIntercept(resolver, params, io, spec);
        break;
      case "dom":
        result = await runDom(resolver, params, io, spec);
        break;
      case "llm":
        result = await runLlm(resolver, io);
        break;
    }
    if (result.kind === "miss") {
      lastMiss = `${resolver.kind} resolver missed${result.observed ? ` at ${result.observed}` : ""}`;
      io.log?.(lastMiss);
      continue;
    }
    // Outcomes and errors are terminal; agent extraction includes gathered fields.
    if (result.kind !== "value") {
      io.log?.(
        result.kind === "outcome"
          ? `${resolver.kind} resolver returned ${result.name} outcome`
          : `${resolver.kind} resolver returned an error`
      );
      if (result.kind === "outcome" && result.name === "agent_extract" && gathered !== undefined) {
        return {
          ...result,
          value: {
            ...(result.value as Record<string, unknown>),
            gathered: await materialiseLenses(gathered, spec.returns, params, true, spec.helpers, spec.$defs),
          },
        };
      }
      return result;
    }

    gathered =
      isPlainObject(gathered) && isPlainObject(result.value)
        ? fillAbsent(gathered, result.value)
        : result.value;
    contributors.push(resolver.kind);
    observed = result.observed ?? observed;
    io.log?.(`${resolver.kind} resolver contributed a value`);
    // Materialise before testing the contract: a declared $lens ref is supplied
    // by materialisation, not by a resolver, so a value missing only refs is
    // complete. Refs that cannot bind yet stay absent and still fail this.
    const materialised = await materialiseLenses(gathered, spec.returns, params, false, spec.helpers, spec.$defs);
    if (satisfiesReturns(materialised, spec.returns, spec.$defs)) {
      io.log?.("return contract satisfied");
      return {
        kind: "value",
        value: materialised,
        resolver: settledResolver(contributors),
        observed,
      };
    }
  }
  // Mark incomplete results so the host will not cache them.
  if (gathered !== undefined) {
    io.log?.("resolvers exhausted with a partial value");
    return {
      kind: "value",
      value: await materialiseLenses(gathered, spec.returns, params, true, spec.helpers, spec.$defs),
      resolver: settledResolver(contributors),
      partial: true,
      observed,
    };
  }
  io.log?.("all resolvers exhausted without a value");
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

export function resolveParams(
  spec: LensSpec,
  input: Record<string, unknown>
): Record<string, unknown> {
  const declarations = spec.params ?? {};
  for (const key of Object.keys(input)) {
    if (!(key in declarations)) throw new Error(`unknown parameter "${key}" for ${spec.name}`);
  }
  const params: Record<string, unknown> = {};
  for (const [key, declaration] of Object.entries(declarations)) {
    const type = typeof declaration === "string" ? declaration : declaration.type;
    const fallback = typeof declaration === "string" ? undefined : declaration.default;
    const value = Object.hasOwn(input, key) ? input[key] : fallback;
    if (value === undefined) throw new Error(`missing parameter "${key}" for ${spec.name}`);
    if (!matchesParamType(value, type)) {
      throw new Error(`parameter "${key}" for ${spec.name} must be ${type}`);
    }
    const allowed = typeof declaration === "string" ? undefined : declaration.enum;
    if (allowed && !allowed.includes(value as string)) {
      throw new Error(
        `parameter "${key}" for ${spec.name} must be one of: ${allowed.join(", ")}`
      );
    }
    params[key] = value;
  }
  return params;
}

function matchesParamType(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}
