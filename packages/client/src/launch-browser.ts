/**
 * Browser presence and launch. Chrome must be running before the Playwright
 * Extension connect page can attach, and a named profile is required so Chrome
 * does not stall on the profile picker (which loads no extensions).
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
    return false;
  }
}

export function launchBrowser(profile = "Default"): Promise<boolean> {
  return runChrome([profileArgument(profile)]);
}

/**
 * Open the Playwright Extension connect page in the selected profile. Invoke
 * Chrome directly so its singleton forwards the URL to the existing profile;
 * macOS `open -n` incorrectly launches another application instance.
 */
export function openUrlInChrome(url: string, profile = "Default"): Promise<boolean> {
  return runChrome([profileArgument(profile), url]);
}

/** Capture/restore focus because the stock extension explicitly focuses its selected tab. */
export async function foregroundApplication(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; app ? ObjC.unwrap(app.bundleIdentifier) : ""',
    ]);
    const bundleId = stdout.trim();
    return bundleId || undefined;
  } catch {
    return undefined;
  }
}

export async function restoreForegroundApplication(
  bundleId: string | undefined
): Promise<void> {
  if (process.platform !== "darwin" || !bundleId || bundleId === "com.google.Chrome") return;
  try {
    await run("/usr/bin/open", ["-b", bundleId]);
  } catch {
    // Focus restoration is best-effort and must not fail browser acquisition.
  }
}

function profileArgument(profile: string): string {
  return `--profile-directory=${profile}`;
}

/**
 * Invoke Chrome itself rather than macOS `open`: `open` sends URLs to whichever
 * profile owns the running application and drops `--args`, which can open an
 * extension URL in a profile where that extension is not installed.
 */
function runChrome(args: string[]): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : process.platform === "win32"
        ? "chrome"
        : "google-chrome";
  return runDetached(command, args);
}

function runDetached(command: string, args: string[]): Promise<boolean> {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    });
  } catch {
    return Promise.resolve(false);
  }
}
