import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXTENSION_PROTOCOL_MAJOR,
  decodeBrokerExtensionMessage,
  decodeExtensionBrokerMessage,
  decodeExtensionRpcRequest,
  decodeExtensionRpcResponse,
  negotiateExtensionHello,
} from "../src/extension-protocol.js";

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./fixtures/extension-protocol.json", import.meta.url)
    ),
    "utf8"
  )
) as Record<string, unknown>;

describe("broker-extension protocol", () => {
  it("accepts the golden hello and RPC fixtures", () => {
    expect(negotiateExtensionHello(fixtures.hello)).toMatchObject({
      protocolMajor: EXTENSION_PROTOCOL_MAJOR,
      epoch: "epoch_fixture",
    });
    expect(decodeBrokerExtensionMessage(fixtures.bindRequest)).toEqual(
      fixtures.bindRequest
    );
    expect(decodeExtensionBrokerMessage(fixtures.deltaResponse)).toEqual(
      fixtures.deltaResponse
    );
  });

  it("rejects an incompatible protocol major", () => {
    expect(() =>
      negotiateExtensionHello({
        ...(fixtures.hello as object),
        protocolMajor: EXTENSION_PROTOCOL_MAJOR + 1,
      })
    ).toThrow(
      `incompatible extension protocol major ${
        EXTENSION_PROTOCOL_MAJOR + 1
      }; broker requires ${EXTENSION_PROTOCOL_MAJOR}`
    );
  });

  it("rejects a missing required capability", () => {
    expect(() =>
      negotiateExtensionHello({
        ...(fixtures.hello as object),
        capabilities: ["sessions"],
      })
    ).toThrow(
      "extension is missing required capabilities: cursor-delta, dom-extract, snapshot-html"
    );
  });

  it("rejects stale or malformed frame shapes", () => {
    expect(() => decodeExtensionRpcRequest(fixtures.bindRequest, "new_epoch", 0))
      .toThrow("stale extension epoch epoch_fixture; current epoch is new_epoch");
    expect(() =>
      decodeExtensionRpcResponse(fixtures.deltaResponse, "new_epoch")
    ).toThrow(
      "stale extension epoch epoch_fixture; current epoch is new_epoch"
    );
    expect(() =>
      decodeExtensionBrokerMessage({
        ...(fixtures.deltaResponse as object),
        unexpected: true,
      })
    ).toThrow();
  });

  it("rejects an expired RPC deadline", () => {
    expect(() =>
      decodeExtensionRpcRequest(
        fixtures.bindRequest,
        "epoch_fixture",
        1893456000001
      )
    ).toThrow("extension RPC request_1 deadline exceeded");
  });

  it("allows additional capabilities within the same major", () => {
    expect(
      negotiateExtensionHello({
        ...(fixtures.hello as object),
        capabilities: [
          "sessions",
          "cursor-delta",
          "dom-extract",
          "snapshot-html",
          "future-capability",
        ],
      }).capabilities
    ).toContain("future-capability");
  });
});
