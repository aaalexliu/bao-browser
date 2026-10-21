// Launch an owned Chrome. Never connectOverCDP, never port 9222, never the
// daily profile. Playwright's persistent context is our child process.

import { readdirSync, readFileSync } from "node:fs";
import { chromium, type BrowserContext } from "playwright";
import { assertNotDailyChrome } from "./profile";

const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--disable-sync"];

export async function launchOwnedChrome(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    channel: "chrome",
    headless: opts.headless ?? true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: opts.deviceScaleFactor,
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: { width: 1280, height: 720 } } : undefined,
    args: [...LAUNCH_ARGS, ...(opts.args ?? [])],
  });
  assertOwnedProcess(ctx, opts.userDataDir);
  return ctx;
}

/** The child we spawned, not a browser that was already listening on 9222. */
export function assertOwnedProcess(_ctx: BrowserContext, userDataDir: string): void {
  const cmd = findChromeCmdline(userDataDir);
  if (cmd.includes("remote-debugging-port=9222")) {
    throw new Error("Chrome was started with remote-debugging-port 9222.");
  }
  if (cmd.includes(".config/google-chrome") || cmd.includes("Google/Chrome")) {
    throw new Error("Chrome cmdline points at the daily profile.");
  }
}

function findChromeCmdline(userDataDir: string): string {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    throw new Error("Cannot inspect /proc to confirm the owned Chrome process.");
  }
  for (const pid of pids) {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`);
      const cmd = raw.toString("utf8").replace(/\0/g, " ");
      if (cmd.includes(userDataDir) && /chrome/i.test(cmd)) return cmd;
    } catch { /* process exited or is not readable */ }
  }
  throw new Error(`No Chrome process was launched with user-data-dir ${userDataDir}.`);
}
