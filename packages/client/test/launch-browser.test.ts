import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: unknown }>,
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn(command: string, args: string[], options: unknown) {
    state.calls.push({ command, args, options });
    const listeners = new Map<string, () => void>();
    const child = {
      unref() {},
      once(event: string, listener: () => void) {
        listeners.set(event, listener);
        if (event === "spawn") queueMicrotask(listener);
        return child;
      },
    };
    return child;
  },
}));

import { openUrlInChrome } from "../src/launch-browser.js";

describe("opening the Playwright connect page", () => {
  it("uses one profile-aware Chrome invocation", async () => {
    state.calls.length = 0;
    await expect(
      openUrlInChrome("chrome-extension://extension/connect.html", "Profile 4")
    ).resolves.toBe(true);

    expect(state.calls).toEqual([{
      command:
        process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : process.platform === "win32"
            ? "chrome"
            : "google-chrome",
      args: [
        "--profile-directory=Profile 4",
        "chrome-extension://extension/connect.html",
      ],
      options: { detached: true, stdio: "ignore" },
    }]);
  });
});
