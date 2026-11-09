// Launch an owned browser. Never port 9222, never the daily profile.
// Capture, replay, login import, and computer-use start the installed Google
// Chrome and attach over a private debugging port. Playwright's launcher is
// only used when a caller asks for page.video(). Both test lanes and the
// browser evals set BAO_TEST_BROWSER, and then every launch starts that
// browser with a mock keychain and camera and microphone denied in Chrome.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { createServer } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { parseDevToolsActivePort, readDevToolsActivePort } from "./cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "./cdp-live/socket";
import { assertNotDailyChrome } from "./profile";
import { TEST_MEDIA_ARGS } from "./test-browser.js";

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
 * By default, launches omit --restore-last-session: the restored navigation
 * races the first replay. They remove saved tab files and park on about:blank.
 * Copied profiles opt in to restoring their saved tabs instead.
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
 * The test browser. desktop/test/run-v1.mjs and desktop/test/run-live.mjs set
 * BAO_TEST_BROWSER to Playwright's Chromium, and pinTestBrowser sets it for
 * the browser evals. While it is set, every launch starts that binary with a
 * mock keychain, so a test never opens the user's Chrome or the login
 * keychain. Test media denial also keeps camera and microphone access inside
 * Chrome. Product launches never set it.
 */
export function testLaneBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BAO_TEST_BROWSER?.trim() || undefined;
}

/**
 * Test and tooling launches only. Returns BAO_TEST_BROWSER, and sets it to
 * Playwright's Chromium when it is unset, so later launches in this process
 * and children that inherit the env use the test lane described above.
 */
export function pinTestBrowser(
  env: NodeJS.ProcessEnv = process.env,
  playwrightPath: () => string = () => chromium.executablePath(),
): string {
  const pinned = testLaneBrowser(env);
  if (pinned) return checkedTestBrowser(pinned);
  let exe = "";
  try {
    exe = playwrightPath();
  } catch { /* Playwright has not downloaded a browser. */ }
  if (!exe || !chromeExecutable(exe)) throw new Error("Playwright Chromium is missing. Run: npx playwright install chromium");
  env.BAO_TEST_BROWSER = exe;
  return exe;
}

/** Refuses a test browser at a standard installed Google Chrome path, even through a link. */
function checkedTestBrowser(pinned: string): string {
  if (isInstalledChrome(pinned)) throw new Error(`BAO_TEST_BROWSER is the installed Google Chrome: ${pinned}`);
  if (!chromeExecutable(pinned)) throw new Error(`BAO_TEST_BROWSER is not an executable file: ${pinned}`);
  return pinned;
}

function isInstalledChrome(file: string): boolean {
  const given = path.resolve(file);
  let real = given;
  try {
    real = realpathSync(file);
  } catch { /* a missing file fails the executable check */ }
  return [ACCOUNT_CHROME_MAC, LINUX_CHROME].some((chrome) => chrome === given || chrome === real);
}

/** The mock keychain flags in the test lane. Empty for every product launch. */
export function testLaneKeychainArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return testLaneBrowser(env) ? [...MOCK_KEYCHAIN_ARGS] : [];
}

/** Tests and evals deny media prompts and use synthetic capture devices. */
export function testLaneMediaArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return testLaneBrowser(env) ? [...TEST_MEDIA_ARGS] : [];
}

/**
 * Owned Chrome only. Account Chrome never receives the sandbox opt-in.
 * Caller arguments never carry a keychain flag. Tests and the lasting Bao profile opt in.
 */
export function ownedChromeLaunchArgs(extra: string[] = [], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, keychain?: "mock"): string[] {
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
    if (drop.has(arg) || isKeychainFlag(arg) || chromeFlagName(arg) === "--remote-debugging-port") return false;
    if (platform === "darwin" && (arg === "--no-sandbox" || arg === "--disable-dev-shm-usage")) return false;
    return true;
  });
  return [...OWNED_CHROME_ARGS, ...mac, ...sandbox, ...cleaned, ...(keychain === "mock" ? MOCK_KEYCHAIN_ARGS : testLaneKeychainArgs(env)), ...testLaneMediaArgs(env)];
}

/** macOS Accessibility only sees the page when the renderer publishes it. */
function ownedLaunchArgs(extra: string[] | undefined, append: string[] | undefined, keychain?: "mock"): string[] {
  return ownedChromeLaunchArgs([...(extra ?? []), ...(append ?? [])], process.env, process.platform, keychain);
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
  if (pinned) return checkedTestBrowser(pinned);
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
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 9222) throw new Error("Chrome needs a nonzero debugging port other than 9222.");
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

/** Port zero makes headed Chrome set navigator.webdriver. Pick a nonzero port instead. */
async function ownedDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Chrome debugging port was not allocated");
  return address.port === 9222 ? ownedDebugPort() : address.port;
}

/** LaunchServices gives Chrome the GUI login session; -W tracks the new instance. */
export function guiChromeLaunchArgs(
  exe: string, args: string[], stderrFile: string, childHome: string,
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform !== "darwin" || testLaneBrowser(env) || exe !== ACCOUNT_CHROME_MAC) return undefined;
  return ["-W", "-n", ...(args.includes("--no-startup-window") ? ["-g"] : []), "-a", path.resolve(exe, "../../.."),
    "--stdout", "/dev/null", "--stderr", stderrFile, "--env", `HOME=${childHome}`, "--args", ...args];
}

function ownedChromeBrowserCommand(exe: string, userDataDir: string, pid: number): string | undefined {
  try {
    const command = defaultPs(pid).trim();
    if (guiChromeBrowserPid(exe, userDataDir, [{ pid, ppid: 0, command }]) === pid) return command;
  } catch {}
  return undefined;
}

type OwnedChromeProcess =
  | { kind: "direct"; child: ChildProcess; userDataDir: string }
  | { kind: "gui"; launcher: ChildProcess; pid: number; executable: string; userDataDir: string };

function ownedChromeRunning(owner: OwnedChromeProcess): boolean {
  switch (owner.kind) {
    case "direct": return owner.child.exitCode == null && owner.child.signalCode == null;
    case "gui": return ownedChromeBrowserCommand(owner.executable, owner.userDataDir, owner.pid) !== undefined;
  }
}

export function stopOwnedChrome(owner: OwnedChromeProcess): void {
  if (!ownedChromeRunning(owner)) return;
  switch (owner.kind) {
    case "gui":
      try { process.kill(owner.pid, "SIGTERM"); } catch { /* already gone */ }
      break;
    case "direct":
      owner.child.kill("SIGTERM");
      break;
  }
}

/** Trust this launch's stderr endpoint, not whichever listener won the port. */
async function spawnOwnedChrome(exe: string, args: (port: number) => string[], userDataDir: string, childHome?: string, detached = false): Promise<{ owner: OwnedChromeProcess; port: number }> {
  const port = await ownedDebugPort();
  const stderrFile = path.join(userDataDir, ".bao-chrome-startup.stderr");
  const chromeArgs = args(port);
  const guiArgs = guiChromeLaunchArgs(exe, chromeArgs, stderrFile, childHome ?? userInfo().homedir);
  if (guiArgs) {
    assertChromeProfileAvailable(userDataDir);
    rmSync(stderrFile, { force: true });
  }
  const child = spawn(guiArgs ? "/usr/bin/open" : exe, guiArgs ?? chromeArgs, {
    stdio: ["ignore", "ignore", "pipe"], detached, env: childHome === undefined ? process.env : { ...process.env, HOME: childHome },
  });
  let output = "";
  let browserPath = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  const readEndpoint = (text: string) => {
    const match = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)(\/devtools\/browser\/[\w-]+)\r?\n/);
    if (match && Number(match[1]) === 9222) spawnError = new Error("Chrome bound remote-debugging-port 9222.");
    else if (match && Number(match[1]) === port) browserPath = match[2]!;
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-8192);
    if (!guiArgs && !browserPath) readEndpoint(output);
  });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (guiArgs && !browserPath && existsSync(stderrFile)) readEndpoint(readFileSync(stderrFile, "utf8"));
      if (spawnError) throw spawnError;
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error(`Chrome exited before it opened a debugging port (${child.exitCode ?? child.signalCode})${output ? `: ${output.trim()}` : ""}`);
      }
      const pid = guiArgs && browserPath ? guiChromeBrowserPid(exe, userDataDir, processesNaming(userDataDir)) : child.pid;
      if (browserPath && pid) {
        const text = `${port}\n${browserPath}\n`;
        parseDevToolsActivePort(text);
        writeFileSync(path.join(userDataDir, "DevToolsActivePort"), text, { mode: 0o600 });
        const owner: OwnedChromeProcess = guiArgs
          ? { kind: "gui", launcher: child, pid, executable: exe, userDataDir }
          : { kind: "direct", child, userDataDir };
        return { owner, port };
      }
      await delay(50);
    }
    throw new Error("Chrome debugging port did not open");
  } catch (error) {
    try {
      if (guiArgs) {
        const pid = guiChromeBrowserPid(exe, userDataDir, processesNaming(userDataDir));
        if (pid) await releaseProfileProcesses({ kind: "gui", launcher: child, pid, executable: exe, userDataDir }, false);
      } else await releaseProfileProcesses({ kind: "direct", child, userDataDir }, false);
    } catch {}
    try {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    } catch {}
    throw error;
  } finally {
    if (guiArgs) {
      try { rmSync(stderrFile, { force: true }); } catch {}
    }
  }
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
  const { owner, port } = await spawnOwnedChrome(exe, (debugPort) => [
    `--user-data-dir=${opts.userDataDir}`, ...accountLaunchArgs(debugPort), ...testLaneKeychainArgs(), ...testLaneMediaArgs(),
  ], opts.userDataDir);
  const ownedPids = new Set(pidsForDataDir(opts.userDataDir));
  const stop = () => releaseProfileProcesses(owner, false, ownedPids);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    const pid = owner.kind === "direct" ? owner.child.pid : owner.pid;
    const verdict = assessOwnedCommand(readOwnedCommand(pid, owner.userDataDir, process.platform), owner.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    await parkOnBlank(context);
    let closing: Promise<void> | undefined;
    browser.on("disconnected", () => { if (!closing) void stop().catch(() => undefined); });
    context.close = () => closing ??= (async () => {
      const openPages = context.pages().filter((page) => !page.isClosed()).length;
      if (ownedChromeRunning(owner)) for (const pid of listedPids(opts.userDataDir) ?? []) ownedPids.add(pid);
      const browserCloseSent = await requestBrowserClose(browser);
      const released = await releaseProfileProcesses(owner, browserCloseSent, ownedPids);
      await browser.close().catch(() => undefined);
      console.error(formatShutdown({ browserClose: browserCloseSent ? "sent" : "failed", openPages, ...released, profile: opts.userDataDir }));
    })();
    return context;
  } catch (err) {
    await stop().catch(() => undefined);
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
  /** Only Chrome gets this HOME. Bao keeps its own isolated state and native-host paths. */
  childHome?: string;
  loadExtensions?: boolean;
  /** Restore a prepared profile's saved tabs; park on blank only if all pages are startup pages. */
  preserveRestoredTabs?: boolean;
  /** Accepted so older callers compile. The binary is resolveNormalChrome, not a channel lookup. */
  channel?: "chrome";
}): Promise<BrowserContext> {
  if (opts.videoDir) return launchOwnedChromeForVideo(opts);
  return launchNormalChrome(opts);
}

interface OwnedChromeProcessOptions {
  userDataDir: string;
  keychain?: "mock";
  childHome?: string;
  loadExtensions?: boolean;
  preserveRestoredTabs?: boolean;
  headless?: boolean;
  args?: string[];
  appendArgs?: string[];
  executablePath?: string;
}

async function spawnNormalChrome(opts: OwnedChromeProcessOptions, detached = false): Promise<{ owner: OwnedChromeProcess; port: number }> {
  assertNotDailyChrome(opts.userDataDir);
  mkdirSync(opts.userDataDir, { recursive: true });
  if (!opts.preserveRestoredTabs) {
    keepSessionCookies(opts.userDataDir);
    discardRestoredTabs(opts.userDataDir);
  }
  const exe = opts.executablePath || resolveNormalChrome();
  const headless = opts.headless ?? true;
  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    ...ownedLaunchArgs(opts.args, opts.appendArgs, opts.keychain),
    ...(opts.preserveRestoredTabs ? ["--restore-last-session"] : []),
    ...(opts.loadExtensions === false ? ["--disable-extensions"] : []),
    ...(headless ? ["--headless=new"] : []),
  ];
  return spawnOwnedChrome(exe, (port) => [...args, `--remote-debugging-port=${port}`], opts.userDataDir, opts.childHome, detached);
}

type OwnedEndpointState =
  | { phase: "starting" }
  | { phase: "running" }
  | { phase: "retained" }
  | { phase: "closing"; completion: Promise<void> }
  | { phase: "settled"; completion: Promise<void> };

/** Own the process and browser endpoint without attaching to page renderers. */
export async function launchOwnedChromeEndpoint(opts: OwnedChromeProcessOptions & { detached?: boolean }): Promise<{
  portFile: string;
  closed: Promise<void>;
  isClosed(): boolean;
  keepOpen(): void;
  close(): Promise<void>;
}> {
  const { owner } = await spawnNormalChrome(opts, opts.detached === true);
  const portFile = path.join(opts.userDataDir, "DevToolsActivePort");
  const ownedPids = new Set(pidsForDataDir(opts.userDataDir));
  let cdp: CdpSocket | undefined;
  let state: OwnedEndpointState = { phase: "starting" };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const pages = new Set<string>();
  const close = (): Promise<void> => {
    if (state.phase === "closing" || state.phase === "settled") return state.completion;
    const retained = state.phase === "retained";
    const completion = Promise.resolve().then(async () => {
      const openPages = pages.size;
      let browserClose: ShutdownTrace["browserClose"] = "skipped";
      try {
        // Inside the try, so nothing before Browser.close can skip it and leave Chrome open.
        if (ownedChromeRunning(owner)) for (const pid of listedPids(opts.userDataDir) ?? []) ownedPids.add(pid);
        if (retained && !cdp?.isOpen && ownedChromeRunning(owner)) {
          try {
            const endpoint = await readDevToolsActivePort(portFile);
            cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 3000 });
          } catch { /* Fall back to stopping the owned process. */ }
        }
        if (cdp?.isOpen) {
          try {
            await cdp.send("Browser.close", {}, undefined, 3000);
            browserClose = "sent";
          } catch { browserClose = "failed"; }
        }
        const released = await releaseProfileProcesses(owner, browserClose === "sent", ownedPids);
        console.error(formatShutdown({ browserClose, openPages, ...released, profile: opts.userDataDir }));
      } finally {
        cdp?.close();
        state = { phase: "settled", completion };
        resolveClosed();
      }
    });
    state = { phase: "closing", completion };
    return completion;
  };
  const onClosed = (): void => {
    switch (state.phase) {
      case "starting":
      case "running":
        void close().catch(() => undefined);
        return;
      case "retained":
      case "closing":
      case "settled":
        return;
    }
  };
  if (owner.kind === "direct") owner.child.once("exit", onClosed);
  try {
    const pid = owner.kind === "direct" ? owner.child.pid : owner.pid;
    const verdict = assessOwnedCommand(readOwnedCommand(pid, owner.userDataDir, process.platform), owner.userDataDir, process.env, opts.keychain);
    if (!verdict.ok) throw new Error(verdict.reason);
    const endpoint = await readDevToolsActivePort(portFile);
    cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 15_000 });
    void cdp.disconnected.then(onClosed);
    cdp.on("Target.targetCreated", undefined, ({ targetInfo }) => {
      const info = targetInfo as { type: string; targetId: string };
      if (info.type === "page") pages.add(info.targetId);
    });
    cdp.on("Target.targetDestroyed", undefined, ({ targetId }) => {
      if (pages.delete(String(targetId)) && pages.size === 0) onClosed();
    });
    // Discovery reports existing and future targets without attaching to them.
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    if (state.phase !== "starting" || !ownedChromeRunning(owner)) throw new Error("Chrome closed during startup");
    state = { phase: "running" };
    return {
      portFile, closed, close, keepOpen() {
        if (state.phase !== "running") return;
        state = { phase: "retained" };
        cdp?.close();
        if (owner.kind === "direct") owner.child.unref();
        else owner.launcher.unref();
      },
      isClosed() {
        switch (state.phase) {
          case "starting":
          case "running":
          case "retained":
            return false;
          case "closing":
          case "settled":
            return true;
        }
      },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

async function launchNormalChrome(opts: OwnedChromeProcessOptions & { deviceScaleFactor?: number }): Promise<BrowserContext> {
  const { owner, port } = await spawnNormalChrome(opts);
  const ownedPids = new Set(pidsForDataDir(opts.userDataDir));
  const stop = () => releaseProfileProcesses(owner, false, ownedPids);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome opened without a profile context");
    if (opts.deviceScaleFactor && opts.deviceScaleFactor !== 1) await applyDeviceScale(context, opts.deviceScaleFactor);
    const pid = owner.kind === "direct" ? owner.child.pid : owner.pid;
    const verdict = assessOwnedCommand(readOwnedCommand(pid, owner.userDataDir, process.platform), owner.userDataDir);
    if (!verdict.ok) throw new Error(verdict.reason);
    if (opts.preserveRestoredTabs) {
      while (context.pages().every((page) => page.isClosed())) {
        if (!browser.isConnected()) throw new Error("Chrome closed before opening a page");
        await delay(50);
      }
      if (context.pages().filter((page) => !page.isClosed()).every((page) => startupUrl(page.url()))) await parkOnBlank(context);
    } else {
      await parkOnBlank(context);
    }
    let closing: Promise<void> | undefined;
    browser.on("disconnected", () => {
      if (!closing) void stop().catch(() => undefined);
    });
    context.close = () => closing ??= (async () => {
      const open = context.pages().filter((page) => !page.isClosed());
      if (ownedChromeRunning(owner)) for (const pid of listedPids(opts.userDataDir) ?? []) ownedPids.add(pid);
      const browserClose: ShutdownTrace["browserClose"] = await requestBrowserClose(browser) ? "sent" : "failed";
      const released = await releaseProfileProcesses(owner, browserClose === "sent", ownedPids);
      await browser.close().catch(() => undefined);
      console.error(formatShutdown({
        browserClose,
        openPages: open.length,
        childExit: released.childExit,
        signal: released.signal,
        killedPids: released.killedPids,
        profile: opts.userDataDir,
      }));
    })();
    return context;
  } catch (err) {
    await stop().catch(() => undefined);
    throw err;
  }
}

/** Chrome can drop the connection before it answers Browser.close, and Playwright then never settles the call. */
async function requestBrowserClose(browser: Browser): Promise<boolean> {
  const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
  try {
    const session = await browser.newBrowserCDPSession();
    await Promise.race([session.send("Browser.close"), disconnected]);
    return true;
  } catch {
    return false;
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

async function releaseProfileProcesses(owner: OwnedChromeProcess, browserCloseSent: boolean, ownedPids = new Set<number>()): Promise<{ childExit: number | null; signal: NodeJS.Signals | null; killedPids: number[] }> {
  const { userDataDir } = owner;
  const child = owner.kind === "direct" ? owner.child : owner.launcher;
  const remaining = () => {
    const pids = listedPids(userDataDir);
    if (!pids) return [...ownedPids].filter(alive);
    if (ownedChromeRunning(owner)) for (const pid of pids) ownedPids.add(pid);
    return pids.filter((pid) => ownedPids.has(pid));
  };
  const deadline = Date.now() + (browserCloseSent ? 4000 : 0);
  while (Date.now() < deadline && ownedChromeRunning(owner)) {
    remaining();
    await delay(50);
  }
  if (ownedChromeRunning(owner)) {
    remaining();
    stopOwnedChrome(owner);
  }
  const killAt = Date.now() + 1500;
  while (Date.now() < killAt && ownedChromeRunning(owner)) {
    remaining();
    await delay(50);
  }
  const killedPids: number[] = [];
  for (const pid of remaining()) {
    try {
      process.kill(pid, "SIGKILL");
      killedPids.push(pid);
    } catch {}
  }
  const orphansExitAt = Date.now() + 1500;
  while (remaining().length && Date.now() < orphansExitAt) await delay(50);
  if (remaining().length) throw new Error(`bao shutdown processes still shutting down profile=${userDataDir}`);
  return { childExit: child.exitCode, signal: child.signalCode, killedPids };
}

export async function closeRetainedChrome(userDataDir: string): Promise<void> {
  const ownedPids = new Set(pidsForDataDir(userDataDir));
  const exe = resolveNormalChrome();
  const pid = guiChromeBrowserPid(exe, userDataDir, processesNaming(userDataDir));
  const remaining = () => {
    const pids = pidsForDataDir(userDataDir);
    if (pid && ownedChromeBrowserCommand(exe, userDataDir, pid)) for (const pid of pids) ownedPids.add(pid);
    return pids.filter((pid) => ownedPids.has(pid));
  };
  if (pid) {
    let cdp: CdpSocket | undefined;
    let sent = false;
    try {
      const endpoint = await readDevToolsActivePort(path.join(userDataDir, "DevToolsActivePort"));
      const command = ownedChromeBrowserCommand(exe, userDataDir, pid);
      const port = command?.match(/(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)/)?.[1];
      if (Number(port) === endpoint.port) {
        cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 3000 });
        await cdp.send("Browser.close", {}, undefined, 3000);
        sent = true;
      }
    } catch {} finally { cdp?.close(); }
    if (!sent && ownedChromeBrowserCommand(exe, userDataDir, pid)) {
      try { process.kill(pid, "SIGTERM"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + 4000;
    while (ownedChromeBrowserCommand(exe, userDataDir, pid) && Date.now() < deadline) {
      remaining();
      await delay(50);
    }
    if (ownedChromeBrowserCommand(exe, userDataDir, pid)) {
      console.error(`bao reclaim browser still shutting down pid=${pid} profile=${userDataDir}`);
    }
  }
  const killedPids = remaining();
  for (const pid of killedPids) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 1500;
  while (remaining().length && Date.now() < deadline) await delay(50);
  const remainingPids = remaining();
  if (remainingPids.length) console.error(`bao reclaim processes still shutting down pids=${remainingPids.join(",")} killedPids=${killedPids.join(",")} profile=${userDataDir}`);
}

/** Playwright video only. The pipe and default switches come back with it. */
async function launchOwnedChromeForVideo(opts: {
  userDataDir: string;
  childHome?: string;
  loadExtensions?: boolean;
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
    env: opts.childHome === undefined ? undefined : { ...process.env, HOME: opts.childHome },
    headless: opts.headless ?? true,
    viewport: null,
    deviceScaleFactor: opts.deviceScaleFactor,
    chromiumSandbox: true,
    ignoreDefaultArgs: testLaneBrowser() ? AUTOMATION_SWITCHES.filter((arg) => !isKeychainFlag(arg)) : AUTOMATION_SWITCHES,
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: { width: 1280, height: 720 } } : undefined,
    args: [...ownedLaunchArgs(opts.args, opts.appendArgs), ...(opts.loadExtensions === false ? ["--disable-extensions"] : [])],
  });
  try {
    assertOwnedProcess(ctx, opts.userDataDir);
    await parkOnBlank(ctx);
  } catch (err) {
    await ctx.close().catch(() => undefined);
    throw err;
  }
  return ctx;
}

export type OwnedVerdict =
  | { ok: true; reason?: never }
  | { ok: false; reason: string };

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export function guiChromeBrowserPid(exe: string, userDataDir: string, rows: readonly ProcessRow[]): number | undefined {
  return rows.find((row) => row.command.startsWith(`${exe} `)
    && !/(?:^|\s)--type(?:=|\s|$)/.test(row.command)
    && userDataDirArg(row.command) === userDataDir)?.pid;
}

export function assertChromeProfileAvailable(userDataDir: string): void {
  if (pidsForDataDir(userDataDir).length) throw new Error(`Chrome profile already open: ${userDataDir}`);
}

/** The child we spawned. The binary path is not the profile. */
export function assertOwnedProcess(ctx: BrowserContext, userDataDir: string): void {
  void ctx;
  const pid = browserPidFromLauncher(userDataDir, process.pid, processesNaming(userDataDir));
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
 * Only tests and launches that request a mock keychain may carry its flags.
 */
export function assessOwnedCommand(cmd: string, userDataDir: string, env: NodeJS.ProcessEnv = process.env, keychain?: "mock"): OwnedVerdict {
  if (/--remote-debugging-port(?:=|\s+)0(?:\s|$)/.test(cmd)) {
    return { ok: false, reason: "Chrome was started with remote-debugging-port 0, which sets navigator.webdriver." };
  }
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
  if (testLaneBrowser(env) || keychain === "mock") {
    if (!tokens.includes("--use-mock-keychain")) {
      return { ok: false, reason: "Chrome started without a mock keychain." };
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
  return processesNaming(userDataDir).flatMap((row) => {
    if (!/chrome|chromium/i.test(row.command)) return [];
    const dir = userDataDirArg(row.command);
    return dir && path.resolve(dir) === resolved ? [row.pid] : [];
  });
}

/** pidsForDataDir, or undefined when the process list cannot be read, so shutdown can fall back to the pids it already knows. */
export function listedPids(userDataDir: string): number[] | undefined {
  try { return pidsForDataDir(userDataDir); }
  catch (error) {
    console.error(`bao process list unavailable profile=${userDataDir}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/**
 * Processes whose command line contains this text. pgrep returns only the matching pids, and ps reads just those,
 * so a machine with a large process list never fills a pipe buffer.
 */
export function processesNaming(text: string): ProcessRow[] {
  const found = spawnSync("pgrep", ["-f", "--", text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")], { encoding: "utf8" });
  if (found.error) throw found.error;
  if (found.status !== 0 && found.status !== 1) throw new Error(`pgrep exited ${found.status ?? found.signal}: ${found.stderr.trim()}`);
  const pids = found.stdout.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  if (!pids.length) return [];
  const listed = spawnSync("ps", ["-ww", "-o", "pid=,ppid=,command=", "-p", pids.join(",")], { encoding: "utf8" });
  if (listed.error) throw listed.error;
  return processRows(listed.stdout);
}

function processRows(out: string): ProcessRow[] {
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
