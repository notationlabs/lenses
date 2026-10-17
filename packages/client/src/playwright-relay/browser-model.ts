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
  /** Set while the relay removes the tab, so its beforeunload prompt is accepted. */
  closing?: boolean;
  /**
   * The extension has put the tab in its group since the debugger last let
   * go of it: it announced the tab (chrome.tabs.onCreated), or the relay
   * created it.
   */
  inGroup?: boolean;
  /** The debugger let go and the extension never asked for it back: the user dragged it out. */
  removed?: boolean;
  /** When the debugger last let go of the tab. */
  lastDetachAt?: number;
  /** Why the last attach failed, verbatim from Chrome. */
  lastError?: string;
  removalTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Where a Chrome tab stands with this relay. Chrome detaches the debugger
 * from a whole tab when another extension frames itself into the page (a
 * password manager's fill menu) and refuses to re-attach until the frame is
 * gone; the extension asks for the tab back (chrome.tabs.onCreated) about
 * 150ms after the detach and again whenever the tab's URL changes. A detach
 * with no such request means the user took the tab out of the group, unless
 * the tab also detached shortly before: the extension skips its retry for a
 * tab that re-detaches within REATTACH_COOLDOWN_MS (each sign-in field focus
 * reopens the password manager's frame), so that tab stays disconnected.
 *
 * The relay attaches only when the extension asks. The extension adds any
 * tab it attaches to its group, and it says nothing when a detached tab is
 * dragged out, so an attach the relay started could pull that tab back in.
 */
export type TabLink = {
  state: "connected" | "disconnected" | "removed" | "closed";
  /** The last re-attach failure, verbatim. */
  lastError?: string;
};

/** How long the extension has to ask for a detached tab back before it counts as dragged out. */
const REATTACH_GRACE_MS = 2_000;
/** The extension's own window: it does not retry a tab that re-detaches within this long. */
const REATTACH_COOLDOWN_MS = 3_000;

export class BrowserModel {
  private _sendToExtension: SendCommand;
  private _sendToCDPClient: SendToCDPClient | null = null;
  /** One lifecycle record per Chrome tab; session and attachment cannot drift into separate maps. */
  private _tabs = new Map<number, TabState>();
  /** A tab keeps its target id for life; kept after detach and close so its pages stay nameable. */
  private _targetTabs = new Map<string, number>();
  private _closedTabs = new Set<number>();
  private _autoAttach = false;
  private _nextSessionId = 1;
  private _log: (message: string) => void;
  private _onTabLink: (tabId: number, link: TabLink) => void = () => {};

  constructor(sendToExtension: SendCommand, log: (message: string) => void = () => {}) {
    this._sendToExtension = sendToExtension;
    this._log = log;
  }

  onTabLinkChange(listener: (tabId: number, link: TabLink) => void): void {
    this._onTabLink = listener;
  }

  tabLink(tabId: number): TabLink | undefined {
    if (this._closedTabs.has(tabId)) return { state: "closed" };
    const state = this._tabs.get(tabId);
    if (!state) return undefined;
    if (state.session) return { state: "connected" };
    const lastError = state.lastError !== undefined ? { lastError: state.lastError } : {};
    return { state: state.removed ? "removed" : "disconnected", ...lastError };
  }

  /**
   * One attach attempt for a tab the debugger lost, while a sign-in wait
   * watches it. The extension asks for a blocked tab back only when its URL
   * changes, and a signed-in single-page app may never change it. This can
   * pull a tab the user dragged out while detached back into the group, so
   * it runs only during a sign-in wait.
   */
  async retryAttach(tabId: number): Promise<TabLink | undefined> {
    const state = this._tabs.get(tabId);
    if (state && !state.session && !state.attachment && !state.removed && state.lastDetachAt !== undefined) {
      await this._reattach(tabId, state, "sign-in wait retry");
    }
    return this.tabLink(tabId);
  }

  /**
   * Drop an attached tab's debugger session and attach afresh. A tab
   * re-attached mid sign-in can come back with a session that never reports
   * the page's JavaScript context, so every evaluate hangs; a new session
   * starts clean. The tab stays in the group throughout, so this cannot pull
   * a dragged-out tab back in.
   */
  async refreshAttach(tabId: number): Promise<TabLink | undefined> {
    const state = this._tabs.get(tabId);
    const session = state?.session;
    if (!state || !session) return this.tabLink(tabId);
    this._log(`refresh tab ${tabId}: its debugger session is unresponsive`);
    state.session = undefined;
    // A blocked attach leaves the tab detached, for a sign-in wait to retry.
    state.lastDetachAt = Date.now();
    this._emitDetached(session);
    await this._sendToExtension("chrome.debugger.detach", [{ tabId }]).catch(() => {});
    await this._reattach(tabId, state, "refresh");
    if (!state.session) this._notifyTabLink(tabId);
    return this.tabLink(tabId);
  }

  private async _reattach(tabId: number, state: TabState, why: string): Promise<void> {
    this._log(`reattach tab ${tabId} (${why})`);
    try {
      await this._attachTab(tabId);
      this._log(`reattached tab ${tabId}`);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      this._log(`reattach tab ${tabId} failed: ${state.lastError}`);
    }
  }

  private _notifyTabLink(tabId: number): void {
    const link = this.tabLink(tabId);
    if (link) this._onTabLink(tabId, link);
  }

  connectOverCDP(sendToCDPClient: SendToCDPClient): void {
    this._sendToCDPClient = sendToCDPClient;
  }

  private _emit(message: CDPMessage): void {
    this._sendToCDPClient?.(message);
  }

  onTabCreated(tab: Tab): void {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    let state = this._tabs.get(tabId);
    if (!state) {
      state = {};
      this._tabs.set(tabId, state);
    }
    // After a detach this is the extension asking for the tab back (or the
    // user returning a tab they dragged out).
    const detached = state.session === undefined && state.lastDetachAt !== undefined;
    clearTimeout(state.removalTimer);
    state.removalTimer = undefined;
    state.inGroup = true;
    if (state.removed) {
      state.removed = false;
      this._notifyTabLink(tabId);
    }
    if (!this._autoAttach || state.session || state.attachment) return;
    if (detached || state.lastError !== undefined) {
      void this._reattach(tabId, state, "extension retry");
    } else {
      void this._attachTab(tabId).catch((error) => {
        state.lastError = error instanceof Error ? error.message : String(error);
        console.error(error);
      });
    }
  }

  onTabRemoved(tabId: number): void {
    const state = this._tabs.get(tabId);
    if (!state) return;
    clearTimeout(state.removalTimer);
    this._tabs.delete(tabId);
    this._closedTabs.add(tabId);
    this._notifyTabLink(tabId);
    if (state.session) this._emitDetached(state.session);
  }

  onDebuggerEvent(source: DebuggerSession, method: string, params: any): void {
    if (source.tabId === undefined) return;
    const state = this._tabs.get(source.tabId);
    const tabSession = state?.session;
    if (!tabSession) return;
    if (
      state.closing &&
      method === "Page.javascriptDialogOpening" &&
      params?.type === "beforeunload"
    ) {
      void this._sendToExtension("chrome.debugger.sendCommand", [
        source,
        "Page.handleJavaScriptDialog",
        { accept: true },
      ]).catch(() => {});
      return;
    }
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

  async createTarget(
    url: string | undefined,
    background = false
  ): Promise<{ targetId: string | undefined }> {
    const tab = await this._sendToExtension("chrome.tabs.create", [
      { url, ...(background ? { active: false } : {}) },
    ]);
    if (tab?.id === undefined) throw new Error("Failed to create tab");
    if (!this._tabs.has(tab.id)) this._tabs.set(tab.id, {});
    this._tabs.get(tab.id)!.inGroup = true;
    const tabSession = await this._attachTab(tab.id);
    return { targetId: tabSession.targetInfo?.targetId };
  }

  /** The Chrome tab id behind an attached target, if this model attached it. */
  tabIdForTarget(targetId: string): number | undefined {
    return this._targetTabs.get(targetId);
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
      state.lastError = undefined;
      const targetId = tabSession.targetInfo?.targetId;
      if (typeof targetId === "string") this._targetTabs.set(targetId, tabId);
      this._notifyTabLink(tabId);
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

  /**
   * CDP's Target.closeTarget skips beforeunload handlers, but chrome.tabs.remove
   * runs them, so a page with unsaved input (e.g. a drafted comment) would
   * prompt "Leave site?". Page.enable makes Chrome report that prompt, and
   * onDebuggerEvent accepts it.
   */
  private async _removeTab(tabId: number): Promise<void> {
    const state = this._tabs.get(tabId);
    if (state?.session) {
      state.closing = true;
      await this._sendToExtension("chrome.debugger.sendCommand", [
        { tabId },
        "Page.enable",
      ]).catch(() => {});
    }
    try {
      await this._sendToExtension("chrome.tabs.remove", [tabId]);
    } catch (error) {
      if (state) state.closing = false;
      throw error;
    }
  }

  private _detachTab(tabId: number): void {
    const state = this._tabs.get(tabId);
    if (!state?.session) return;
    const session = state.session;
    state.session = undefined;
    state.inGroup = false;
    clearTimeout(state.removalTimer);
    state.removalTimer = undefined;
    const now = Date.now();
    const recent = state.lastDetachAt !== undefined && now - state.lastDetachAt < REATTACH_COOLDOWN_MS;
    state.lastDetachAt = now;
    if (recent) {
      this._log(`tab ${tabId} detached again within ${REATTACH_COOLDOWN_MS}ms; waiting for the extension to ask for it back`);
    } else state.removalTimer = setTimeout(() => {
      state.removalTimer = undefined;
      if (state.inGroup || state.session || this._tabs.get(tabId) !== state) return;
      state.removed = true;
      this._log(`tab ${tabId} left the Lenses group`);
      this._notifyTabLink(tabId);
    }, REATTACH_GRACE_MS);
    state.removalTimer?.unref?.();
    // Recorded before Puppeteer hears of the detach, so the host can tell a
    // lost debugger from a closed tab when the page object goes away.
    this._notifyTabLink(tabId);
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
