import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserBridge } from "../src/bridge.js";
import { brokerBuildStamp } from "../src/broker-stamp.js";

/**
 * A stand-in broker: it reports a stale stamp until a client asks it to shut
 * down, then reports the current one — the observable effect of a respawn,
 * without spawning a daemon that would reach for Chrome.
 */
function fakeBroker(port: number, staleStamp: string) {
  const server = new WebSocketServer({ port, host: "127.0.0.1" });
  const state = { stamp: staleStamp, shutdowns: 0 };
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "client") {
        socket.send(JSON.stringify({ type: "status", connected: false, stamp: state.stamp }));
        return;
      }
      if (message.type === "control" && message.action === "shutdown") {
        state.shutdowns += 1;
        state.stamp = brokerBuildStamp();
        socket.send(
          JSON.stringify({ type: "result", id: message.id, result: { kind: "value", value: {} } })
        );
        // Drop every client socket, as a retiring daemon does.
        for (const client of server.clients) client.close();
      }
    });
  });
  return {
    state,
    ready: new Promise<void>((resolve) => server.once("listening", () => resolve())),
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let broker: ReturnType<typeof fakeBroker> | undefined;
const bridges: BrowserBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  await broker?.close();
  broker = undefined;
});

describe("broker build stamp handshake", () => {
  it("restarts a stale broker exactly once for concurrent clients", async () => {
    const port = 45_311;
    broker = fakeBroker(port, "stale000stale000");
    await broker.ready;

    const bound = await Promise.all(
      Array.from({ length: 4 }, () => BrowserBridge.bind(port, "127.0.0.1"))
    );
    bridges.push(...bound);

    expect(broker.state.shutdowns).toBe(1);
    expect(bound).toHaveLength(4);
    expect(bound.every((bridge) => bridge.port === port)).toBe(true);
  });

  it("binds without a restart when the stamp matches", async () => {
    const port = 45_312;
    broker = fakeBroker(port, brokerBuildStamp());
    await broker.ready;

    const bridge = await BrowserBridge.bind(port, "127.0.0.1");
    bridges.push(bridge);
    expect(broker.state.shutdowns).toBe(0);
  });

  it("gives up with a clear error when the stamp never converges", async () => {
    const port = 45_313;
    const server = new WebSocketServer({ port, host: "127.0.0.1" });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "client") {
          socket.send(JSON.stringify({ type: "status", connected: false, stamp: "never0matches" }));
        }
        if (message.type === "control") socket.close();
      });
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      await expect(BrowserBridge.bind(port, "127.0.0.1")).rejects.toThrow(/stale build/);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
