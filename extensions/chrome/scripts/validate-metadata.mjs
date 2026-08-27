import { createHash, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";

export const EXPECTED_EXTENSION_ID = "mbanohpojdbbnbnmppepaihihmkoibaj";

export async function readAndValidateMetadata(root = process.cwd()) {
  const [packageJson, manifest] = await Promise.all([
    readJson(`${root}/package.json`),
    readJson(`${root}/manifest.json`),
  ]);

  if (packageJson.version !== manifest.version) {
    throw new Error(
      `version mismatch: package.json is ${packageJson.version}, manifest.json is ${manifest.version}`
    );
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(packageJson.version)) {
    throw new Error(`Chrome version must contain one to four numeric components: ${packageJson.version}`);
  }
  if (typeof manifest.key !== "string" || manifest.key.length < 100) {
    throw new Error("manifest.key must contain the checked-in Chrome Web Store public key");
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(manifest.key, "base64"),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new Error(`manifest.key is not a valid base64 DER public key: ${error.message}`);
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("manifest.key must be an RSA public key, never a private key");
  }

  const keyBytes = Buffer.from(manifest.key, "base64");
  const digest = createHash("sha256").update(keyBytes).digest();
  const extensionId = [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => "abcdefghijklmnop"[nibble])
    .join("");
  const expectedId = process.env.LENSES_EXTENSION_EXPECTED_ID || EXPECTED_EXTENSION_ID;
  if (extensionId !== expectedId) {
    throw new Error(
      `manifest.key produces extension ID ${extensionId}, expected ${expectedId}; see store/RELEASE.md`
    );
  }

  return { packageJson, manifest, extensionId };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await readAndValidateMetadata();
  console.log(`metadata valid: v${result.packageJson.version}, extension ${result.extensionId}`);
}
