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
 * Adapted from Playwright `packages/playwright-core/src/tools/mcp/cdpRelayV2.ts`
 * at revision deda92d15e7d771aacaae47eb2b6e47a562c30ff.
 */

import { BrowserModel, type SendCommand, type SendToCDPClient } from "./browser-model.js";
import { createDeferred } from "./deferred.js";
import { PLAYWRIGHT_EXTENSION_ID, type ExtensionEventsV2 } from "./protocol.js";

export class ExtensionProtocolV2 {
  private _model: BrowserModel;
  private _ready = createDeferred<void>();

  constructor(sendCommand: SendCommand) {
    this._model = new BrowserModel(sendCommand);
  }

  ready(): Promise<void> {
    return this._ready.promise;
  }

  connectOverCDP(sendToCDPClient: SendToCDPClient): void {
    this._model.connectOverCDP(sendToCDPClient);
  }

  onExtensionDisconnect(reason: string): void {
    if (!this._ready.isDone()) {
      this._ready.reject(new Error(`Extension disconnected before initialization: ${reason}`));
    }
  }

  handleExtensionEvent(method: string, params: any): void {
    switch (method) {
      case "chrome.debugger.onEvent": {
        const [source, cdpMethod, cdpParams] = params as ExtensionEventsV2["chrome.debugger.onEvent"]["params"];
        this._model.onDebuggerEvent(source, cdpMethod, cdpParams);
        break;
      }
      case "chrome.debugger.onDetach": {
        const [source] = params as ExtensionEventsV2["chrome.debugger.onDetach"]["params"];
        this._model.onDebuggerDetach(source);
        break;
      }
      case "chrome.tabs.onCreated": {
        const [tab] = params as ExtensionEventsV2["chrome.tabs.onCreated"]["params"];
        this._model.onTabCreated(tab);
        break;
      }
      case "chrome.tabs.onRemoved": {
        const [tabId] = params as ExtensionEventsV2["chrome.tabs.onRemoved"]["params"];
        this._model.onTabRemoved(tabId);
        break;
      }
      case "extension.initialized": {
        this._ready.resolve();
        break;
      }
    }
  }

  async handleCDPCommand(
    method: string,
    params: any,
    sessionId: string | undefined
  ): Promise<{ result: any } | undefined> {
    switch (method) {
      case "Target.getBrowserContexts":
        return { result: { browserContextIds: [] } };
      case "Target.setDiscoverTargets":
        // Tab discovery arrives through chrome.tabs events; there is no
        // browser-wide debugger target on the extension transport.
        return { result: {} };
      case "Target.setAutoAttach": {
        if (sessionId) return undefined;
        await this._model.enableAutoAttach();
        return { result: {} };
      }
      case "Target.createTarget": {
        const result = await this._model.createTarget(params?.url, params?.background === true);
        // Token approval selects the connect page itself. Keep it until a real
        // target exists so closing the relay's only tab cannot abort Puppeteer's
        // startup handshake, then remove it from the accessible group.
        await this._model.closeTargets(isConnectPage);
        return { result };
      }
      case "Target.closeTarget":
        return { result: await this._model.closeTarget(params?.targetId) };
      case "Target.getTargetInfo":
        return { result: this._model.getTargetInfo(sessionId) };
    }
    return undefined;
  }

  async forwardToExtension(method: string, params: any, sessionId: string | undefined): Promise<any> {
    if (!sessionId) return await this._model.sendBrowserCommand(method, params);
    return await this._model.sendCommand(sessionId, method, params);
  }
}

function isConnectPage(targetInfo: any): boolean {
  try {
    const url = new URL(targetInfo?.url);
    return (
      url.protocol === "chrome-extension:" &&
      url.hostname === PLAYWRIGHT_EXTENSION_ID &&
      url.pathname === "/connect.html"
    );
  } catch {
    return false;
  }
}
