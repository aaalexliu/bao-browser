// Launch an owned browser. Never port 9222, never the daily profile.
// Capture, replay, login import, and computer-use start the installed Google
// Chrome and attach over a private debugging port. Playwright's launcher is
// only used when a caller asks for page.video().

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { assertNotDailyChrome } from "./profile";

export const ACCOUNT_CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** The real binary. A PATH wrapper in this environment injects --no-sandbox and port 9222. */
export const LINUX_CHROME = "/opt/google/chrome/chrome";

const BANNED_ACCOUNT_ARGS = [
  "--enable-automation",
  "--disable-extensions",
  "--use-mock-keychain",
  "--password-store=basic",
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
];

export const OWNED_CHROME_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  // Continue where you left off. Chrome then keeps session cookies on a clean exit.
  "--restore-last-session",
];

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

/**
 * Linux CI cannot start the sandbox. macOS can, and a desktop Linux session can.
 * BAO_CHROME_NO_SANDBOX=1 opts in on Linux only. It never applies on macOS.
 */
export function needsLinuxNoSandbox(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin") return false;
  if (env.BAO_CHROME_NO_SANDBOX === "1") return true;
  return env.CI === "1" || env.CI === "true";
}

/** Headed on a Mac unless asked otherwise. Linux stays headless until BAO_HEADED=1. */
export function productHeadless(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.BAO_HEADED === "1") return false;
  if (env.BAO_HEADED === "0") return true;
  return platform !== "darwin";
}

/** Owned Chrome only. Account Chrome never receives the sandbox opt-in. */
export function ownedChromeLaunchArgs(extra: string[] = [], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const mac = platform === "darwin" ? ["--force-renderer-accessibility"] : [];
  const sandbox = needsLinuxNoSandbox(env, platform) ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const drop = new Set([
    "--enable-automation",
    "--disable-blink-features=AutomationControlled",
    "--disable-extensions",
    "--use-mock-keychain",
    "--password-store=basic",
    "--enable-unsafe-swiftshader",
  ]);
  const cleaned = extra.filter((arg) => {
    if (drop.has(arg)) return false;
    if (platform === "darwin" && (arg === "--no-sandbox" || arg === "--disable-dev-shm-usage")) return false;
    return true;
  });
  return [...OWNED_CHROME_ARGS, ...mac, ...sandbox, ...cleaned];
}

/** macOS Accessibility only sees the page when the renderer publishes it. */
function ownedLaunchArgs(extra: string[] | undefined): string[] {
  return ownedChromeLaunchArgs(extra ?? []);
}

const DAILY_DIR = [
  "/.config/google-chrome",
  "/.config/chromium",
  "/Application Support/Google/Chrome",
  "/Google/Chrome/User Data",
];

/**
 * Installed Google Chrome when it is present, otherwise BAO_BROWSER, otherwise
 * Playwright's Chromium. Never a PATH lookup: wrappers can add automation flags.
 */
export function resolveNormalChrome(exists: (file: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin" && exists(ACCOUNT_CHROME_MAC)) return ACCOUNT_CHROME_MAC;
  if (platform === "linux" && exists(LINUX_CHROME)) return LINUX_CHROME;
  const bundled = env.BAO_BROWSER;
  if (bundled && exists(bundled)) return bundled;
  try {
    const fallback = chromium.executablePath();
    if (fallback && exists(fallback)) return fallback;
  } catch { /* Playwright has not downloaded a browser. */ }
  throw new Error("Chrome was not found");
}

/** Installed Google Chrome when it is present, otherwise the bundled browser. */
export function resolveAccountChrome(exists: (file: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): string {
  return resolveNormalChrome(exists, env);
}

/** Flags for a normal Chrome window. No automation switch and no Playwright defaults. */
export function accountLaunchArgs(port: number): string[] {
  if (port === 9222) throw new Error("Chrome was started with remote-debugging-port 9222.");
  const args = [
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  if (process.platform === "darwin") args.push("--force-renderer-accessibility");
  for (const flag of BANNED_ACCOUNT_ARGS) {
    if (args.includes(flag)) throw new Error(flag);
  }
  return args;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 15000;
  let last = "not open";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      last = String(response.status);
    } catch (err) {
      last = err instanceof Error ? err.message : "not open";
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Chrome debugging port did not open (${last})`);
}

/**
 * Account browser: the user's Chrome, our profile, then a CDP attach.
 * Headless and headed both go through launchOwnedChrome. noDefaults skips
 * focus and media emulation. Runtime.enable happens when a page is driven,
 * not as a launch flag.
 */
export async function launchAccountChrome(opts: {
  userDataDir: string;
  headless?: boolean;
}): Promise<BrowserContext> {
  if (opts.headless) return launchOwnedChrome(opts);
  assertNotDailyChrome(opts.userDataDir);
  keepSessionCookies(opts.userDataDir);
  const exe = resolveAccountChrome();
  let port = await freeLoopbackPort();
  if (port === 9222) port = await freeLoopbackPort();
  const args = accountLaunchArgs(port);
  const child: ChildProcess = spawn(exe, [`--user-data-dir=${opts.userDataDir}`, ...args], { stdio: "ignore" });
  const stop = () => {
    if (child.exitCode == null) child.kill("SIGTERM");
  };
  try {
    await waitForCdp(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    const verdict = assessOwnedCommand(readOwnedCommand(child.pid, opts.userDataDir, process.platform), opts.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    browser.on("disconnected", stop);
    const orig = context.close.bind(context);
    context.close = async () => {
      try {
        await orig();
      } finally {
        stop();
        await browser.close().catch(() => undefined);
      }
    };
    return context;
  } catch (err) {
    stop();
    throw err;
  }
}

const AUTOMATION_SWITCHES = [
  "--enable-automation",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--use-mock-keychain",
  "--password-store=basic",
  "--no-sandbox",
  "--enable-unsafe-swiftshader",
  "--disable-blink-features=AutomationControlled",
];

/**
 * Capture and replay start the real Chrome binary and attach over a private
 * CDP port. Playwright's launchPersistentContext puts on --no-sandbox, a
 * debugging pipe, and a pile of --disable-* switches, and that launch reports
 * navigator.webdriver true. A normal process with only a debugging port keeps
 * webdriver false after connectOverCDP, including after Runtime.evaluate.
 * noDefaults skips viewport and media emulation. videoDir is the one path that
 * still uses Playwright's launcher, because page.video() does not exist on a
 * CDP attach. The Mac window recorder does not need it.
 */
export async function launchOwnedChrome(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
  /** Accepted so older callers compile. The binary is resolveNormalChrome, not a channel lookup. */
  channel?: "chrome";
}): Promise<BrowserContext> {
  if (opts.videoDir) return launchOwnedChromeForVideo(opts);
  return launchNormalChrome(opts);
}

async function launchNormalChrome(opts: {
  userDataDir: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  mkdirSync(opts.userDataDir, { recursive: true });
  keepSessionCookies(opts.userDataDir);
  const exe = resolveNormalChrome();
  let port = await freeLoopbackPort();
  if (port === 9222) port = await freeLoopbackPort();
  const headless = opts.headless ?? true;
  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    ...ownedLaunchArgs(opts.args),
    `--remote-debugging-port=${port}`,
    ...(headless ? ["--headless=new"] : []),
  ];
  const child: ChildProcess = spawn(exe, args, { stdio: "ignore" });
  const stop = () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  };
  try {
    await waitForCdp(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    if (opts.deviceScaleFactor && opts.deviceScaleFactor !== 1) await applyDeviceScale(context, opts.deviceScaleFactor);
    const verdict = assessOwnedCommand(readOwnedCommand(child.pid, opts.userDataDir, process.platform), opts.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    let closed = false;
    browser.on("disconnected", () => {
      if (!closed) stop();
    });
    context.close = async () => {
      if (closed) return;
      closed = true;
      const open = context.pages().find((page) => !page.isClosed());
      if (open) {
        try {
          const session = await context.newCDPSession(open);
          await session.send("Browser.close");
        } catch { /* The process may already be gone. */ }
      }
      await releaseProfileProcesses(opts.userDataDir, child);
      await browser.close().catch(() => undefined);
    };
    return context;
  } catch (err) {
    stop();
    await releaseProfileProcesses(opts.userDataDir, child);
    throw err;
  }
}

async function applyDeviceScale(context: BrowserContext, deviceScaleFactor: number): Promise<void> {
  const apply = async (page: import("playwright").Page) => {
    const session = await context.newCDPSession(page);
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor,
      mobile: false,
    });
  };
  context.on("page", (page) => { void apply(page).catch(() => undefined); });
  for (const page of context.pages()) await apply(page);
}

async function releaseProfileProcesses(userDataDir: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && child.exitCode == null && child.signalCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode == null && child.signalCode == null) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  const killAt = Date.now() + 1500;
  while (Date.now() < killAt && child.exitCode == null && child.signalCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of pidsForDataDir(userDataDir)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** Playwright video only. The pipe and default switches come back with it. */
async function launchOwnedChromeForVideo(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  keepSessionCookies(opts.userDataDir);
  const exe = resolveNormalChrome();
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    executablePath: exe,
    headless: opts.headless ?? true,
    viewport: null,
    deviceScaleFactor: opts.deviceScaleFactor,
    chromiumSandbox: true,
    ignoreDefaultArgs: AUTOMATION_SWITCHES,
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
