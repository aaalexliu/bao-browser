// Launch an owned browser. Never port 9222, never the daily profile.
// Capture, replay, login import, and computer-use start the installed Google
// Chrome and attach over a private debugging port. Playwright's launcher is
// only used when a caller asks for page.video(). The hermetic test lane sets
// BAO_TEST_BROWSER, and then every launch starts that browser with a mock
// keychain instead.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { parseDevToolsActivePort } from "./cdp-live/endpoint";
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
];

/**
 * Chrome's "Continue where you left off". Session cookies survive a clean exit.
 * The launch does not pass --restore-last-session: that flag reopens a tab, and
 * the restored navigation races the first replay. Saved tab files are removed
 * instead, and the window is parked on about:blank.
 */
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

/** Drop saved tabs. The startup preference still keeps session cookies. */
export function discardRestoredTabs(userDataDir: string): void {
  const base = path.join(userDataDir, "Default");
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(path.join(base, name), { force: true });
  }
  rmSync(path.join(base, "Sessions"), { recursive: true, force: true });
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

const MOCK_KEYCHAIN_ARGS = ["--use-mock-keychain", "--password-store=basic"];

/**
 * The hermetic test lane's browser. desktop/test/run-v1.mjs sets
 * BAO_TEST_BROWSER to Playwright's Chromium. While it is set, every launch
 * starts that binary with a mock keychain, so a test never opens the user's
 * Chrome or the login keychain. Product launches never set it.
 */
export function testLaneBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BAO_TEST_BROWSER?.trim() || undefined;
}

/** The mock keychain flags in the test lane. Empty for every product launch. */
export function testLaneKeychainArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return testLaneBrowser(env) ? [...MOCK_KEYCHAIN_ARGS] : [];
}

/**
 * Owned Chrome only. Account Chrome never receives the sandbox opt-in.
 * Caller arguments never carry a keychain flag. Only the test lane adds one.
 */
export function ownedChromeLaunchArgs(extra: string[] = [], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const mac = platform === "darwin" ? ["--force-renderer-accessibility"] : [];
  const sandbox = needsLinuxNoSandbox(env, platform) ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const drop = new Set([
    "--enable-automation",
    "--disable-blink-features=AutomationControlled",
    "--disable-extensions",
    "--enable-unsafe-swiftshader",
    "--restore-last-session",
  ]);
  const cleaned = extra.filter((arg) => {
    if (drop.has(arg) || isKeychainFlag(arg)) return false;
    if (platform === "darwin" && (arg === "--no-sandbox" || arg === "--disable-dev-shm-usage")) return false;
    return true;
  });
  return [...OWNED_CHROME_ARGS, ...mac, ...sandbox, ...cleaned, ...testLaneKeychainArgs(env)];
}

/** macOS Accessibility only sees the page when the renderer publishes it. */
function ownedLaunchArgs(extra: string[] | undefined, append: string[] | undefined): string[] {
  return ownedChromeLaunchArgs([...(extra ?? []), ...(append ?? [])]);
}

const KEYCHAIN_FLAG_NAMES = new Set(["--use-mock-keychain", "--password-store"]);

function chromeFlagName(arg: string): string {
  const trimmed = arg.trim();
  const eq = trimmed.indexOf("=");
  return eq === -1 ? trimmed : trimmed.slice(0, eq);
}

function isKeychainFlag(arg: string): boolean {
  return KEYCHAIN_FLAG_NAMES.has(chromeFlagName(arg));
}

export function chromeExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const DAILY_DIR = [
  "/.config/google-chrome",
  "/.config/chromium",
  "/Application Support/Google/Chrome",
  "/Google/Chrome/User Data",
];

/**
 * The test lane's browser when BAO_TEST_BROWSER is set. Otherwise installed
 * Google Chrome when it is present, then BAO_BROWSER, then Playwright's
 * Chromium. Never a PATH lookup: wrappers can add automation flags.
 */
export function resolveNormalChrome(
  exists: (file: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  playwrightPath: () => string = () => chromium.executablePath(),
): string {
  const pinned = testLaneBrowser(env);
  if (pinned) {
    if (chromeExecutable(pinned)) return pinned;
    throw new Error(`BAO_TEST_BROWSER is not an executable file: ${pinned}`);
  }
  if (platform === "darwin" && exists(ACCOUNT_CHROME_MAC)) return ACCOUNT_CHROME_MAC;
  if (platform === "linux" && exists(LINUX_CHROME)) return LINUX_CHROME;
  const bundled = env.BAO_BROWSER;
  if (bundled && chromeExecutable(bundled)) return bundled;
  try {
    const fallback = playwrightPath();
    if (fallback && chromeExecutable(fallback)) return fallback;
  } catch { /* Playwright has not downloaded a browser. */ }
  throw new Error("Chrome was not found");
}

export function resolveAccountChrome(
  exists: (file: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  playwrightPath?: () => string,
): string {
  return resolveNormalChrome(exists, env, process.platform, playwrightPath);
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

/**
 * Port 0: Chrome binds a free port itself. A port this process picked would
 * stay free until Chrome bound it, and a parallel launch could pick it too.
 * Both launches would then attach to one Chrome, and closing either one would
 * close both.
 */
const OWNED_DEBUG_PORT = 0;

function readActivePort(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Spawn Chrome on its own profile and return the port it bound. Chrome writes
 * that port to DevToolsActivePort in the profile once it is listening. A file
 * left by an earlier Chrome on this profile is skipped: each start writes a new
 * browser id on its second line. A Chrome that bound 9222 is stopped.
 */
async function spawnOwnedChrome(exe: string, args: string[], userDataDir: string): Promise<{ child: ChildProcess; port: number }> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const stale = readActivePort(file);
  const child: ChildProcess = spawn(exe, args, { stdio: "ignore" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`Chrome exited before it opened a debugging port (${child.exitCode ?? child.signalCode})`);
    }
    const text = readActivePort(file);
    if (text && text !== stale) {
      let port: number | undefined;
      try {
        port = parseDevToolsActivePort(text).port;
      } catch { /* Chrome is still writing the file. */ }
      if (port === 9222) {
        child.kill("SIGTERM");
        throw new Error("Chrome bound remote-debugging-port 9222.");
      }
      if (port !== undefined) return { child, port };
    }
    await delay(50);
  }
  child.kill("SIGTERM");
  throw new Error("Chrome debugging port did not open");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Startup page Chrome opens when it has no tabs to restore. */
function startupUrl(url: string): boolean {
  return url === "about:blank"
    || url === ""
    || url.startsWith("chrome://new-tab-page")
    || url.startsWith("chrome://newtab");
}

/**
 * One blank tab whose blank navigation has committed. Saved tabs are already
 * gone, so this replaces the new-tab page before the caller navigates.
 */
async function parkOnBlank(context: BrowserContext): Promise<void> {
  const appear = Date.now() + 5000;
  while (context.pages().every((page) => page.isClosed()) && Date.now() < appear) await delay(50);
  const limit = Date.now() + 8000;
  let keep: Page | undefined;
  while (Date.now() < limit) {
    const open = context.pages().filter((page) => !page.isClosed());
    keep = open[0] ?? await context.newPage();
    for (const page of open.slice(1)) await page.close().catch(() => undefined);
    if (keep.url() !== "about:blank") {
      await keep.goto("about:blank", { waitUntil: "commit", timeout: 5000 }).catch(() => undefined);
      continue;
    }
    await delay(50);
    const still = context.pages().filter((page) => !page.isClosed());
    if (still.length === 1 && still[0] === keep && keep.url() === "about:blank") return;
  }
  const left = context.pages().filter((page) => !page.isClosed()).map((page) => page.url());
  throw new Error(`Chrome did not settle on a blank page (${left.join(", ") || "no page"})`);
}

function navigationInterrupted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /interrupted by another navigation|net::ERR_ABORTED/i.test(message);
}

/**
 * The first capture or replay navigation. The window is already on about:blank.
 * A navigation that is interrupted, or that never leaves the startup page, is
 * retried. A redirect away from that page is the site's own navigation.
 */
export async function navigateOwned(page: Page, url: string, opts?: { waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle"; timeout?: number }): Promise<void> {
  const waitUntil = opts?.waitUntil ?? "load";
  const timeout = opts?.timeout ?? 30000;
  let last = "not started";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout });
    } catch (err) {
      last = err instanceof Error ? err.message.split("\n")[0] : String(err);
      if (attempt === 2 || !navigationInterrupted(err)) throw err;
      continue;
    }
    if (!startupUrl(page.url())) return;
    last = page.url();
  }
  throw new Error(`Navigation to ${url} did not leave the startup page (${last})`);
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
  discardRestoredTabs(opts.userDataDir);
  const exe = resolveAccountChrome();
  const args = [...accountLaunchArgs(OWNED_DEBUG_PORT), ...testLaneKeychainArgs()];
  const { child, port } = await spawnOwnedChrome(exe, [`--user-data-dir=${opts.userDataDir}`, ...args], opts.userDataDir);
  const stop = () => {
    if (child.exitCode == null) child.kill("SIGTERM");
  };
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    const verdict = assessOwnedCommand(readOwnedCommand(child.pid, opts.userDataDir, process.platform), opts.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    await parkOnBlank(context);
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
  appendArgs?: string[];
  executablePath?: string;
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
  appendArgs?: string[];
  executablePath?: string;
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  mkdirSync(opts.userDataDir, { recursive: true });
  keepSessionCookies(opts.userDataDir);
  discardRestoredTabs(opts.userDataDir);
  const exe = opts.executablePath || resolveNormalChrome();
  const headless = opts.headless ?? true;
  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    ...ownedLaunchArgs(opts.args, opts.appendArgs),
    `--remote-debugging-port=${OWNED_DEBUG_PORT}`,
    ...(headless ? ["--headless=new"] : []),
  ];
  const { child, port } = await spawnOwnedChrome(exe, args, opts.userDataDir);
  const stop = () => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  };
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    if (opts.deviceScaleFactor && opts.deviceScaleFactor !== 1) await applyDeviceScale(context, opts.deviceScaleFactor);
    const verdict = assessOwnedCommand(readOwnedCommand(child.pid, opts.userDataDir, process.platform), opts.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    await parkOnBlank(context);
    let closed = false;
    browser.on("disconnected", () => {
      if (!closed) stop();
    });
    context.close = async () => {
      if (closed) return;
      closed = true;
      const open = context.pages().filter((page) => !page.isClosed());
      let browserClose: ShutdownTrace["browserClose"] = open.length === 0 ? "skipped" : "failed";
      const page = open[0];
      if (page) {
        try {
          const session = await context.newCDPSession(page);
          await session.send("Browser.close");
          browserClose = "sent";
        } catch {
          browserClose = "failed";
        }
      }
      const released = await releaseProfileProcesses(opts.userDataDir, child);
      await browser.close().catch(() => undefined);
      console.error(formatShutdown({
        browserClose,
        openPages: open.length,
        childExit: released.childExit,
        signal: released.signal,
        killedPids: released.killedPids,
        profile: opts.userDataDir,
      }));
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

export interface ShutdownTrace {
  browserClose: "sent" | "skipped" | "failed";
  openPages: number;
  childExit: number | null;
  signal: NodeJS.Signals | null;
  killedPids: number[];
  profile: string;
}

export function formatShutdown(trace: ShutdownTrace): string {
  const killed = trace.killedPids.length ? trace.killedPids.join(",") : "none";
  return `bao shutdown browserClose=${trace.browserClose} openPages=${trace.openPages} childExit=${trace.childExit ?? "none"} signal=${trace.signal ?? "none"} killedPids=${killed} profile=${trace.profile}`;
}

async function releaseProfileProcesses(userDataDir: string, child: ChildProcess): Promise<{ childExit: number | null; signal: NodeJS.Signals | null; killedPids: number[] }> {
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
  const killedPids: number[] = [];
  for (const pid of pidsForDataDir(userDataDir)) {
    try {
      process.kill(pid, "SIGKILL");
      killedPids.push(pid);
    } catch {}
  }
  return { childExit: child.exitCode, signal: child.signalCode, killedPids };
}

/** Playwright video only. The pipe and default switches come back with it. */
async function launchOwnedChromeForVideo(opts: {
  userDataDir: string;
  videoDir?: string;
  headless?: boolean;
  args?: string[];
  appendArgs?: string[];
  executablePath?: string;
  deviceScaleFactor?: number;
}): Promise<BrowserContext> {
  assertNotDailyChrome(opts.userDataDir);
  keepSessionCookies(opts.userDataDir);
  discardRestoredTabs(opts.userDataDir);
  const exe = opts.executablePath || resolveNormalChrome();
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    executablePath: exe,
    headless: opts.headless ?? true,
    viewport: null,
    deviceScaleFactor: opts.deviceScaleFactor,
    chromiumSandbox: true,
    ignoreDefaultArgs: testLaneBrowser() ? AUTOMATION_SWITCHES.filter((arg) => !isKeychainFlag(arg)) : AUTOMATION_SWITCHES,
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: { width: 1280, height: 720 } } : undefined,
    args: ownedLaunchArgs(opts.args, opts.appendArgs),
  });
  try {
    assertOwnedProcess(ctx, opts.userDataDir);
    await parkOnBlank(ctx);
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

/**
 * A product command line never carries a keychain flag. A test lane command
 * line always carries the mock keychain.
 */
export function assessOwnedCommand(cmd: string, userDataDir: string, env: NodeJS.ProcessEnv = process.env): OwnedVerdict {
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
  const tokens = cmd.split(/\s+/);
  if (testLaneBrowser(env)) {
    if (!tokens.includes("--use-mock-keychain")) {
      return { ok: false, reason: "The test lane started Chrome without a mock keychain." };
    }
  } else if (tokens.some((token) => isKeychainFlag(token))) {
    return { ok: false, reason: "Chrome was started with a mock keychain flag." };
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
