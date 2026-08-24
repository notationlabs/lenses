import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  contextualExtensionTransportError,
  createExtensionBackend,
} from "../src/extension-backend.js";

describe("extension transport errors", () => {
  it("replaces Chrome's raw missing-receiver message with a contextual Lens error", () => {
    const error = contextualExtensionTransportError(
      "dom-extract",
      "Could not establish connection. Receiving end does not exist."
    );

    expect(error.message).toContain("Lens extension receiver");
    expect(error.message).toContain("extension backend");
    expect(error.message).toContain("dom-extract");
    expect(error.message).toContain("chrome://extensions");
    expect(error.message).not.toContain("Receiving end does not exist");
  });

  it("identifies lost credentialed HTTP capability", () => {
    expect(
      contextualExtensionTransportError("http-fetch", "The message port closed").message
    ).toContain("credentialed HTTP capability");
  });

  it("retains rejected extension version and capabilities for status diagnostics", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("missing test port");
    const accepted = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const opened = new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const [socket] = await Promise.all([accepted, opened]);
    const backend = createExtensionBackend();

    try {
      expect(
        backend.attach(socket, {
          type: "extension-hello",
          protocolMajor: 99,
          extensionVersion: "0.0.7",
          capabilities: ["sessions", "http-fetch"],
          epoch: "old-extension",
        })
      ).toBe(false);
      expect(backend.info()).toMatchObject({
        version: "0.0.7",
        protocolMajor: 99,
        capabilities: ["sessions", "http-fetch"],
      });
      expect(backend.info().diagnostic).toContain("broker requires");
      expect(backend.info().diagnostic).toContain("update the Lens CLI and Chrome extension together");
    } finally {
      backend.stop();
      client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
