import type {
  EngineIO,
  HttpResolver,
  LensResult,
  LensSpec,
  ResolverMiss,
} from "../types.js";
import { evaluate } from "../expr.js";
import { expandTemplate, expandUrl } from "../url-pattern.js";
import { detectOutcome, mergeDetect } from "./outcome.js";
import { project, tryParse } from "./intercept.js";

/**
 * Run the tier's request (or its chain of `sources`) through the host and
 * shape the bodies like the matching intercept form.
 */
export async function runHttp(
  r: HttpResolver,
  params: Record<string, unknown>,
  io: EngineIO,
  spec: LensSpec
): Promise<LensResult | ResolverMiss> {
  if (!io.httpFetch) {
    return { kind: "miss", observed: "host cannot perform http requests" };
  }
  const detect = mergeDetect(spec.detect, r.detect);
  const fetchOne = async (pattern: string, holes: Record<string, unknown>) => {
    const space = pattern.indexOf(" ");
    const method = space === -1 ? "GET" : pattern.slice(0, space).toUpperCase();
    const url = expandUrl(
      expandDottedHoles(space === -1 ? pattern : pattern.slice(space + 1), holes),
      holes
    );
    const headers = r.headers
      ? Object.fromEntries(
          Object.entries(r.headers).map(([name, value]) => [name, expandTemplate(value, holes)])
        )
      : undefined;
    return io.httpFetch!({ method, url, headers, credentials: r.credentials ?? false });
  };

  if (r.sources) {
    const bodies: Record<string, unknown> = {};
    const metas: Record<string, unknown> = {};
    // Scalars bound so far fill the next request's holes alongside params.
    const holes: Record<string, unknown> = { ...params };
    for (const [name, source] of Object.entries(r.sources)) {
      let response;
      try {
        response = await fetchOne(source.request, holes);
      } catch (error) {
        return { kind: "miss", observed: failure(error) };
      }
      if (!response) return unsupported(r);
      metas[name] = { status: response.status, url: response.url, body: tryParse(response.body) };
      // Detection sees the responses so far; an unfetched $name is just absent.
      const outcome = await detectOutcome(
        detect,
        { ...params, ...metas },
        { ...params, ...metas },
        spec.outcomes,
        "http",
        spec.helpers
      );
      if (outcome) return outcome;
      if (response.status < 200 || response.status >= 300) {
        return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
      }
      const parsed = tryParse(response.body);
      const bound = source.items
        ? await evaluate(source.items, parsed, { ...params, ...bodies }, spec.helpers)
        : parsed;
      if (bound === undefined || bound === null) {
        return { kind: "miss", observed: `no value from ${response.url}` };
      }
      bodies[name] = bound;
      holes[name] = bound;
    }
    const vars = { ...params, ...bodies };
    const sourceUrls = Object.values(metas)
      .map((meta) => (meta as { url: string }).url)
      .join(", ");
    const value = r.map ? await project(r.map, vars, vars, spec.helpers) : bodies;
    if (value === undefined || value === null) {
      return { kind: "miss", observed: `no value from ${sourceUrls}` };
    }
    return { kind: "value", value, resolver: "http", observed: sourceUrls };
  }

  let response;
  try {
    response = await fetchOne(r.request ?? spec.url, params);
  } catch (error) {
    // A network failure is this tier's miss, not the call's: the page tiers
    // reach the same site through the browser and may still succeed.
    return { kind: "miss", observed: failure(error) };
  }
  if (!response) return unsupported(r);

  const context = { status: response.status, url: response.url, body: tryParse(response.body) };
  const outcome = await detectOutcome(detect, context, params, spec.outcomes, "http", spec.helpers);
  if (outcome) return outcome;
  if (response.status < 200 || response.status >= 300) {
    return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
  }

  const working = r.items ? await evaluate(r.items, context.body, params, spec.helpers) : context.body;
  const drew: ResolverMiss = { kind: "miss", observed: `no value from ${response.url}` };
  if (working === undefined || working === null) return drew;
  let value: unknown;
  if (r.map && Array.isArray(working)) {
    value = [];
    for (const item of working) (value as unknown[]).push(await project(r.map, item, params, spec.helpers));
  } else if (r.map) {
    value = await project(r.map, working, params, spec.helpers);
  } else {
    value = working;
  }
  if (value === undefined || value === null) return drew;
  return { kind: "value", value, resolver: "http", observed: response.url };
}

const DOTTED_HOLE = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)\}/g;

/**
 * Fill `{name.path.to.value}` holes from object-typed bindings, so a chained
 * request can address into an earlier response — `{orgs.0.uuid}` — without
 * that source having to reduce itself to one scalar.
 */
function expandDottedHoles(template: string, holes: Record<string, unknown>): string {
  return template.replace(DOTTED_HOLE, (_, path: string) => {
    let value: unknown = holes;
    for (const segment of path.split(".")) {
      if (value === null || typeof value !== "object") value = undefined;
      else value = (value as Record<string, unknown>)[segment];
    }
    if (value === undefined || value === null || typeof value === "object") {
      throw new Error(`hole "{${path}}" did not resolve to a scalar`);
    }
    return encodeURIComponent(String(value));
  });
}

function failure(error: unknown): string {
  return `http request failed: ${error instanceof Error ? error.message : String(error)}`;
}

function unsupported(r: HttpResolver): ResolverMiss {
  return {
    kind: "miss",
    observed: r.credentials
      ? "host cannot perform credentialed http requests"
      : "host cannot perform http requests",
  };
}
