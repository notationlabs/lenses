import type {
  EngineIO,
  InterceptResolver,
  InterceptSource,
  InterceptedResponse,
  LensResult,
  LensSpec,
  MapSpec,
  ResolverMiss,
} from "../types.js";
import { evaluate } from "../expr.js";
import { matchRequestPattern } from "../url-pattern.js";
import { detectOutcome, mergeDetect } from "./outcome.js";

// Normalise a single request as one source; named sources become JSONata variables.
export async function runIntercept(
  r: InterceptResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  spec: LensSpec
): Promise<LensResult | ResolverMiss> {
  const sources = r.sources ?? { body: { request: r.request!, items: r.items } };
  const names = Object.keys(sources);

  let found = await findMatches(sources, io);
  if (found.size < names.length && r.reloadOnMiss && io.reload) {
    await io.reload();
    const deadline = Date.now() + (r.waitMs ?? 8000);
    while (found.size < names.length && Date.now() < deadline) {
      await io.sleep(250);
      found = await findMatches(sources, io);
    }
  }
  if (found.size < names.length) {
    const unmatched = names.filter((n) => !found.has(n)).map((n) => sources[n].request);
    return { kind: "miss", observed: `no response matched ${unmatched.join(", ")}` };
  }

  // Detection sees one response directly or named responses as `$name`.
  const metas: Record<string, unknown> = {};
  for (const n of names) metas[n] = responseContext(found.get(n)!);
  const detect = mergeDetect(spec.detect, r.detect);
  const outcome = r.sources
    ? await detectOutcome(detect, { ...params, ...metas }, { ...params, ...metas }, spec.outcomes, "intercept")
    : await detectOutcome(detect, metas[names[0]], params, spec.outcomes, "intercept");
  if (outcome) return outcome;

  // A 401/302 here is the intercept-tier equivalent of a signed-out redirect.
  for (const n of names) {
    const response = found.get(n)!;
    if (response.status < 200 || response.status >= 300) {
      return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
    }
  }

  const bodies: Record<string, unknown> = {};
  for (const n of names) {
    const parsed = tryParse(found.get(n)!.body);
    const items = sources[n].items;
    bodies[n] = items ? await evaluate(items, parsed, params) : parsed;
  }

  const sourceUrls = names.map((n) => found.get(n)!.url).join(", ");
  // The responses arrived; the expressions drew nothing out of them. Name the
  // responses so this is not confused with a request that never matched.
  const drew: ResolverMiss = { kind: "miss", observed: `no value from ${sourceUrls}` };

  if (r.sources) {
    const vars = { ...params, ...bodies };
    const value = r.map ? await project(r.map, vars, vars) : bodies;
    if (value === undefined || value === null) return drew;
    return { kind: "value", value, resolver: "intercept", observed: sourceUrls };
  }

  // Map array items individually for a single source.
  const working = bodies[names[0]];
  if (working === undefined || working === null) return drew;
  let value: unknown;
  if (r.map && Array.isArray(working)) {
    value = [];
    for (const item of working) (value as unknown[]).push(await project(r.map, item, params));
  } else if (r.map) {
    value = await project(r.map, working, params);
  } else {
    value = working;
  }
  return { kind: "value", value, resolver: "intercept", observed: sourceUrls };
}

/** Evaluate a whole-value or per-field projection. */
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

/** Convert JSONata results to plain data. */
function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(plain) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out as T;
  }
  return value;
}

/** Find the newest response for each source. */
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
