// Multi-session smoke: two lens-hosts WITHOUT LENS_BRIDGE_PORT each bind a free
// port in 4319-4329; one fake extension connects to every live host and answers
// the sampling round-trip; a lens_call through each MCP connection must succeed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RANGE_START = 4319;
const RANGE_END = 4329;

function makeClient(label) {
  const host = spawn("node", [`${ROOT}/packages/host/dist/index.js`], {
    cwd: ROOT,
    env: { ...process.env, LENS_DIR: `${ROOT}/lenses` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let boundPort = null;
  host.stderr.on("data", (d) => {
    const m = String(d).match(/ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) boundPort = Number(m[1]);
    process.stderr.write(`[${label}] ${d}`);
  });

  let buf = "";
  const pending = new Map();
  let seq = 0;
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

  function send(obj) {
    host.stdin.write(JSON.stringify(obj) + "\n");
  }
  function request(method, params) {
    const id = ++seq;
    return new Promise((r) => {
      pending.set(id, r);
      send({ jsonrpc: "2.0", id, method, params });
    });
  }
  return { host, request, send, portOf: () => boundPort };
}

const a = makeClient("hostA");
const b = makeClient("hostB");

for (const c of [a, b]) {
  const init = await c.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { sampling: {} },
    clientInfo: { name: "smoke-multi", version: "0" },
  });
  if (!init.result) throw new Error("initialize failed");
  c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

// wait for both hosts to log their bound port
await new Promise((r) => setTimeout(r, 500));
const portA = a.portOf();
const portB = b.portOf();
console.log("host A bound:", portA, "host B bound:", portB);
if (!portA || !portB || portA === portB) throw new Error("hosts did not bind two distinct ports");

// Fake extension: scan the whole range, connect to every live host, answer the
// sampling round-trip. Don't touch ports we didn't open.
const opened = [];
for (let port = RANGE_START; port <= RANGE_END; port++) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const ready = new Promise((res) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", ua: "fake-extension" }));
      opened.push(ws);
      res(true);
    });
    ws.on("error", () => res(false));
  });
  if (await ready) {
    let lastCallId = null;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "call") {
        lastCallId = msg.id;
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
  }
}
console.log("fake extension connected to", opened.length, "live host(s)");
await new Promise((r) => setTimeout(r, 200));

async function callThrough(c, label) {
  const res = await c.request("tools/call", {
    name: "lens_call",
    arguments: { lens: "hn/top", target: "https://news.ycombinator.com/" },
  });
  const parsed = JSON.parse(res.result.content[0].text);
  console.log(`${label} lens_call:`, parsed.kind, parsed.resolver ?? "");
  if (parsed.kind !== "value") throw new Error(`${label} lens_call did not succeed: ${res.result.content[0].text}`);
}

await callThrough(a, "hostA");
await callThrough(b, "hostB");

a.host.kill();
b.host.kill();
for (const ws of opened) ws.close();
console.log("MULTI SMOKE OK");
process.exit(0);
