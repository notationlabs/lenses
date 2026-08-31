import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserBridge } from "../src/bridge.js";
import { brokerBuildStamp } from "../src/broker-stamp.js";
import { authProof, loadBrokerAuth, proofMatches } from "../src/broker-auth.js";
import { randomBytes } from "node:crypto";

function authenticated(
  socket: import("ws").WebSocket,
  handle: (message: any) => void
): void {
  let challenge: { clientNonce: string; serverNonce: string } | undefined;
  const token = loadBrokerAuth().brokerToken;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "client-auth") {
      challenge = {
        clientNonce: message.nonce,
        serverNonce: randomBytes(24).toString("base64url"),
      };
      socket.send(JSON.stringify({
        type: "auth-challenge",
        nonce: challenge.serverNonce,
        proof: authProof(token, "broker", challenge.clientNonce, challenge.serverNonce),
      }));
      return;
    }
    if (message.type === "auth-response" && challenge) {
      if (!proofMatches(
        message.proof,
        authProof(token, "client", challenge.clientNonce, challenge.serverNonce)
      )) return socket.close();
      handle({ type: "client" });
      return;
    }
    handle(message);
  });
}

/**
 * A stand-in broker: it reports a stale stamp until a client asks it to shut
 * down, then reports the current one — the observable effect of a respawn,
 * without spawning a daemon that would reach for Chrome.
 */
function fakeBroker(port: number, staleStamp: string) {
  const server = new WebSocketServer({ port, host: "127.0.0.1" });
  const state = { stamp: staleStamp, shutdowns: 0 };
  server.on("connection", (socket) => {
    authenticated(socket, (message) => {
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

  it("waits for the broker result when a backend disconnects during cleanup", async () => {
    const port = 45_315;
    const server = new WebSocketServer({ port, host: "127.0.0.1" });
    server.on("connection", (socket) => authenticated(socket, (message) => {
      if (message.type === "client") {
        socket.send(JSON.stringify({
          type: "status",
          connected: true,
          stamp: brokerBuildStamp(),
        }));
        return;
      }
      if (message.type === "observe") {
        socket.send(JSON.stringify({ type: "status", connected: false }));
        socket.send(JSON.stringify({
          type: "result",
          id: message.id,
          result: { kind: "value", value: "finished" },
        }));
      }
    }));
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const bridge = await BrowserBridge.bind(port, "127.0.0.1");
      bridges.push(bridge);
      await expect(bridge.observe("https://example.com")).resolves.toMatchObject({
        kind: "value",
        value: "finished",
      });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exposes actionable broker diagnostics from status frames", async () => {
    const port = 45_314;
    const server = new WebSocketServer({ port, host: "127.0.0.1" });
    server.on("connection", (socket) => authenticated(socket, (message) => {
      if (message.type !== "client") return;
      socket.send(JSON.stringify({
      type: "status",
      connected: true,
      stamp: brokerBuildStamp(),
      backend: "playwright-extension",
      backends: [{ name: "playwright-extension", available: true, version: "1.2.3", capabilities: ["browser-session"] }],
      diagnostics: {
        concurrency: "serial_queue",
        activeCall: { id: "call_9", type: "call", lens: "@example/send", startedAt: 123 },
        queuedCalls: 2,
        lastBackendError: "CDP permission denied",
        reconnectAttempts: 3,
      },
    }));
    }));
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const bridge = await BrowserBridge.bind(port, "127.0.0.1");
      bridges.push(bridge);
      expect(bridge.backends).toEqual([
        expect.objectContaining({ name: "playwright-extension", version: "1.2.3", capabilities: ["browser-session"] }),
      ]);
      expect(bridge.diagnostics).toMatchObject({
        concurrency: "serial_queue",
        activeCall: { id: "call_9", lens: "@example/send" },
        queuedCalls: 2,
        reconnectAttempts: 3,
      });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("gives up with a clear error when the stamp never converges", async () => {
    const port = 45_313;
    const server = new WebSocketServer({ port, host: "127.0.0.1" });
    server.on("connection", (socket) => {
      authenticated(socket, (message) => {
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
