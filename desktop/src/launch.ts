// Launch an owned browser. Never connectOverCDP, never port 9222, never the
// daily profile. The default binary is Playwright's Chromium, not the user's
// installed Chrome. Playwright's persistent context is our child process.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { assertNotDailyChrome } from "./profile";

const LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check", "--disable-sync"];

/** macOS Accessibility only sees the page when the renderer publishes it. */
function ownedLaunchArgs(extra: string[] | undefined): string[] {
  const mac = process.platform === "darwin" ? ["--force-renderer-accessibility"] : [];
  return [...LAUNCH_ARGS, ...mac, ...(extra ?? [])];
}

const DAILY_DIR = [
  "/.config/google-chrome",
  "/.config/chromium",
  "/Application Support/Google/Chrome",
  "/Google/Chrome/User Data",
];

export async function launchOwnedChrome(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
  /** Opt in to the installed Google Chrome. The default is Playwright's Chromium. */
  channel?: "chrome";
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  const bundled = opts.channel ? undefined : process.env.BAO_BROWSER;
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    channel: opts.channel,
    executablePath: bundled || undefined,
    headless: opts.headless ?? true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: opts.deviceScaleFactor,
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: { width: 1280, height: 720 } } : undefined,
    args: ownedLaunchArgs(opts.args),
  });
  try {
    assertOwnedProcess(ctx, opts.userDataDir);
  } catch (err) {
    await ctx.close();
    throw err;
  }
  return ctx;
}

export interface OwnedVerdict {
  ok: boolean;
  reason?: string;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** The child we spawned. The binary path is not the profile. */
export function assertOwnedProcess(ctx: BrowserContext, userDataDir: string): void {
  void ctx;
  const pid = browserPidFromLauncher(userDataDir, process.pid, listProcesses());
  const cmd = readOwnedCommand(pid, userDataDir, process.platform);
  const verdict = assessOwnedCommand(cmd, userDataDir);
  if (!verdict.ok) throw new Error(verdict.reason);
}

/** Descendant of the launcher whose command line names this profile. */
export function browserPidFromLauncher(userDataDir: string, selfPid: number, rows: readonly ProcessRow[]): number | undefined {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const kids = children.get(row.ppid) ?? [];
    kids.push(row.pid);
    children.set(row.ppid, kids);
  }
  const stack = [...(children.get(selfPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop();
    if (pid == null || seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((item) => item.pid === pid);
    if (row && row.command.includes(userDataDir) && /chrome|chromium/i.test(row.command)) return pid;
    stack.push(...(children.get(pid) ?? []));
  }
  return undefined;
}

export function assessOwnedCommand(cmd: string, userDataDir: string): OwnedVerdict {
  if (/remote-debugging-port(?:=|\s+)9222/.test(cmd)) {
    return { ok: false, reason: "Chrome was started with remote-debugging-port 9222." };
  }
  const dir = userDataDirArg(cmd);
  if (!dir || path.resolve(dir) !== path.resolve(userDataDir)) {
    return { ok: false, reason: `No browser process was launched with user-data-dir ${userDataDir}.` };
  }
  if (isDailyProfileDir(dir)) {
    return { ok: false, reason: "Browser cmdline points at the daily profile." };
  }
  return { ok: true };
}

export function readOwnedCommand(
  pid: number | undefined,
  userDataDir: string,
  platform: NodeJS.Platform,
  readPid: (pid: number) => string = defaultPs,
): string {
  if (platform === "darwin") {
    if (!pid) throw new Error("Owned browser pid was not available from the launcher.");
    return readPid(pid).trim();
  }
  if (pid && platform === "linux") return readProcCmdline(pid);
  if (platform === "linux") return findChromeCmdline(userDataDir);
  if (!pid) throw new Error("Owned browser pid was not available from the launcher.");
  return readPid(pid).trim();
}

function defaultPs(pid: number): string {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
}

/** Chrome processes whose --user-data-dir is this profile. */
export function pidsForDataDir(userDataDir: string): number[] {
  const resolved = path.resolve(userDataDir);
  return listProcesses().flatMap((row) => {
    if (!/chrome|chromium/i.test(row.command)) return [];
    const dir = userDataDirArg(row.command);
    return dir && path.resolve(dir) === resolved ? [row.pid] : [];
  });
}

function listProcesses(): ProcessRow[] {
  const out = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] || "" });
  }
  return rows;
}

function readProcCmdline(pid: number): string {
  return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replace(/\0/g, " ");
}

function userDataDirArg(cmd: string): string | undefined {
  const match = cmd.match(/--user-data-dir(?:=|\s+)(.*?)(?:\s+--|$)/);
  const dir = match?.[1]?.trim();
  return dir || undefined;
}

function isDailyProfileDir(dir: string): boolean {
  const norm = dir.replace(/\\/g, "/");
  return DAILY_DIR.some((needle) => norm.includes(needle));
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
      const cmd = readProcCmdline(Number(pid));
      if (cmd.includes(userDataDir) && /chrome|chromium/i.test(cmd)) return cmd;
    } catch { /* process exited or is not readable */ }
  }
  throw new Error(`No browser process was launched with user-data-dir ${userDataDir}.`);
}
