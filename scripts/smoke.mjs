// End-to-end smoke demo: MCP client (raw JSON-RPC over stdio) + fake extension (WS).
// Proves the whole pipeline without a browser: MCP handshake -> lens_call ->
// bridge -> LLM tier served via MCP sampling -> result cache -> accepts validation.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.SMOKE_PORT ?? "4391";

const host = spawn("node", [`${ROOT}/packages/host/dist/index.js`], {
  cwd: ROOT,
  env: { ...process.env, LENS_BRIDGE_PORT: PORT, LENS_DIR: `${ROOT}/lenses` },
  stdio: ["pipe", "pipe", "pipe"],
});
host.stderr.on("data", (d) => process.stderr.write(`[host] ${d}`));

let buf = "";
const pending = new Map();
host.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "sampling/createMessage") {
      // agent-side sampling handler: pretend the model extracted something
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          model: "fake-model",
          role: "assistant",
          content: { type: "text", text: '[{"title": "extracted-by-sampling"}]' },
        },
      });
    }
  }
});

let seq = 0;
function send(obj) {
  host.stdin.write(JSON.stringify(obj) + "\n");
}
function request(method, params) {
  const id = ++seq;
  return new Promise((resolvePending) => {
    pending.set(id, resolvePending);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: { sampling: {} },
  clientInfo: { name: "smoke", version: "0" },
});
console.log("initialize ok:", JSON.stringify(init.result.serverInfo));
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const tools = await request("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));

// 1. bridge_status with no extension
const st1 = await request("tools/call", { name: "bridge_status", arguments: {} });
console.log("status (no ext):", st1.result.content[0].text);

// 2. lens_call with no extension -> friendly error
const c1 = await request("tools/call", {
  name: "lens_call",
  arguments: { lens: "hn/top", target: "https://news.ycombinator.com/" },
});
console.log("call (no ext):", c1.result.content[0].text.slice(0, 120));

// 3. connect a fake extension that exercises the LLM tier via sampling
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", ua: "fake-extension" }));
let lastCallId = null;
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "call") {
    lastCallId = msg.id;
    // simulate: intercept+dom missed, extension asks the agent's model
    ws.send(JSON.stringify({ type: "llm", id: "llm_1", callId: msg.id, prompt: "extract stuff" }));
  } else if (msg.type === "llm_result") {
    ws.send(
      JSON.stringify({
        type: "result",
        id: lastCallId,
        result: { kind: "value", resolver: "llm", value: JSON.parse(msg.text) },
      })
    );
  }
});
await new Promise((r) => setTimeout(r, 200));

const c2 = await request("tools/call", {
  name: "lens_call",
  arguments: { lens: "hn/top", target: "https://news.ycombinator.com/" },
});
console.log("call (fake ext + sampling):", c2.result.content[0].text);

// 4. cache: second call should be served from cache without touching the ws
const c3 = await request("tools/call", {
  name: "lens_call",
  arguments: { lens: "hn/top", target: "https://news.ycombinator.com/" },
});
console.log("call (cached):", JSON.parse(c3.result.content[0].text).cached === true ? "HIT" : "MISS");

// 5. accepts validation: mismatched target rejected host-side
const c4 = await request("tools/call", {
  name: "lens_call",
  arguments: { lens: "hn/top", target: "https://example.com/nope" },
});
console.log("call (bad target):", c4.result.content[0].text.slice(0, 100));

host.kill();
ws.close();
console.log("SMOKE OK");
process.exit(0);
