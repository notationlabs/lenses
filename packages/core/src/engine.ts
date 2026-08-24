import type {
  EngineIO,
  LensParam,
  LensResult,
  LensSpec,
  ParamLensDefault,
  PerformStep,
  Resolver,
  ResolverMiss,
} from "./types.js";
import { evaluate } from "./expr.js";
import { materialiseLenses } from "./materialise.js";
import { detectOutcome } from "./resolvers/outcome.js";
import { runHttp } from "./resolvers/http.js";
import { runIntercept } from "./resolvers/intercept.js";
import { runDom } from "./resolvers/dom.js";
import { runLlm } from "./resolvers/llm.js";
import { isPlainObject } from "./util.js";
import { fillAbsent, satisfiesReturns } from "./reconcile.js";
import { expandTemplate } from "./url-pattern.js";

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

  // Perform runs before any tier: a step failure aborts the call before the
  // walk, and a document with steps never takes an http-only path. When every
  // step ran, the result carries `performed: true` so the caller knows the
  // write happened even if reading the result back failed.
  if (spec.perform) {
    const aborted = await runPerform(spec, spec.perform, params, io);
    if (aborted) return aborted;
    return { ...(await resolveTiers(spec, params, io)), performed: true };
  }
  return resolveTiers(spec, params, io);
}

/**
 * Run the document's perform steps. Returns the result that ends the call (a
 * detect hit or a step failure), or null when every step succeeded.
 */
async function runPerform(
  spec: LensSpec,
  perform: PerformStep[],
  params: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult | null> {
  if (!io.perform) return { kind: "error", message: "host cannot perform actions" };
  // Before step 0, run the document's detect on {url, title}: the page may be
  // a login wall no step should touch. An empty dom extraction is the
  // cheapest way to read url/title.
  if (spec.detect) {
    const { url, title } = await io.domExtract({ kind: "dom" });
    const outcome = await detectOutcome(spec.detect, { url, title }, params, spec.outcomes, "dom", spec.helpers);
    if (outcome) return outcome;
  }
  // Expressions are the document's trust boundary: they resolve here, so a
  // host only ever receives literal strings.
  const steps: PerformStep[] = [];
  // An empty declarative value is already the empty literal; JSONata otherwise
  // treats an empty source string as a syntax error. This applies equally to
  // fill values and native form fields.
  const performValue = (expr: string) =>
    expr === "" ? Promise.resolve("") : evaluate(expr, params, params, spec.helpers);
  for (const step of perform) {
    if ("fill" in step) {
      const value = await performValue(step.value);
      if (value === undefined) {
        return { kind: "error", message: `perform fill value "${step.value}" produced nothing` };
      }
      steps.push({ fill: expandTemplate(step.fill, params), value: String(value) });
    } else if ("click" in step) {
      steps.push({ click: expandTemplate(step.click, params) });
    } else if ("submit" in step) {
      const form: Record<string, string> = {};
      for (const [name, expr] of Object.entries(step.form ?? {})) {
        const value = await performValue(expr);
        if (value === undefined) {
          return {
            kind: "error",
            message: `perform submit field "${name}" value "${expr}" produced nothing`,
          };
        }
        // Field names are caller-facing HTML names and may be "__proto__";
        // define an own data property rather than invoking Object.prototype's setter.
        Object.defineProperty(form, name, {
          value: String(value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      steps.push({
        submit: expandTemplate(step.submit, params),
        ...(step.form !== undefined ? { form } : {}),
      });
    } else if ("wait" in step) {
      const wait = step.wait;
      steps.push({
        wait: {
          ...(wait.appears !== undefined
            ? { appears: expandTemplate(wait.appears, params) }
            : wait.gone !== undefined
              ? { gone: expandTemplate(wait.gone, params) }
              : { increases: expandTemplate(wait.increases!, params) }),
          ...(wait.timeoutMs !== undefined ? { timeoutMs: wait.timeoutMs } : {}),
        },
      });
    } else {
      steps.push(step);
    }
  }
  io.log?.(`performing ${steps.length} step${steps.length === 1 ? "" : "s"}`);
  const result = await io.perform(steps);
  if (result.failedStep === undefined) {
    io.log?.("perform completed");
    return null;
  }
  // A wait that times out on a login wall is not a broken selector: the
  // document's detect gets to name the landed page before perform_failed does.
  const detected = await detectOutcome(
    spec.detect,
    { url: result.url, title: result.title },
    params,
    spec.outcomes,
    "dom",
    spec.helpers
  );
  if (detected) return detected;
  io.log?.(`perform failed at step ${result.failedStep}`);
  return {
    kind: "error",
    code: "perform_failed",
    step: result.failedStep,
    message: result.message ?? `perform step ${result.failedStep} failed`,
  };
}

/** Run resolvers in cost order, filling fields until `returns` is satisfied. */
async function resolveTiers(
  spec: LensSpec,
  params: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult> {
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
      case "http":
        result = await runHttp(resolver, params, io, spec);
        break;
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
    // A {$lens} default is resolved by the host before execution; reaching the
    // engine with one still unresolved is a host bug, not a missing input.
    if (!Object.hasOwn(input, key) && paramLensDefault(declaration)) {
      throw new Error(`unresolved parameter default "${key}" for ${spec.name}`);
    }
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

/** The {$lens, field, params?} default of a declaration, when it has one. */
export function paramLensDefault(
  declaration: LensParam | undefined
): ParamLensDefault | undefined {
  if (declaration === undefined || typeof declaration === "string") return undefined;
  const fallback = declaration.default;
  return typeof fallback === "object" && fallback !== null ? fallback : undefined;
}

function matchesParamType(value: unknown, type: string): boolean {
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}
