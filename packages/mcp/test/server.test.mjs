import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createLensMcpServer } from "../dist/server.js";

async function connect(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  clientTransport.onmessage = (message) => {
    const resolve = pending.get(message.id);
    if (!resolve) return;
    pending.delete(message.id);
    resolve(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  };
  return { clientTransport, request };
}

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
