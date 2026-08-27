/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Adapted from Playwright `packages/playwright-core/src/tools/mcp/cdpRelay.ts`
 * at revision deda92d15e7d771aacaae47eb2b6e47a562c30ff.
 *
 * WebSocket server that bridges a CDP client (Puppeteer) and the Playwright
 * Chrome Extension.
 *
 * Endpoints:
 * - /cdp/guid — full CDP interface for the lens broker
 * - /extension/guid — extension connection
 *
 * The advertised protocol version matches the relay implementation below.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ExtensionProtocolV2 } from "./cdp-relay-v2.js";
import { createDeferred } from "./deferred.js";
import type { CDPMessage } from "./browser-model.js";
import type { ExtensionCommandV2, ExtensionEventsV2 } from "./protocol.js";

type CDPCommand = {
  id: number;
  sessionId?: string;
  method: string;
  params?: any;
};

type Log = (message: string) => void;

export class CDPRelayServer {
  private readonly _log: Log;
  private _httpServer: HttpServer | undefined;
  private _wss: WebSocketServer | undefined;
  private _wsHost = "";
  private _cdpPath: string;
  private _extensionPath: string;
  private _cdpConnection: WebSocket | null = null;
  private _extensionConnection: ExtensionConnection | null = null;
  private _handler: ExtensionProtocolV2;
  private _extensionConnectionPromise = createDeferred<void>();

  constructor(log: Log = () => {}) {
    this._log = log;
    const sendCommand = (method: string, params: any): Promise<any> => {
      if (!this._extensionConnection) throw new Error("Extension not connected");
      return this._extensionConnection.send(method as keyof ExtensionCommandV2, params);
    };
    this._handler = new ExtensionProtocolV2(sendCommand);

    const uuid = crypto.randomUUID();
    this._cdpPath = `/cdp/${uuid}`;
    this._extensionPath = `/extension/${uuid}`;
  }

  async start(): Promise<void> {
    const httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(request.url ?? "", "http://127.0.0.1").pathname;
      if (pathname !== this._cdpPath && pathname !== this._extensionPath) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        this._log(`relay connection ${pathname}`);
        if (pathname === this._cdpPath) this._handleCdpConnection(ws);
        else this._handleExtensionConnection(ws);
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("CDP relay has no TCP address");
    }
    this._httpServer = httpServer;
    this._wss = wss;
    this._wsHost = `ws://127.0.0.1:${address.port}`;
  }

  cdpEndpoint(): string {
    return `${this._wsHost}${this._cdpPath}`;
  }

  extensionEndpoint(): string {
    return `${this._wsHost}${this._extensionPath}`;
  }

  async waitForExtension(): Promise<void> {
    await this._extensionConnectionPromise.promise;
    await this._handler.ready();
  }

  stop(): void {
    this._closeConnections("Server stopped");
    this._wss?.close();
    this._httpServer?.close();
    this._wss = undefined;
    this._httpServer = undefined;
  }

  private _closeConnections(reason: string) {
    this._closeCdpConnection(reason);
    this._closeExtensionConnection(reason);
  }

  private _handleCdpConnection(ws: WebSocket): void {
    if (!this._extensionConnection) {
      this._log("rejecting CDP connection: extension not connected");
      ws.close(1000, "Extension not connected");
      return;
    }
    if (this._cdpConnection) {
      this._log("rejecting second CDP connection");
      ws.close(1000, "Another CDP client already connected");
      return;
    }
    this._cdpConnection = ws;
    this._handler.connectOverCDP((msg) => this._sendToCdpClient(msg));
    ws.on("message", (data) => {
      void (async () => {
        try {
          await this._handleCdpMessage(JSON.parse(data.toString()) as CDPCommand);
        } catch (error) {
          this._log(
            `CDP message failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
    });
    ws.on("close", () => {
      this._closeExtensionConnection("CDP client disconnected");
    });
  }

  private _closeExtensionConnection(reason: string) {
    this._extensionConnection?.close(reason);
    this._extensionConnection = null;
    if (!this._extensionConnectionPromise.isDone()) {
      this._extensionConnectionPromise.reject(new Error(reason));
    }
  }

  private _closeCdpConnection(reason: string) {
    if (this._cdpConnection?.readyState === WebSocket.OPEN) {
      this._cdpConnection.close(1000, reason);
    }
    this._cdpConnection = null;
  }

  private _handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionConnection) {
      ws.close(1000, "Another extension connection already established");
      return;
    }
    const connection = new ExtensionConnection(ws);
    this._extensionConnection = connection;
    connection.onclose = (reason) => {
      if (this._extensionConnection === connection) this._extensionConnection = null;
      this._handler.onExtensionDisconnect(reason);
      this._closeCdpConnection(`Extension disconnected: ${reason}`);
    };
    this._extensionConnection.onmessage = (method, params) =>
      this._handler.handleExtensionEvent(method, params);
    this._extensionConnectionPromise.resolve();
  }

  private async _handleCdpMessage(message: CDPCommand): Promise<void> {
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCdpCommand(method, params, sessionId);
      this._sendToCdpClient({ id, sessionId, result });
    } catch (error) {
      this._sendToCdpClient({
        id,
        sessionId,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async _handleCdpCommand(
    method: string,
    params: any,
    sessionId: string | undefined
  ): Promise<any> {
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          userAgent: "CDP-Bridge-Server/1.0.0",
        };
      case "Browser.setDownloadBehavior":
        return {};
    }
    const handled = await this._handler.handleCDPCommand(method, params, sessionId);
    if (handled) return handled.result;
    return await this._handler.forwardToExtension(method, params, sessionId);
  }

  private _sendToCdpClient(message: CDPMessage): void {
    if (this._cdpConnection?.readyState === WebSocket.OPEN) {
      this._cdpConnection.send(JSON.stringify(message));
    }
  }
}

type ExtensionResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

type PendingCommand = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  error: Error;
};

class ExtensionConnection {
  private readonly _ws: WebSocket;
  private readonly _callbacks = new Map<number, PendingCommand>();
  private _lastId = 0;

  onmessage?: <M extends keyof ExtensionEventsV2>(
    method: M,
    params: ExtensionEventsV2[M]["params"]
  ) => void;
  onclose?: (reason: string) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.on("message", (data) => this._onMessage(data.toString()));
    this._ws.on("close", (_code, reason) => this._onClose(reason.toString()));
    this._ws.on("error", () => this._dispose());
  }

  async send<M extends keyof ExtensionCommandV2>(
    method: M,
    params: ExtensionCommandV2[M]["params"]
  ): Promise<any> {
    if (this._ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    }
    const id = ++this._lastId;
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
      this._ws.send(JSON.stringify({ id, method, params }), (sendError) => {
        if (!sendError) return;
        const pending = this._callbacks.get(id);
        if (!pending) return;
        this._callbacks.delete(id);
        pending.reject(sendError);
      });
    });
  }

  close(message: string) {
    if (this._ws.readyState === WebSocket.OPEN) this._ws.close(1000, message);
  }

  private _onMessage(eventData: string) {
    let parsedJson: ExtensionResponse;
    try {
      parsedJson = JSON.parse(eventData) as ExtensionResponse;
    } catch {
      this._ws.close(1002, "Invalid extension protocol message");
      return;
    }
    this._handleParsedMessage(parsedJson);
  }

  private _handleParsedMessage(object: ExtensionResponse) {
    if (object.id !== undefined) {
      const callback = this._callbacks.get(object.id);
      if (!callback) return;
      this._callbacks.delete(object.id);
      if (object.error) {
        callback.error.message = object.error;
        callback.reject(callback.error);
      } else {
        callback.resolve(object.result);
      }
      return;
    }
    if (object.method) {
      this.onmessage?.(object.method as keyof ExtensionEventsV2, object.params);
    }
  }

  private _onClose(reason: string) {
    this._dispose();
    this.onclose?.(reason);
  }

  private _dispose() {
    for (const callback of this._callbacks.values()) {
      callback.reject(new Error("WebSocket closed"));
    }
    this._callbacks.clear();
  }
}
