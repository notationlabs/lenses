import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createLensMcpServer } from "../dist/server.js";

async function connect(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  const notifications = [];
  clientTransport.onmessage = (message) => {
    if (message.method === "notifications/progress") notifications.push(message);
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 1;
  const request = (method, params, meta) => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params: { ...params, ...(meta ? { _meta: meta } : {}) } }),
      });
    });
  };
  return { clientTransport, request, notifications };
}

test("a pending login call reports MCP progress when the caller supplies a token", async (t) => {
  let complete;
  const server = createLensMcpServer({
    call: () => new Promise((resolve) => { complete = resolve; }),
  }, 20);
  t.after(() => server.close());
  const { clientTransport, request, notifications } = await connect(server);
  await request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const pending = request("tools/call", { name: "lens_call", arguments: { lens: "example" } }, { progressToken: "login" });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no progress notification")), 1_000);
    const check = setInterval(() => {
      if (notifications.length === 0) return;
      clearInterval(check);
      clearTimeout(deadline);
      resolve();
    }, 5);
  });
  assert.equal(notifications.at(-1)?.params.progressToken, "login");
  complete({ kind: "value", value: 1 });
  const response = await pending;
  assert.equal(response.result.content[0].text.includes('"value": 1'), true);
});

test("exposes actions without inviting a connectivity preflight", async (t) => {
  const server = createLensMcpServer({ list: async () => [] });
  t.after(() => server.close());
  const { clientTransport, request } = await connect(server);

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  });
  assert.equal(initialized.result.instructions, undefined);
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listed = await request("tools/list");
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ["lens_call", "lens_list", "lens_observe"]
  );
  for (const tool of listed.result.tools) {
    assert.doesNotMatch(tool.description, /preflight|disconnected|broker_status/i);
  }
});
