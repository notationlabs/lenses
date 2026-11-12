import type { Page } from "puppeteer-core";
import { sameTarget, urlOrigin, type CaptureBuffer } from "@notation/lenses-core";
import type { BindRequest } from "./browser-backend.js";

/** A lens `ready` selector, plus the call's needs-the-user test that also ends the wait. */
interface ReadyCheck {
  selector: string;
  needsUser?: BindRequest["holdAt"];
}

function readyCheck(request: BindRequest): ReadyCheck | undefined {
  return request.ready ? { selector: request.ready, needsUser: request.holdAt } : undefined;
}

const LOAD_GRACE_MS = 500;
/** Upper bound on waiting for an in-page app's requests to go quiet after a load or route. */
const IN_PAGE_SETTLE_MS = 10_000;
const URL_POLL_MS = 250;

/** Loading, reloading and in-page routing of a bound tab, and the waits that follow. */
export function createPageNavigation(
  log: (message: string) => void,
  resetCaptures: (page: Page) => CaptureBuffer
) {
  async function reloadPage(page: Page, loadTimeoutMs: number): Promise<void> {
    resetCaptures(page);
    await settle(page.reload({ waitUntil: "load", timeout: loadTimeoutMs }));
  }

  /**
   * `navigate: "in-page"`: change the route the way the app's own links do,
   * so in-memory session state survives. Cross-origin targets cannot be
   * reached in-page and load normally.
   */
  async function routeInPage(
    page: Page,
    target: string,
    loadTimeoutMs: number,
    ready?: ReadyCheck
  ): Promise<void> {
    if (urlOrigin(page.url()) !== urlOrigin(target)) {
      resetCaptures(page);
      await settle(page.goto(target, { waitUntil: "load", timeout: loadTimeoutMs }));
      await settleApp(page, loadTimeoutMs, ready);
      return;
    }
    resetCaptures(page);
    const url = new URL(target);
    await page.evaluate((path: string) => {
      history.pushState(history.state, "", path);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }, url.pathname + url.search + url.hash);
    await settleApp(page, loadTimeoutMs, ready);
  }

  /**
   * An app that routes in-page also boots in-page: after `load` it may still
   * be fetching, or show a transient screen and redirect. With a lens `ready`
   * selector, wait up to `loadTimeoutMs` for it (or for a page that needs the
   * user); otherwise wait, for at most IN_PAGE_SETTLE_MS, for the app's
   * requests to go quiet.
   */
  async function settleApp(page: Page, loadTimeoutMs: number, ready?: ReadyCheck): Promise<void> {
    if (ready) {
      await awaitReady(page, ready, Date.now() + loadTimeoutMs);
      return;
    }
    await page
      .waitForNetworkIdle({ idleTime: LOAD_GRACE_MS, timeout: Math.min(loadTimeoutMs, IN_PAGE_SETTLE_MS) })
      .catch(() => {});
  }

  async function settleReady(page: Page, request: BindRequest): Promise<void> {
    const ready = readyCheck(request);
    if (ready) await settleApp(page, request.loadTimeoutMs, ready);
  }

  async function awaitReady(page: Page, ready: ReadyCheck, deadline: number): Promise<void> {
    while (!page.isClosed()) {
      const matched = await page
        .evaluate((selector: string) => document.querySelector(selector) !== null, ready.selector)
        .catch(() => false);
      if (matched) return;
      const title = await page.title().catch(() => "");
      if (await ready.needsUser?.({ url: page.url(), title }).catch(() => false)) {
        log(`ready: ${page.url()} needs the user`);
        return;
      }
      if (Date.now() >= deadline) {
        log(`ready: ${ready.selector} did not appear at ${page.url()}`);
        return;
      }
      await delay(URL_POLL_MS);
    }
  }

  /**
   * Serve a `navigate: "fresh"` step: reload when the tab is still on the
   * lens's origin, otherwise go back to the lens URL (an earlier step may
   * have taken the tab elsewhere).
   */
  async function navigateFresh(
    page: Page,
    target: string,
    loadTimeoutMs: number,
    inPage = false
  ): Promise<void> {
    if (inPage) {
      await routeInPage(page, target, loadTimeoutMs);
      return;
    }
    if (urlOrigin(page.url()) === urlOrigin(target)) {
      await reloadPage(page, loadTimeoutMs);
      return;
    }
    resetCaptures(page);
    await settle(page.goto(target, { waitUntil: "load", timeout: loadTimeoutMs }));
  }

  /**
   * Take a bound tab to the call's target and wait for the lens `ready`
   * selector. A tab already at the target is reloaded only for
   * `navigation: "fresh"`, and never under `navigate: "in-page"`, where a
   * reload would lose the app's in-memory session. Returns whether it navigated.
   */
  async function navigateBound(page: Page, target: string, request: BindRequest): Promise<boolean> {
    const ready = readyCheck(request);
    if (!sameTarget(page.url(), target)) {
      if (request.inPage) {
        await routeInPage(page, target, request.loadTimeoutMs, ready);
        return true;
      }
      resetCaptures(page);
      await settle(page.goto(target, { waitUntil: "load", timeout: request.loadTimeoutMs }));
    } else if (request.navigation === "fresh" && !request.inPage) {
      await reloadPage(page, request.loadTimeoutMs);
    } else {
      return false;
    }
    if (ready) await settleApp(page, request.loadTimeoutMs, ready);
    return true;
  }

  return { reloadPage, routeInPage, settleReady, navigateFresh, navigateBound };
}

export async function settle(action: Promise<unknown>): Promise<void> {
  await action;
  await delay(LOAD_GRACE_MS);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
