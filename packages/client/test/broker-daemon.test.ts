import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { LensBridgeRequest } from "@notation/lenses-core";
import { authProof } from "../src/broker-auth.js";
import { startBroker, type Broker } from "../src/broker-daemon.js";
import type { BrokerFrame, BrokerOrchestrator } from "../src/broker-orchestrator.js";
import type { CdpBackend } from "../src/cdp-host.js";

const token = "broker-daemon-test-credential-with-32-or-more-characters";

type Work = Exclude<LensBridgeRequest, { type: "control" }>;
type Handle = (message: Work, emit: (frame: BrokerFrame) => void) => Promise<void>;

function fakeBackend(): CdpBackend {
  return {
    name: "fake",
    available: () => true,
    info: () => ({ name: "fake" }),
    lease: () => ({ state: "connected" }),
    onStatusChange: () => () => {},
    onLeaseReleaseRequest: () => () => {},
    findAuthGate: async () => undefined,
    bind: async () => {
      throw new Error("not used");
    },
    finish: async () => {},
    browserLive: async () => true,
    release: async () => {},
    acquire: async () => {},
    start: () => {},
    stop: () => {},
  } as unknown as CdpBackend;
}

function fakeOrchestrator(handle: Handle): BrokerOrchestrator & { handled: Work[] } {
  const handled: Work[] = [];
  return {
    handled,
    busy: () => undefined,
    watchAuthGate: async () => undefined,
    handle: async (message, emit) => {
      handled.push(message);
      await handle(message, emit);
    },
  };
}

interface TestClient {
  socket: WebSocket;
  frames: Array<{ type: string; id?: string; result?: { kind: string; message?: string } }>;
  send(value: unknown): void;
  close(): Promise<void>;
}

async function connect(port: number): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: TestClient["frames"] = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => socket.once("open", resolve).once("error", reject));
  const nonce = "broker-daemon-test-client-nonce";
  socket.send(JSON.stringify({ type: "client-auth", nonce }));
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === "auth-challenge")).toBe(true));
  const challenge = frames.find((frame) => frame.type === "auth-challenge") as unknown as { nonce: string };
  socket.send(JSON.stringify({ type: "auth-response", proof: authProof(token, "client", nonce, challenge.nonce) }));
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === "status")).toBe(true));
  return {
    socket,
    frames,
    send: (value) => socket.send(JSON.stringify(value)),
    close: () =>
      new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      }),
  };
}

function writeCall(id: string, timeoutMs = 10_000) {
  return {
    type: "call",
    id,
    timeoutMs,
    deadline: Date.now() + timeoutMs,
    params: {},
    allowWrites: true,
    spec: {
      name: "@test/write",
      url: "https://example.com/",
      effects: { reads: [], writes: ["https://example.com"] },
      perform: [{ kind: "click", selector: "button" }],
      resolve: [],
    },
  };
}

function result(client: TestClient, id: string) {
  return client.frames.find((frame) => frame.type === "result" && frame.id === id);
}

let broker: Broker | undefined;
const clients: TestClient[] = [];

async function start(handle: Handle) {
  const orchestrator = fakeOrchestrator(handle);
  broker = await startBroker({
    port: 0,
    backend: fakeBackend(),
    orchestrator,
    auth: { brokerToken: token },
    exit: () => {},
  });
  return orchestrator;
}

async function client(): Promise<TestClient> {
  const opened = await connect(broker!.port);
  clients.push(opened);
  return opened;
}

afterEach(async () => {
  for (const opened of clients.splice(0)) opened.socket.terminate();
  await broker?.close();
  broker = undefined;
});

describe("broker per-call loop", () => {
  it("skips a queued call whose client disconnected before it started", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const orchestrator = await start(async (message, emit) => {
      if (message.id === "first") await firstGate;
      emit({ type: "result", id: message.id, result: { kind: "value", value: null } });
    });
    const owner = await client();
    const interrupted = await client();

    owner.send(writeCall("first"));
    await vi.waitFor(() => expect(orchestrator.handled.map((message) => message.id)).toEqual(["first"]));
    interrupted.send(writeCall("second"));
    await vi.waitFor(() =>
      expect(interrupted.frames.some((frame) => frame.type === "progress" && frame.id === "second")).toBe(true)
    );
    await interrupted.close();
    // The broker handles the close on its own socket after the client sees it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();

    await vi.waitFor(() => expect(result(owner, "first")).toBeDefined());
    await vi.waitFor(() => expect((broker!.status() as { diagnostics: { queuedCalls: number } })
      .diagnostics.queuedCalls).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(orchestrator.handled.map((message) => message.id)).toEqual(["first"]);
  });

  it("sends an error result when the call loop fails", async () => {
    await start(async () => {
      throw new Error("backend exploded");
    });
    const caller = await client();

    caller.send(writeCall("failing"));

    await vi.waitFor(() => expect(result(caller, "failing")?.result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("backend exploded"),
    }));
  });
});
