// Launch an owned Chrome. Never connectOverCDP, never port 9222, never the
// daily profile. Playwright's persistent context is our child process.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { assertNotDailyChrome } from "./profile";

export const OWNED_CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  // Continue where you left off. Chrome then keeps session cookies on a clean exit.
  "--restore-last-session",
];
const LAUNCH_ARGS = OWNED_CHROME_ARGS;

/** Chrome's "Continue where you left off". Session cookies survive a clean exit. */
export const RESTORE_LAST_SESSION = 1;

export function keepSessionCookies(userDataDir: string): void {
  const dir = path.join(userDataDir, "Default");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "Preferences");
  let prefs: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") prefs = parsed as Record<string, unknown>;
    } catch {
      prefs = {};
    }
  }
  const session = prefs.session && typeof prefs.session === "object" ? { ...(prefs.session as Record<string, unknown>) } : {};
  session.restore_on_startup = RESTORE_LAST_SESSION;
  prefs.session = session;
  writeFileSync(file, JSON.stringify(prefs));
}

export async function launchOwnedChrome(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  keepSessionCookies(opts.userDataDir);
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
