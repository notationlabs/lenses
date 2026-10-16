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
import { evaluate, type ExprVars } from "../expr.js";
import { expandRequestPattern, matchRequestPattern } from "../url-pattern.js";
import { matchPageException, matchTierException } from "./outcome.js";

// Normalise a single request as one source; named sources are bound as `$sources`.
export async function runIntercept(
  r: InterceptResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  spec: LensSpec
): Promise<LensResult | ResolverMiss> {
  // Request patterns take the same {params.name} holes as the lens URL and selectors,
  // so a capture is matched to the account (or item) this call asked about.
  // Values are percent-encoded as in the URL, since they meet encoded request
  // URLs; see expandRequestPattern for `*`.
  const sources = Object.fromEntries(
    Object.entries(r.sources ?? { body: { request: r.request!, items: r.items } }).map(
      ([name, source]) => [
        name,
        { ...source, request: { ...source.request, url: expandRequestPattern(source.request.url, params) } },
      ]
    )
  );
  const names = Object.keys(sources);

  let found = await findMatches(sources, io);
  let detected = await matchCaptured(found, r, spec, params);
  if (detected) return detected;
  if (found.size < names.length && r.reloadOnMiss && io.reload) {
    await io.reload();
  }
  // `waitMs` is also a capture window after perform. Perform deliberately
  // binds with reuse, so requiring reloadOnMiss here would miss requests the
  // action just triggered. EngineIO.sleep lets browser hosts turn each poll
  // into a cursor long-poll while simple hosts may use an ordinary delay.
  if (found.size < names.length && (r.reloadOnMiss || r.waitMs !== undefined)) {
    const deadline = Date.now() + (r.waitMs ?? 8000);
    while (found.size < names.length && Date.now() < deadline) {
      await io.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      found = await findMatches(sources, io);
      detected = await matchCaptured(found, r, spec, params);
      if (detected) return detected;
    }
  }
  if (found.size < names.length) {
    const unmatched = names
      .filter((n) => !found.has(n))
      .map((n) => `${sources[n].request.method.toUpperCase()} ${sources[n].request.url}`);
    return { kind: "miss", observed: `no response matched ${unmatched.join(", ")}` };
  }

  // A 401/302 here is the intercept-tier equivalent of a signed-out redirect.
  for (const n of names) {
    const response = found.get(n)!;
    if (response.status < 200 || response.status >= 300) {
      return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
    }
  }

  const bodies: Record<string, unknown> = {};
  const replies: Record<string, unknown> = {};
  for (const n of names) {
    const reply = responseContext(found.get(n)!);
    const items = sources[n].items;
    bodies[n] = items ? await evaluate(items, { res: reply, params }, spec.helpers) : reply.body;
    replies[n] = { ...reply, body: bodies[n] };
  }

  const sourceUrls = names.map((n) => found.get(n)!.url).join(", ");
  // The responses arrived; the expressions drew nothing out of them. Name the
  // responses so this is not confused with a request that never matched.
  const drew: ResolverMiss = { kind: "miss", observed: `no value from ${sourceUrls}` };

  if (r.sources) {
    const value = r.map ? await project(r.map, { sources: replies, params }, spec.helpers) : bodies;
    if (value === undefined || value === null) return drew;
    return { kind: "value", value, resolver: "intercept", observed: sourceUrls };
  }

  const working = bodies[names[0]];
  if (working === undefined || working === null) return drew;
  const value = await shapeReply(r, responseContext(found.get(names[0])!), working, params, spec.helpers);
  return { kind: "value", value, resolver: "intercept", observed: sourceUrls };
}

/**
 * Shape a single-request reply. With `items`, `map` runs once per selected
 * row as `$item` (once, on the value itself, when `items` selects one value);
 * without `items` it runs once over the whole reply. `$res` is the reply,
 * `{status, url, body}`, throughout.
 */
export async function shapeReply(
  r: { items?: string; map?: MapSpec },
  res: unknown,
  working: unknown,
  params: Record<string, unknown>,
  helpers: Record<string, string> | undefined
): Promise<unknown> {
  if (!r.map) return working;
  if (r.items === undefined) return project(r.map, { res, params }, helpers);
  if (!Array.isArray(working)) return project(r.map, { item: working, res, params }, helpers);
  const rows: unknown[] = [];
  for (const item of working) rows.push(await project(r.map, { item, res, params }, helpers));
  return rows;
}

/** Detect against captured evidence even when other sources have not arrived yet. */
async function matchCaptured(
  found: Map<string, InterceptedResponse>,
  r: InterceptResolver,
  spec: LensSpec,
  params: Record<string, unknown>
): Promise<LensResult | null> {
  if (!found.size) return null;
  const metas = Object.fromEntries([...found].map(([name, response]) => [name, responseContext(response)]));
  const tier = await matchTierException(spec, r.exceptions,
    r.sources ? { ...params, ...metas } : metas.body,
    r.sources ? { sources: metas, params } : { res: metas.body, params }, "intercept");
  if (tier) return tier;
  for (const meta of Object.values(metas)) {
    const page = await matchPageException(spec, meta, { res: meta, params }, "intercept", r.exceptions);
    if (page) return page;
  }
  return null;
}

/**
 * Evaluate a whole-value or per-field projection. An object map builds the
 * same object a JSONata constructor would: nested objects recurse, and a
 * field whose expression yields nothing is left out.
 */
export async function project(
  map: MapSpec,
  vars: ExprVars,
  helpers: Record<string, string> | undefined
): Promise<unknown> {
  if (typeof map === "string") return plain(await evaluate(map, vars, helpers));
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(map)) {
    const value = await project(spec, vars, helpers);
    if (value !== undefined) out[field] = value;
  }
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

export function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
