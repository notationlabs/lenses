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
      child.once("spawn", () => resolve(true));
    });
  } catch {
    return false;
  }
}

/** Open a URL in the running profile (used for the Playwright Extension connect page). */
export async function openUrlInChrome(url: string, profile = "Default"): Promise<boolean> {
  const profileArg = `--profile-directory=${profile}`;
  try {
    if (process.platform === "darwin") {
      await run("open", ["-g", "-a", "Google Chrome", "--args", profileArg, url]);
      return true;
    }
    const command = process.platform === "win32" ? "chrome" : "google-chrome";
    const child = spawn(command, [profileArg, url], { detached: true, stdio: "ignore" });
    child.unref();
    return await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    });
  } catch {
    return false;
  }
}
