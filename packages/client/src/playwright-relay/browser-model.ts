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
 * Adapted from Playwright `packages/playwright-core/src/tools/mcp/browserModel.ts`
 * at revision deda92d15e7d771aacaae47eb2b6e47a562c30ff.
 */

import type { DebuggerSession, Debuggee, Tab } from "./protocol.js";

export type CDPMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message: string };
};

export type SendCommand = (method: string, params: any) => Promise<any>;
export type SendToCDPClient = (message: CDPMessage) => void;

type TabSession = {
  tabId: number;
  sessionId: string;
  targetInfo: any;
  childSessions: Set<string>;
};

type TabState = {
  session?: TabSession;
  attachment?: Promise<TabSession>;
};

export class BrowserModel {
  private _sendToExtension: SendCommand;
  private _sendToCDPClient: SendToCDPClient | null = null;
  /** One lifecycle record per Chrome tab; session and attachment cannot drift into separate maps. */
  private _tabs = new Map<number, TabState>();
  private _autoAttach = false;
  private _nextSessionId = 1;

  constructor(sendToExtension: SendCommand) {
    this._sendToExtension = sendToExtension;
  }

  connectOverCDP(sendToCDPClient: SendToCDPClient): void {
    this._sendToCDPClient = sendToCDPClient;
  }

  private _emit(message: CDPMessage): void {
    this._sendToCDPClient?.(message);
  }

  onTabCreated(tab: Tab): void {
    if (tab.id === undefined) return;
    if (!this._tabs.has(tab.id)) this._tabs.set(tab.id, {});
    if (this._autoAttach) {
      void this._attachTab(tab.id).catch((error) => console.error(error));
    }
  }

  onTabRemoved(tabId: number): void {
    const state = this._tabs.get(tabId);
    if (!state) return;
    this._tabs.delete(tabId);
    if (state.session) this._emitDetached(state.session);
  }

  onDebuggerEvent(source: DebuggerSession, method: string, params: any): void {
    if (source.tabId === undefined) return;
    const tabSession = this._tabs.get(source.tabId)?.session;
    if (!tabSession) return;
    const childSessionId = (params as { sessionId?: string } | undefined)?.sessionId;
    if (method === "Target.attachedToTarget" && childSessionId) {
      tabSession.childSessions.add(childSessionId);
    } else if (method === "Target.detachedFromTarget" && childSessionId) {
      tabSession.childSessions.delete(childSessionId);
    }
    const sessionId = source.sessionId || tabSession.sessionId;
    this._emit({ sessionId, method, params });
  }

  onDebuggerDetach(source: Debuggee): void {
    if (source.tabId !== undefined) this._detachTab(source.tabId);
  }

  async enableAutoAttach(): Promise<void> {
    this._autoAttach = true;
    const tabIds = [...this._tabs.keys()];
    await Promise.all(
      tabIds.map((tabId) => this._attachTab(tabId).catch((error) => console.error(error)))
    );
  }

  async createTarget(url: string | undefined): Promise<{ targetId: string | undefined }> {
    const tab = await this._sendToExtension("chrome.tabs.create", [{ url }]);
    if (tab?.id === undefined) throw new Error("Failed to create tab");
    if (!this._tabs.has(tab.id)) this._tabs.set(tab.id, {});
    const tabSession = await this._attachTab(tab.id);
    return { targetId: tabSession.targetInfo?.targetId };
  }

  async closeTarget(targetId: string | undefined): Promise<{ success: boolean }> {
    const tabSession = targetId
      ? this._findTabSession((session) => session.targetInfo?.targetId === targetId)
      : undefined;
    if (!tabSession) return { success: false };
    await this._removeTab(tabSession.tabId);
    return { success: true };
  }

  async closeTargets(predicate: (targetInfo: any) => boolean): Promise<void> {
    const tabIds = [...this._tabs.values()]
      .map((state) => state.session)
      .filter((session): session is TabSession => !!session && predicate(session.targetInfo))
      .map((session) => session.tabId);
    await Promise.all(tabIds.map((tabId) => this._removeTab(tabId)));
  }

  getTargetInfo(sessionId: string | undefined): any {
    if (!sessionId) return undefined;
    return this._findTabSession((session) => session.sessionId === sessionId)?.targetInfo;
  }

  async sendBrowserCommand(method: string, params: any): Promise<any> {
    const tabSession = this._findTabSession(() => true);
    if (!tabSession) {
      throw new Error(`No attached tab to forward browser-level command: ${method}`);
    }
    return await this._sendToExtension("chrome.debugger.sendCommand", [
      { tabId: tabSession.tabId },
      method,
      params,
    ]);
  }

  async sendCommand(sessionId: string, method: string, params: any): Promise<any> {
    let tabSession = this._findTabSession((session) => session.sessionId === sessionId);
    let cdpSessionId: string | undefined;
    if (!tabSession) {
      tabSession = this._findTabSession((session) => session.childSessions.has(sessionId));
      cdpSessionId = sessionId;
    }
    if (!tabSession) throw new Error(`No tab found for sessionId: ${sessionId}`);
    return await this._sendToExtension("chrome.debugger.sendCommand", [
      { tabId: tabSession.tabId, sessionId: cdpSessionId },
      method,
      params,
    ]);
  }

  private async _attachTab(tabId: number): Promise<TabSession> {
    const state = this._tabs.get(tabId);
    if (!state) throw new Error(`Cannot attach unknown tab ${tabId}`);
    if (state.session) return state.session;
    if (state.attachment) return state.attachment;
    const attachment = this._attachTabOnce(tabId, state).finally(() => {
      if (state.attachment === attachment) state.attachment = undefined;
    });
    state.attachment = attachment;
    return attachment;
  }

  private async _attachTabOnce(tabId: number, state: TabState): Promise<TabSession> {
    let attached = false;
    try {
      await this._sendToExtension("chrome.debugger.attach", [{ tabId }, "1.3"]);
      attached = true;
      const result = await this._sendToExtension("chrome.debugger.sendCommand", [
        { tabId },
        "Target.getTargetInfo",
      ]);
      if (this._tabs.get(tabId) !== state) throw new Error(`Tab ${tabId} closed while attaching`);

      const tabSession: TabSession = {
        tabId,
        sessionId: `pw-tab-${this._nextSessionId++}`,
        targetInfo: result?.targetInfo,
        childSessions: new Set(),
      };
      state.session = tabSession;
      this._emit({
        method: "Target.attachedToTarget",
        params: {
          sessionId: tabSession.sessionId,
          targetInfo: { ...tabSession.targetInfo, attached: true },
          waitingForDebugger: false,
        },
      });
      return tabSession;
    } catch (error) {
      if (attached) {
        await this._sendToExtension("chrome.debugger.detach", [{ tabId }]).catch(() => {});
      }
      throw error;
    }
  }

  private async _removeTab(tabId: number): Promise<void> {
    await this._sendToExtension("chrome.tabs.remove", [tabId]);
  }

  private _detachTab(tabId: number): void {
    const state = this._tabs.get(tabId);
    if (!state?.session) return;
    const session = state.session;
    state.session = undefined;
    this._emitDetached(session);
  }

  private _emitDetached(session: TabSession): void {
    this._emit({
      method: "Target.detachedFromTarget",
      params: {
        sessionId: session.sessionId,
        targetId: session.targetInfo?.targetId,
      },
    });
  }

  private _findTabSession(predicate: (session: TabSession) => boolean): TabSession | undefined {
    for (const state of this._tabs.values()) {
      if (state.session && predicate(state.session)) return state.session;
    }
    return undefined;
  }
}
