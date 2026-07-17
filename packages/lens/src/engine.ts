import type {
  DomResolver,
  EngineIO,
  InterceptResolver,
  InterceptSource,
  InterceptedResponse,
  LensResult,
  LensSpec,
  LlmResolver,
  MapSpec,
  Resolver,
} from "./types.js";
import { evaluate, evaluateBool } from "./expr.js";
import { materialiseLenses } from "./materialise.js";
import { matchRequestPattern, matchUrl } from "./url-pattern.js";

/**
 * Execute a lens against a target URL. Runs the resolver list in order,
 * cheapest first: intercept (free) -> dom (cheap) -> llm (paid).
 *
 * Tiers that return an object *reconcile*: each contributes whatever fields it
 * has, later tiers fill only the keys still absent, and the engine stops once
 * every field in `returns` is present. So the intercept tier can hand back
 * {limits, renews_at} and a cheap DOM tier fills the one missing `plan` — no
 * LLM call, no duplicated extraction. Non-object results (e.g. arrays) don't
 * reconcile: the first one wins. An outcome detected at any tier returns early.
 */
export async function executeLens(
  spec: LensSpec,
  targetUrl: string,
  args: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult> {
  const match = matchUrl(spec.accepts, targetUrl);
  if (!match) {
    return {
      kind: "error",
      message: `target ${targetUrl} does not match accepts patterns of ${spec.lens}@v${spec.version}`,
    };
  }
  const params = { ...match.params, ...args, target: targetUrl };

  let lastMiss = "no resolvers defined";
  let acc: Record<string, unknown> | undefined;
  const contributors: Resolver["kind"][] = [];
  for (const resolver of spec.resolve) {
    try {
      let result: LensResult | null;
      switch (resolver.kind) {
        case "intercept":
          result = await runIntercept(resolver, params, io, spec.outcomes);
          break;
        case "dom":
          result = await runDom(resolver, params, io, spec.outcomes);
          break;
        case "llm":
          result = await runLlm(resolver, io);
          break;
      }
      if (!result) {
        lastMiss = `${resolver.kind} resolver missed`;
        continue;
      }
      // Outcomes / errors are terminal — never reconciled. agent_extract
      // additionally carries whatever fields cheaper tiers already gathered,
      // so the agent only has to extract the gap.
      if (result.kind !== "value") {
        if (result.kind === "outcome" && result.name === "agent_extract" && acc && Object.keys(acc).length) {
          return {
            ...result,
            value: {
              ...(result.value as Record<string, unknown>),
              gathered: await materialiseLenses(acc, spec.returns),
            },
          };
        }
        return result;
      }
      // Non-object values (e.g. arrays) don't merge; the first wins.
      if (!isPlainObject(result.value)) {
        if (acc === undefined) {
          return { ...result, value: await materialiseLenses(result.value, spec.returns) };
        }
        continue;
      }
      acc = fillAbsent(acc ?? {}, result.value);
      contributors.push(resolver.kind);
      if (isComplete(acc, spec.returns)) {
        return {
          kind: "value",
          value: await materialiseLenses(acc, spec.returns),
          resolver: settledResolver(contributors),
        };
      }
    } catch (err) {
      lastMiss = `${resolver.kind} resolver failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Ran out of tiers without completing the declared shape: return what we
  // gathered, but flag it partial so the host won't cache a degraded result.
  if (acc && Object.keys(acc).length) {
    return {
      kind: "value",
      value: await materialiseLenses(acc, spec.returns),
      resolver: settledResolver(contributors),
      partial: true,
    };
  }
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Copy `incoming` fields into `acc`, but only where `acc` lacks them. */
function fillAbsent(
  acc: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...acc };
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in out) || out[k] === undefined) out[k] = v;
  }
  return out;
}

/**
 * A reconciliation is complete once every top-level field declared in `returns`
 * is present. Absent `returns` (or no field map) means there's no completeness
 * to assess, so the first contribution suffices — preserving single-tier lenses.
 * Only top-level keys are checked: an empty `limits: []` is still "present".
 */
function isComplete(acc: Record<string, unknown>, returns: unknown): boolean {
  const fields = (returns as { fields?: unknown } | undefined)?.fields;
  if (!isPlainObject(fields)) return true;
  return Object.keys(fields).every((k) => k in acc && acc[k] !== undefined);
}

function settledResolver(contributors: Resolver["kind"][]): Resolver["kind"] | "reconciled" {
  return contributors.length > 1 ? "reconciled" : contributors[0];
}

/**
 * Intercept tier. Two forms share one path: a single `request` is normalised
 * into one anonymous source, then capture-matching, the reload-and-wait loop,
 * `detect`, and the 2xx check are common. They part only at projection —
 * multi-source binds each body as a JSONata variable ($name) so `map` can
 * join across responses; single-source maps over the body itself.
 */
async function runIntercept(
  r: InterceptResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  outcomes: LensSpec["outcomes"]
): Promise<LensResult | null> {
  const sources = r.sources ?? { body: { request: r.request!, items: r.items } };
  const names = Object.keys(sources);

  // Look for the captured responses, optionally reloading to trigger them.
  // Every source must be captured, or the tier misses as a whole.
  let found = await findMatches(sources, io);
  if (found.size < names.length && r.reloadOnMiss && io.reload) {
    await io.reload();
    const deadline = Date.now() + (r.waitMs ?? 8000);
    while (found.size < names.length && Date.now() < deadline) {
      await io.sleep(250);
      found = await findMatches(sources, io);
    }
  }
  if (found.size < names.length) return null;

  // detect: single-source sees {status, url, body} bare; multi-source sees
  // each response bound as $name (`$usage.status = 401`).
  const metas: Record<string, unknown> = {};
  for (const n of names) metas[n] = responseContext(found.get(n)!);
  const outcome = r.sources
    ? await detectOutcome(r.detect, { ...params, ...metas }, { ...params, ...metas }, outcomes, "intercept")
    : await detectOutcome(r.detect, metas[names[0]], params, outcomes, "intercept");
  if (outcome) return outcome;

  // any non-2xx response is a tier miss
  for (const n of names) {
    const status = found.get(n)!.status;
    if (status < 200 || status >= 300) return null;
  }

  // parse each body and apply its `items` narrowing
  const bodies: Record<string, unknown> = {};
  for (const n of names) {
    const parsed = tryParse(found.get(n)!.body);
    const items = sources[n].items;
    bodies[n] = items ? await evaluate(items, parsed, params) : parsed;
  }

  // multi-source: bodies become $name variables; `map` draws from any of them
  if (r.sources) {
    const vars = { ...params, ...bodies };
    const value = r.map ? await project(r.map, vars, vars) : bodies;
    if (value === undefined || value === null) return null;
    return { kind: "value", value, resolver: "intercept" };
  }

  // single-source: the body is the working value; `map` runs per item on arrays
  const working = bodies[names[0]];
  if (working === undefined || working === null) return null;
  let value: unknown;
  if (r.map && Array.isArray(working)) {
    value = [];
    for (const item of working) (value as unknown[]).push(await project(r.map, item, params));
  } else if (r.map) {
    value = await project(r.map, working, params);
  } else {
    value = working;
  }
  return { kind: "value", value, resolver: "intercept" };
}

/** Evaluate a map projection — a single expression, or per-field object. */
async function project(
  map: MapSpec,
  data: unknown,
  params: Record<string, unknown>
): Promise<unknown> {
  if (typeof map === "string") return plain(await evaluate(map, data, params));
  const out: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(map)) out[field] = plain(await evaluate(expr, data, params));
  return out;
}

/**
 * Strip JSONata's internal array markers (e.g. the non-enumerable `sequence`
 * flag on constructed arrays) so results are plain data — what the host
 * serializes and what structural comparisons expect.
 */
function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(plain) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out as T;
  }
  return value;
}

/** Newest captured response per source, keyed by source name. */
async function findMatches(
  sources: Record<string, InterceptSource>,
  io: EngineIO
): Promise<Map<string, InterceptedResponse>> {
  const all = await io.getIntercepted();
  const out = new Map<string, InterceptedResponse>();
  for (const [name, src] of Object.entries(sources)) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (matchRequestPattern(src.request, all[i].method, all[i].url)) {
        out.set(name, all[i]);
        break;
      }
    }
  }
  return out;
}

async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  outcomes: LensSpec["outcomes"]
): Promise<LensResult | null> {
  const extracted = await io.domExtract(r);
  const outcome = await detectOutcome(r.detect, { url: extracted.url, title: extracted.title }, params, outcomes, "dom");
  if (outcome) return outcome;

  let value = extracted.value;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (r.post) value = await evaluate(r.post, value, params);
  return { kind: "value", value, resolver: "dom" };
}

async function runLlm(r: LlmResolver, io: EngineIO): Promise<LensResult> {
  // The calling agent is itself a model, so extraction is handed back to it:
  // the lens author's prompt plus the page snapshot. No schema — structure
  // only pays for itself when the host consumes the result (cache, reconcile,
  // materialise refs), and this path bypasses all of that.
  const snap = await io.snapshot(r.maxSnapshotChars ?? 20000);
  return {
    kind: "outcome",
    name: "agent_extract",
    value: { prompt: r.prompt, url: snap.url, title: snap.title, text: snap.text },
    resolver: "llm",
  };
}

async function detectOutcome(
  detect: Record<string, string> | undefined,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"],
  resolver: Resolver["kind"]
): Promise<LensResult | null> {
  if (!detect) return null;
  for (const [name, expr] of Object.entries(detect)) {
    if (await evaluateBool(expr, ctx, params)) {
      const value = await outcomeValue(name, ctx, params, outcomes);
      return { kind: "outcome", name, value, resolver };
    }
  }
  return null;
}

/**
 * "Results are lenses too" for failure modes: when the fired outcome is declared
 * in `spec.outcomes` as a `$lens` reference, hand back a *callable ref* with its
 * `target` bound (declared JSONata evaluated against the detect ctx, else the
 * original target URL) plus any extra declared fields (e.g. `hint`). A `null` or
 * plain-schema outcome keeps returning the raw detect ctx for back-compat.
 */
async function outcomeValue(
  name: string,
  ctx: unknown,
  params: Record<string, unknown>,
  outcomes: LensSpec["outcomes"]
): Promise<unknown> {
  const declared = outcomes?.[name];
  if (isPlainObject(declared) && typeof declared.$lens === "string") {
    const { $lens, target: targetExpr, ...rest } = declared;
    const target =
      typeof targetExpr === "string" ? await evaluate(targetExpr, ctx, params) : params.target;
    return { $lens, target, ...rest };
  }
  return ctx;
}

function responseContext(resp: InterceptedResponse) {
  return { status: resp.status, url: resp.url, body: tryParse(resp.body) };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
