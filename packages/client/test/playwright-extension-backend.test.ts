import { describe, expect, it, vi } from "vitest";
import {
  isPlaywrightConnectPage,
  retainPlaywrightAnchor,
} from "../src/playwright-extension-backend.js";

const connectUrl =
  "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?token=redacted";

describe("Playwright broker anchor", () => {
  it("requests lease release only when the user closes the anchor", async () => {
    let closeListener: (() => void) | undefined;
    let closed = false;
    const page = {
      on: vi.fn((_event: string, listener: () => void) => {
        closeListener = listener;
      }),
      off: vi.fn(),
      isClosed: () => closed,
      close: vi.fn(async () => {
        closed = true;
        closeListener?.();
      }),
    };
    const requested = vi.fn();
    const anchor = retainPlaywrightAnchor(page as never, requested);

    closed = true;
    closeListener?.();
    expect(requested).toHaveBeenCalledOnce();
    await anchor.release();
    expect(requested).toHaveBeenCalledOnce();
  });

  it("closes the anchor without turning intentional release into another request", async () => {
    let closeListener: (() => void) | undefined;
    const page = {
      on: (_event: string, listener: () => void) => {
        closeListener = listener;
      },
      off: vi.fn(),
      isClosed: () => false,
      close: vi.fn(async () => closeListener?.()),
    };
    const requested = vi.fn();
    const anchor = retainPlaywrightAnchor(page as never, requested);

    await anchor.release();

    expect(page.close).toHaveBeenCalledOnce();
    expect(page.off).toHaveBeenCalledWith("close", closeListener);
    expect(requested).not.toHaveBeenCalled();
  });

  it("recognizes the controlled connect page used as the anchor", () => {
    expect(isPlaywrightConnectPage({ url: () => connectUrl } as never)).toBe(true);
  });

  it("does not treat ordinary or other extension pages as the anchor", () => {
    expect(
      isPlaywrightConnectPage({ url: () => "https://example.com/lens" } as never)
    ).toBe(false);
    expect(
      isPlaywrightConnectPage({
        url: () =>
          "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html",
      } as never)
    ).toBe(false);
  });
});
