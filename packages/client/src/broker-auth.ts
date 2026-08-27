import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface AuthState {
  version: 1;
  brokerToken: string;
  /** Retained for existing credential files; the bundled extension is gone. */
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

export function authProof(
  token: string,
  peer: "broker" | "client",
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

/** Native ws clients send no Origin; browser pages must not talk to the broker. */
export function brokerOriginAllowed(origin: string | undefined): boolean {
  return origin === undefined;
}
