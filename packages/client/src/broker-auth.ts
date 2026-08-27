import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LENS_EXTENSION_ID = "mbanohpojdbbnbnmppepaihihmkoibaj";
export const LENS_EXTENSION_ORIGIN = `chrome-extension://${LENS_EXTENSION_ID}`;

interface AuthState {
  version: 1;
  brokerToken: string;
  extensions: Record<string, string>;
}

export function brokerAuthPath(): string {
  return process.env.LENS_BROKER_AUTH_FILE ?? join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "lenses",
    "broker-auth.json"
  );
}

/** Load or atomically create the per-user credential, always mode 0600. */
export function loadBrokerAuth(): AuthState {
  const path = brokerAuthPath();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as AuthState;
    if (
      value.version !== 1 ||
      typeof value.brokerToken !== "string" ||
      value.brokerToken.length < 32 ||
      typeof value.extensions !== "object" ||
      value.extensions === null
    ) throw new Error("invalid broker credential file");
    chmodSync(path, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const initial: AuthState = {
    version: 1,
    brokerToken: randomBytes(32).toString("base64url"),
    extensions: {},
  };
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(initial, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return initial;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadBrokerAuth();
  }
}

export function saveExtensionPairing(installationId: string, token: string): void {
  const path = brokerAuthPath();
  const state = loadBrokerAuth();
  state.extensions[installationId] = token;
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function authProof(
  token: string,
  peer: "broker" | "client" | "extension",
  clientNonce: string,
  serverNonce: string
): string {
  return createHmac("sha256", token)
    .update(`lenses-v1:${peer}:${clientNonce}:${serverNonce}`)
    .digest("base64url");
}

export function proofMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Browser JavaScript cannot suppress Origin; native ws clients send none. */
export function brokerOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined || origin === LENS_EXTENSION_ORIGIN;
}

export function pairingCode(token: string, installationId: string, nonce: string): string {
  const digest = createHmac("sha256", token)
    .update(`lenses-pair-v1:${installationId}:${nonce}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
