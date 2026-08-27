import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authProof,
  brokerOriginAllowed,
  loadBrokerAuth,
  proofMatches,
} from "../src/broker-auth.js";

const previous = process.env.LENS_BROKER_AUTH_FILE;
const roots: string[] = [];
afterEach(() => {
  if (previous === undefined) delete process.env.LENS_BROKER_AUTH_FILE;
  else process.env.LENS_BROKER_AUTH_FILE = previous;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedPath(): string {
  const root = mkdtempSync(join(tmpdir(), "lenses-auth-"));
  roots.push(root);
  const path = join(root, "nested", "broker-auth.json");
  process.env.LENS_BROKER_AUTH_FILE = path;
  return path;
}

describe("broker authentication", () => {
  it("creates and retains a mode-0600 per-user credential", () => {
    const path = isolatedPath();
    const first = loadBrokerAuth();
    const second = loadBrokerAuth();
    expect(second.brokerToken).toBe(first.brokerToken);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("binds proofs to role and both nonces", () => {
    const proof = authProof("secret", "broker", "client-nonce", "server-nonce");
    expect(proofMatches(proof, authProof("secret", "broker", "client-nonce", "server-nonce"))).toBe(true);
    expect(proofMatches(proof, authProof("secret", "client", "client-nonce", "server-nonce"))).toBe(false);
    expect(proofMatches(proof, authProof("secret", "broker", "other", "server-nonce"))).toBe(false);
  });

  it("rejects browser origins; native clients send none", () => {
    expect(brokerOriginAllowed(undefined)).toBe(true);
    expect(brokerOriginAllowed("https://evil.example")).toBe(false);
    expect(brokerOriginAllowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});
