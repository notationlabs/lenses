import type {
  DomResolver,
  EngineIO,
  InterceptResolver,
  InterceptedResponse,
  LensResult,
  LensSpec,
  LlmResolver,
} from "./types.js";
import { evaluate, evaluateBool } from "./expr.js";
import { matchRequestPattern, matchUrl } from "./url-pattern.js";

/**
 * Execute a lens against a target URL. Runs the resolver list in order,
 * cheapest first, falling through on a miss:
 *   intercept (free) -> dom (cheap) -> llm (paid)
 * An outcome detected at any tier returns early.
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
  for (const resolver of spec.resolve) {
    try {
      let result: LensResult | null;
      switch (resolver.kind) {
        case "intercept":
          result = await runIntercept(resolver, params, io);
          break;
        case "dom":
          result = await runDom(resolver, params, io);
          break;
        case "llm":
          result = await runLlm(resolver, spec, params, io);
          break;
      }
      if (result) return result;
      lastMiss = `${resolver.kind} resolver missed`;
    } catch (err) {
      lastMiss = `${resolver.kind} resolver failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { kind: "error", message: `all resolvers exhausted (${lastMiss})` };
}

async function runIntercept(
  r: InterceptResolver,
  params: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult | null> {
  // Write lens: fire the request the page would have made.
  if (r.fire) {
    if (!io.fireRequest) return null;
    const space = r.fire.request.indexOf(" ");
    const method = space === -1 ? "POST" : r.fire.request.slice(0, space);
    const url = interpolate(space === -1 ? r.fire.request : r.fire.request.slice(space + 1), params);
    const body = r.fire.body ? await evaluate(r.fire.body, params, params) : undefined;
    const resp = await io.fireRequest(method, url, body);
    const outcome = await detectOutcome(r.detect, responseContext(resp), params);
    if (outcome) return outcome;
    if (resp.status >= 200 && resp.status < 300) {
      const parsed = tryParse(resp.body);
      const value = r.map ? await evaluate(r.map, parsed, params) : parsed;
      return { kind: "value", value, resolver: "intercept" };
    }
    return null;
  }

  // Read lens: look for a captured response, optionally reloading to trigger one.
  let captured = await findMatch(r, io);
  if (!captured && r.reloadOnMiss && io.reload) {
    await io.reload();
    const deadline = Date.now() + (r.waitMs ?? 8000);
    while (!captured && Date.now() < deadline) {
      await io.sleep(250);
      captured = await findMatch(r, io);
    }
  }
  if (!captured) return null;

  const outcome = await detectOutcome(r.detect, responseContext(captured), params);
  if (outcome) return outcome;
  if (captured.status < 200 || captured.status >= 300) return null;

  let working: unknown = tryParse(captured.body);
  if (r.items) working = await evaluate(r.items, working, params);
  if (working === undefined || working === null) return null;

  let value: unknown;
  if (r.map && Array.isArray(working)) {
    value = [];
    for (const item of working) (value as unknown[]).push(await evaluate(r.map, item, params));
  } else if (r.map) {
    value = await evaluate(r.map, working, params);
  } else {
    value = working;
  }
  return { kind: "value", value, resolver: "intercept" };
}

async function findMatch(r: InterceptResolver, io: EngineIO): Promise<InterceptedResponse | null> {
  const all = await io.getIntercepted();
  for (let i = all.length - 1; i >= 0; i--) {
    if (matchRequestPattern(r.request, all[i].method, all[i].url)) return all[i];
  }
  return null;
}

async function runDom(
  r: DomResolver,
  params: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult | null> {
  const extracted = await io.domExtract(r);
  const outcome = await detectOutcome(r.detect, { url: extracted.url, title: extracted.title }, params);
  if (outcome) return outcome;

  let value = extracted.value;
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0 && !r.actions) return null;
  if (r.post) value = await evaluate(r.post, value, params);
  return { kind: "value", value, resolver: "dom" };
}

async function runLlm(
  r: LlmResolver,
  spec: LensSpec,
  params: Record<string, unknown>,
  io: EngineIO
): Promise<LensResult | null> {
  const snap = await io.snapshot(r.maxSnapshotChars ?? 20000);
  const prompt = [
    r.prompt,
    spec.returns ? `Return JSON matching this shape:\n${JSON.stringify(spec.returns, null, 2)}` : "Return JSON.",
    `Respond with ONLY the JSON value, no prose, no code fences.`,
    `\nPage URL: ${snap.url}\nPage title: ${snap.title}\nPage content:\n${snap.text}`,
  ].join("\n\n");
  let raw: string;
  try {
    raw = await io.llmExtract(prompt);
  } catch (err) {
    // The calling agent doesn't support MCP sampling: hand the snapshot back
    // as a structured outcome so the agent extracts in its own context.
    if (err instanceof Error && err.message === "sampling_unsupported") {
      return {
        kind: "outcome",
        name: "agent_extract",
        value: { url: snap.url, title: snap.title, text: snap.text, returns: spec.returns },
        resolver: "llm",
      };
    }
    throw err;
  }
  const value = tryParse(stripFences(raw));
  if (value === undefined || value === null) return null;
  return { kind: "value", value, resolver: "llm" };
}

async function detectOutcome(
  detect: Record<string, string> | undefined,
  ctx: unknown,
  params: Record<string, unknown>
): Promise<LensResult | null> {
  if (!detect) return null;
  for (const [name, expr] of Object.entries(detect)) {
    if (await evaluateBool(expr, ctx, params)) {
      return { kind: "outcome", name, value: ctx, resolver: "intercept" };
    }
  }
  return null;
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

function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text.trim();
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, k) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`
  );
}
