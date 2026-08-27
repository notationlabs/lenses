import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LENS_EXTENSION_ID,
  LENS_EXTENSION_ORIGIN,
  authProof,
  brokerOriginAllowed,
  loadBrokerAuth,
  proofMatches,
  saveExtensionPairing,
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
  it("pins the ID produced by the extension's manifest signing key", () => {
    const manifest = JSON.parse(readFileSync(
      new URL("../../../extensions/chrome/manifest.json", import.meta.url),
      "utf8"
    )) as { key: string };
    const bytes = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest()
      .subarray(0, 16);
    const id = [...bytes]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join("");
    expect(id).toBe(LENS_EXTENSION_ID);
  });

  it("creates and retains a mode-0600 per-user credential", () => {
    const path = isolatedPath();
    const first = loadBrokerAuth();
    const second = loadBrokerAuth();
    expect(second.brokerToken).toBe(first.brokerToken);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("retains extension pairings without exposing the broker token in frames", () => {
    const path = isolatedPath();
    loadBrokerAuth();
    saveExtensionPairing("install-1", "paired-secret");
    expect(loadBrokerAuth().extensions).toEqual({ "install-1": "paired-secret" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("binds proofs to role and both nonces", () => {
    const proof = authProof("secret", "broker", "client-nonce", "server-nonce");
    expect(proofMatches(proof, authProof("secret", "broker", "client-nonce", "server-nonce"))).toBe(true);
    expect(proofMatches(proof, authProof("secret", "client", "client-nonce", "server-nonce"))).toBe(false);
    expect(proofMatches(proof, authProof("secret", "broker", "other", "server-nonce"))).toBe(false);
  });

  it("rejects hostile browser origins while allowing native clients and the pinned extension", () => {
    expect(brokerOriginAllowed(undefined)).toBe(true);
    expect(brokerOriginAllowed(LENS_EXTENSION_ORIGIN)).toBe(true);
    expect(brokerOriginAllowed("https://evil.example")).toBe(false);
    expect(brokerOriginAllowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});
