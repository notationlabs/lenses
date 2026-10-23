/**
 * Starts the harness (harness.ts, compiled by `pnpm test`) in Electron, and
 * connects to it as the broker (Puppeteer over /cdp) and as the user (/control).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser } from "puppeteer-core";
import { WebSocket } from "ws";
import type { PageInfo } from "./harness.js";

export type { PageInfo };

const appDir = fileURLToPath(new URL("..", import.meta.url));
const harnessMain = fileURLToPath(new URL("../dist-test/test/harness.js", import.meta.url));
/** The electron package, from Node, is the path to its binary. */
export const electronPath = createRequire(import.meta.url)("electron") as string;
export const canRun = existsSync(electronPath) && existsSync(harnessMain);

export interface Harness {
  /** Connect as the broker does: a CDP browser over the lens tabs. */
  broker(): Promise<Browser>;
  /** Act as the user, or look at what the app holds. */
  control<T = unknown>(method: string, ...params: unknown[]): Promise<T>;
  pages(): Promise<PageInfo[]>;
  stop(): Promise<void>;
}

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const env = { ...process.env, ...extraEnv };
  // Set in some shells (and by Electron-based editors); Electron would run as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [harnessMain], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
    if (process.env.HARNESS_TRACE) process.stderr.write(chunk);
  });
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk;
      const match = /HARNESS (\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`harness exited (${code}): ${stderr}`)));
  });

  const socket = new WebSocket(`ws://127.0.0.1:${port}/control`);
  await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  socket.on("message", (raw) => {
    const { id, result, error } = JSON.parse(String(raw));
    const call = pending.get(id);
    pending.delete(id);
    if (error) call?.reject(new Error(error));
    else call?.resolve(result);
  });
  const control = <T>(method: string, ...params: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    broker: () => puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/cdp`, defaultViewport: null }),
    control,
    pages: () => control<PageInfo[]>("pages"),
    stop: () => stop(child, socket),
  };
}

/** A free port on this machine, for the broker. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export interface BrokerFrame {
  type: string;
  id?: string;
  message?: string;
  nonce?: string;
  result?: any;
}

export interface BrokerClient {
  frames: BrokerFrame[];
  send(frame: object): void;
  /** The frames of one call. */
  framesFor(id: string): BrokerFrame[];
  close(): void;
}

/** Talk to the broker as the CLI does: authenticate with the shared token, then send frames. */
export async function connectBroker(port: number, token: string): Promise<BrokerClient> {
  let socket: WebSocket | undefined;
  // The broker starts listening a moment after the harness reports in.
  for (let attempt = 0; !socket; attempt++) {
    const candidate = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise((resolve, reject) => candidate.once("open", resolve).once("error", reject));
      socket = candidate;
    } catch (error) {
      if (attempt > 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const frames: BrokerFrame[] = [];
  const open = socket;
  open.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  const until = async (found: () => BrokerFrame | undefined) => {
    for (let waited = 0; waited < 10_000; waited += 50) {
      const frame = found();
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the broker did not answer");
  };
  const nonce = "harness-client-nonce-that-is-long-enough";
  open.send(JSON.stringify({ type: "client-auth", nonce }));
  const challenge = await until(() => frames.find((frame) => frame.type === "auth-challenge"));
  open.send(JSON.stringify({ type: "auth-response", proof: authProof(token, nonce, challenge.nonce!) }));
  await until(() => frames.find((frame) => frame.type === "status"));
  return {
    frames,
    send: (frame) => open.send(JSON.stringify(frame)),
    framesFor: (id) => frames.filter((frame) => frame.id === id),
    close: () => open.close(),
  };
}

/** As the client's broker-auth.ts proves itself. */
function authProof(token: string, clientNonce: string, serverNonce: string): string {
  return createHmac("sha256", token).update(`lenses-v1:client:${clientNonce}:${serverNonce}`).digest("base64url");
}

async function stop(child: ChildProcess, socket: WebSocket): Promise<void> {
  socket.close();
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}
