#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { resolve } from "node:path";
import { matchUrl } from "@actors/lens";
import type { LensResult, LensSpec } from "@actors/lens";
import { Bridge } from "./bridge.js";
import { LensStore } from "./lens-store.js";
import { registerHost } from "./registry.js";

const PORT_RANGE_START = 4319;
const PORT_RANGE_END = 4329;
const PINNED_PORT = process.env.LENS_BRIDGE_PORT ? Number(process.env.LENS_BRIDGE_PORT) : null;
const LENS_DIR = resolve(process.env.LENS_DIR ?? "lenses");
const ALLOW_WRITES = process.env.LENS_ALLOW_WRITES === "1";

const store = new LensStore(LENS_DIR);
let bridge: Bridge;

interface CacheEntry {
  result: LensResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(spec: LensSpec, target: string, args: Record<string, unknown>) {
  return `${spec.lens}@v${spec.version}|${target}|${JSON.stringify(args)}`;
}

const server = new McpServer({ name: "lens-host", version: "0.1.0" });

server.registerTool(
  "lens_list",
  {
    description:
      "List the lenses available to call. A lens turns a webpage in the user's own browser into a typed, callable function.",
  },
  async () => {
    const lenses = await store.loadLocal();
    const listing = lenses.map((l) => ({
      lens: `${l.lens}@v${l.version}`,
      description: l.description,
      accepts: l.accepts,
      effects: l.effects,
      outcomes: l.outcomes ? Object.keys(l.outcomes) : [],
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ bridge: bridge.info, lenses: listing }, null, 2) }],
    };
  }
);

server.registerTool(
  "lens_call",
  {
    description: [
      "Call a lens against a target URL in the user's browser (their own logged-in session).",
      "`lens` is a name from lens_list (e.g. \"hn/top\"), a path, or an https URL to a lens JSON spec.",
      "Returns {kind:'value'} on success, {kind:'outcome'} for structured conditions, or {kind:'error'}.",
      "Outcome 'needs_auth': ask the user to log in in the open tab, then retry the same call.",
      "Outcome 'agent_extract': your client doesn't support MCP sampling, so the raw page snapshot is in",
      "value.text — extract the data yourself, matching the shape in value.returns, and answer from that.",
      "Results are lenses too: any value or outcome containing {\"$lens\": <name>, \"target\": <url>}",
      "is a callable reference — feed it straight back with lens_call({lens: <$lens>, target: <target>})",
      "to follow it (e.g. a story's item_url, a next_page link, or a 'needs_auth' login lens).",
    ].join(" "),
    inputSchema: z.object({
      lens: z.string().describe("lens name, file path, or URL of the lens spec"),
      target: z.string().url().describe("the page URL to act on"),
      args: z.record(z.string(), z.unknown()).optional().describe("extra arguments for the lens"),
    }),
  },
  async ({ lens, target, args }, ctx) => {
    const spec = await store.resolveRef(lens);
    const callArgs = args ?? {};

    if (!matchUrl(spec.accepts, target)) {
      return errorResult(
        `target ${target} does not match ${spec.lens}@v${spec.version} accepts patterns: ${spec.accepts.join(", ")}`
      );
    }

    if (spec.effects.writes.length > 0 && !ALLOW_WRITES) {
      return errorResult(
        `lens ${spec.lens}@v${spec.version} declares writes (${spec.effects.writes.join(", ")}). ` +
          `Write lenses are disabled by default; start lens-host with LENS_ALLOW_WRITES=1 after confirming with the user.`
      );
    }

    const key = cacheKey(spec, target, callArgs);
    const ttl = (spec.effects.cache ?? 0) * 1000;
    const hit = cache.get(key);
    if (ttl > 0 && hit && hit.expiresAt > Date.now()) {
      return okResult({ ...hit.result, cached: true });
    }

    // The LLM resolver tier is served by the *calling agent's* model via MCP
    // sampling — the product never holds an API key.
    const sampler = async (prompt: string): Promise<string> => {
      let res;
      try {
        res = await ctx.mcpReq.requestSampling({
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          maxTokens: 4000,
        });
      } catch (err) {
        // JSON-RPC -32601: the client (e.g. Claude Code) doesn't support sampling.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Method not found") || msg.includes("-32601")) {
          throw new Error("sampling_unsupported");
        }
        throw err;
      }
      const content = res.content as { type: string; text?: string };
      if (content.type === "text" && content.text) return content.text;
      throw new Error("sampling returned non-text content");
    };

    const result = await bridge.call(spec, target, callArgs, sampler);
    // Only cache a value that fully satisfied the declared `returns` shape — a
    // `partial` reconciliation (e.g. intercept flaked, only the dom tier's
    // `plan` came back) must not be replayed for the whole TTL and mask the
    // recovered cheaper tier on the next call.
    if (result.kind === "value" && !result.partial && ttl > 0) {
      cache.set(key, { result, expiresAt: Date.now() + ttl });
    }
    return result.kind === "error" ? errorResult(result.message) : okResult(result);
  }
);

server.registerTool(
  "lens_observe",
  {
    description: [
      "Observe a page in the user's browser to author a new lens: loads the target URL and returns",
      "the JSON API requests the page made (method, url, status, body preview) plus a text snapshot.",
      "Workflow: observe the page, then write a lens spec JSON file (resolve tiers: intercept for the",
      "API calls you saw, llm as fallback; map/detect/items are JSONata) and call it immediately by",
      "passing its file path to lens_call. Save reusable lenses under the lenses/ directory.",
    ].join(" "),
    inputSchema: z.object({
      target: z.string().url().describe("the page URL to observe"),
      waitMs: z.number().optional().describe("extra time to wait for the page's requests (default 4000)"),
    }),
  },
  async ({ target, waitMs }) => {
    const result = await bridge.observe(target, waitMs);
    return result.kind === "error" ? errorResult(result.message) : okResult(result);
  }
);

server.registerTool(
  "bridge_status",
  { description: "Report whether the browser extension is connected to the lens host." },
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ bridge: bridge.info, port: bridge.port, lensDir: LENS_DIR, writesEnabled: ALLOW_WRITES }),
      },
    ],
  })
);

function okResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function main() {
  await store.loadLocal();
  bridge = PINNED_PORT
    ? await Bridge.bind(PINNED_PORT)
    : await Bridge.bindRange(PORT_RANGE_START, PORT_RANGE_END);
  // Announce our port so the extension's native helper can push it (no probing).
  registerHost(bridge.port);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[lens-host] MCP on stdio; extension bridge on ws://127.0.0.1:${bridge.port}; lenses from ${LENS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
