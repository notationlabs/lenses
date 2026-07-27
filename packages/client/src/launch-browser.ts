/**
 * Browser presence and launch. The broker cannot wake a dormant extension
 * service worker directly, but starting Chrome makes the worker's
 * runtime.onStartup fire, which reconnects it. A running Chrome needs nothing:
 * the worker's reconnect alarm attaches within its 30s period.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function autoLaunchEnabled(): boolean {
  return process.env.LENS_BROKER_AUTO_LAUNCH !== "0";
}

export async function browserRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("tasklist", [
        "/fi",
        "imagename eq chrome.exe",
        "/nh",
      ]);
      return stdout.toLowerCase().includes("chrome.exe");
    }
    await run("pgrep", [
      "-x",
      process.platform === "darwin" ? "Google Chrome" : "chrome",
    ]);
    return true;
  } catch {
    // A non-zero pgrep exit means no match, which is the answer, not a failure.
    return false;
  }
}

/**
 * Starts Chrome without raising it and without a URL: the extension opens and
 * disposes of its own tab per call, so navigating here would leave one behind
 * and steal focus.
 *
 * The profile must be named. Started bare, Chrome shows the profile picker,
 * which loads no extensions at all — the launch would then "succeed" while
 * leaving the extension as unreachable as before.
 */
export async function launchBrowser(profile = "Default"): Promise<boolean> {
  const profileArg = `--profile-directory=${profile}`;
  try {
    if (process.platform === "darwin") {
      await run("open", ["-g", "-n", "-a", "Google Chrome", "--args", profileArg]);
      return true;
    }
    const command = process.platform === "win32" ? "chrome" : "google-chrome";
    const child = spawn(command, [profileArg], { detached: true, stdio: "ignore" });
    child.unref();
    return await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      // No error by the time it is spawned means the binary exists and started.
      child.once("spawn", () => resolve(true));
    });
  } catch {
    return false;
  }
}
