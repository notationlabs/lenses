import type {
  EngineIO,
  HttpBody,
  HttpFetchBody,
  HttpResolver,
  LensResult,
  LensSpec,
  RequestSpec,
  ResolverMiss,
} from "../types.js";
import { evaluate, type ExprVars } from "../expr.js";
import { expandTemplate, expandUrl } from "../url-pattern.js";
import { matchPageException, matchTierException } from "./outcome.js";
import { project, shapeReply, tryParse } from "./intercept.js";

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
  // `sources` is the replies bound so far in a chain ({status, url, body},
  // body after the source's `items`), undefined for a single request; it fills
  // `{sources.…}` holes in URLs and headers, and `$sources` in bodies.
  const fetchOne = async (
    request: RequestSpec,
    sources: Record<string, unknown> | undefined,
    bodySpec?: HttpBody,
    credentials = r.credentials ?? false,
    sourceHeaders?: Record<string, string>
  ) => {
    const method = request.method.toUpperCase();
    const url = expandUrl(request.url, params, sources);
    const vars: ExprVars = sources ? { params, sources } : { params };
    const headers: Record<string, string> = r.headers
      ? Object.fromEntries(
          Object.entries(r.headers).map(([name, value]) => [name, expandTemplate(value, params)])
        )
      : {};
    for (const [name, value] of Object.entries(sourceHeaders ?? {})) {
      headers[name] = expandTemplate(value, params, sources);
    }
    const body = bodySpec
      ? await materialiseBody(bodySpec, vars, spec.helpers)
      : undefined;
    try {
      return await io.httpFetch!({
        method,
        url,
        headers: Object.keys(headers).length ? headers : undefined,
        ...(body ? { body } : {}),
        credentials,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error &&
          error.code === "required_backend_unavailable") {
        throw error;
      }
      const ambiguous = new Error(error instanceof Error ? error.message : String(error)) as Error & {
        transmissionAmbiguous: true;
      };
      ambiguous.transmissionAmbiguous = true;
      throw ambiguous;
    }
  };

  if (r.sources) {
    const bodies: Record<string, unknown> = {};
    const metas: Record<string, { status: number; url: string; body: unknown }> = {};
    const replies: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(r.sources)) {
      let response;
      try {
        response = await fetchOne(
          source.request,
          { ...replies },
          source.body,
          source.credentials ?? r.credentials ?? false,
          source.headers
        );
      } catch (error) {
        const fatal = requestFailure(error, source.request, spec.effects.idempotent === true);
        if (fatal) return fatal;
        return { kind: "miss", observed: failure(error) };
      }
      if (!response) return unsupported(r);
      metas[name] = { status: response.status, url: response.url, body: tryParse(response.body) };
      // Check the arriving response before requesting the next source.
      const tier = await matchTierException(
        spec, r.exceptions, { ...params, ...metas }, { sources: { ...metas }, params }, "http"
      );
      if (tier) return tier;
      const page = await matchPageException(spec, metas[name], { res: metas[name], params }, "http", r.exceptions);
      if (page) return page;
      if (response.status < 200 || response.status >= 300) {
        return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
      }
      const bound = source.items
        ? await evaluate(source.items, { res: metas[name], params, sources: { ...replies } }, spec.helpers)
        : metas[name].body;
      if (bound === undefined || bound === null) {
        return { kind: "miss", observed: `no value from ${response.url}` };
      }
      bodies[name] = bound;
      replies[name] = { ...metas[name], body: bound };
    }
    const sourceUrls = Object.values(metas)
      .map((meta) => meta.url)
      .join(", ");
    const value = r.map ? await project(r.map, { sources: replies, params }, spec.helpers) : bodies;
    if (value === undefined || value === null) {
      return { kind: "miss", observed: `no value from ${sourceUrls}` };
    }
    return { kind: "value", value, resolver: "http", observed: sourceUrls };
  }

  let response;
  try {
    response = await fetchOne(r.request ?? { method: "GET", url: spec.url }, undefined, r.body);
  } catch (error) {
    const fatal = requestFailure(error, r.request, spec.effects.idempotent === true);
    if (fatal) return fatal;
    // Read-only and explicitly idempotent requests may still miss into another tier.
    return { kind: "miss", observed: failure(error) };
  }
  if (!response) return unsupported(r);

  const context = { status: response.status, url: response.url, body: tryParse(response.body) };
  const outcome = await matchTierException(spec, r.exceptions, context, { res: context, params }, "http")
    ?? await matchPageException(spec, context, { res: context, params }, "http", r.exceptions);
  if (outcome) return outcome;
  if (response.status < 200 || response.status >= 300) {
    return { kind: "miss", observed: `HTTP ${response.status} from ${response.url}` };
  }

  const working = r.items
    ? await evaluate(r.items, { res: context, params }, spec.helpers)
    : context.body;
  const drew: ResolverMiss = { kind: "miss", observed: `no value from ${response.url}` };
  if (working === undefined || working === null) return drew;
  const value = await shapeReply(r, context, working, params, spec.helpers);
  if (value === undefined || value === null) return drew;
  return { kind: "value", value, resolver: "http", observed: response.url };
}

async function materialiseBody(
  body: HttpBody,
  vars: ExprVars,
  helpers: Record<string, string> = {}
): Promise<HttpFetchBody> {
  if ("json" in body) {
    const value = await evaluate(body.json, vars, helpers);
    if (value === undefined) throw new Error("json request body expression produced no result");
    return { kind: "json", value: JSON.stringify(value) };
  }
  if ("text" in body) {
    const value = await evaluate(body.text, vars, helpers);
    if (value === undefined) throw new Error("text request body expression produced no result");
    return { kind: "text", value: String(value) };
  }
  const kind = "form" in body ? "form" : "search";
  const fields = "form" in body ? body.form : body.search;
  const entries: [string, string][] = [];
  for (const [name, expression] of Object.entries(fields)) {
    const value = await evaluate(expression, vars, helpers);
    if (value === undefined) throw new Error(`${kind} request body field "${name}" produced no result`);
    const valuesForField = Array.isArray(value) ? value : [value];
    for (const item of valuesForField) {
      if (item !== null && typeof item === "object") {
        throw new Error(`${kind} request body field "${name}" must be scalar or an array of scalars`);
      }
      entries.push([name, item === null ? "" : String(item)]);
    }
  }
  return { kind, entries };
}

function failure(error: unknown): string {
  return `http request failed: ${error instanceof Error ? error.message : String(error)}`;
}

function requestFailure(
  error: unknown,
  request: RequestSpec | undefined,
  idempotent: boolean
): Extract<LensResult, { kind: "error" }> | undefined {
  if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "required_backend_unavailable") {
    return {
      kind: "error",
      code: "required_backend_unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const method = (request?.method ?? "GET").toUpperCase();
  const ambiguous = typeof error === "object" && error !== null &&
    "transmissionAmbiguous" in error && error.transmissionAmbiguous === true;
  if (!ambiguous || ["GET", "HEAD", "OPTIONS"].includes(method) || idempotent) return undefined;
  return {
    kind: "error",
    message: `HTTP ${method} request failed after transmission became ambiguous; refusing to retry through another resolver: ${error instanceof Error ? error.message : String(error)}`,
    mutation: {
      performStarted: true,
      submissionMayHaveHappened: true,
      performed: "unknown",
    },
  };
}

function unsupported(r: HttpResolver): ResolverMiss {
  return {
    kind: "miss",
    observed: r.credentials
      ? "host cannot perform credentialed http requests"
      : "host cannot perform http requests",
  };
}
