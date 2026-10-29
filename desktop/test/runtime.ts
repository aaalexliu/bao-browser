import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const STRIP = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "BAO_XAI_MODEL",
  "CURSOR_API_KEY",
  "BAO_HEAL_CURSOR",
  "BAO_HEAL_CURSOR_RESPONSE",
  "BAO_HEAL_FIXTURE",
  "BAO_CURSOR_AGENT",
  "BAO_CURSOR_MODEL",
  "BAO_HEADED",
  "BAO_OS_HELPER",
  "BAO_EXTENSION_HOST",
  "BAO_HOME",
  "BAO_CHROME_USER_DATA",
  "BAO_PORT",
  "BAO_PROFILE_DIR",
  "BAO_WINDOW_VIDEO",
  "BAO_RUN_VIDEO",
  "BAO_REPLAY_VIDEO",
  "BAO_NOTIFY_SOCK",
  "BAO_MCP_LIVE",
  "BAO_DRIVE",
  "BAO_PROOF_PAGE",
  "BAO_SIGNIN_HEADLESS",
  "BAO_SIGNIN_SHOT",
  "BAO_DEMO_HOLD_MS",
  "BAO_FIND_DEBUG",
  "BAO_TEST_MOCK_KEYCHAIN",
];

export type TestLane = "hermetic" | "live" | "installed-chrome";
export type CookieSource = "synthetic-linux" | "browser";
export type SiteResult = "reachable" | "unavailable" | "bot-blocked";

export interface SiteProbe {
  url: string;
  status: number;
  result: SiteResult;
}

export interface CompiledPlan {
  run: string[];
  stale: string[];
  missing: string[];
}

export function laneEnv(lane: TestLane, parent: NodeJS.ProcessEnv, pinnedBrowser?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of STRIP) delete env[key];
  env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  env.BAO_LANE = lane;
  env.BAO_REPLAY_VIDEO = "0";
  if (!env.BAO_TEST_RUN_ID) env.BAO_TEST_RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  if (lane === "installed-chrome") {
    delete env.BAO_BROWSER;
    return env;
  }
  env.BAO_HEADED = "0";
  if (lane === "live") env.BAO_LIVE_TESTS = "1";
  if (!env.BAO_BROWSER && pinnedBrowser) env.BAO_BROWSER = pinnedBrowser;
  return env;
}

export function hermeticChildEnv(parent: NodeJS.ProcessEnv, pinnedBrowser?: string): NodeJS.ProcessEnv {
  return laneEnv("hermetic", parent, pinnedBrowser);
}

export function pinnedTestBrowser(): string | undefined {
  try {
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) return exe;
  } catch {
    return undefined;
  }
  return undefined;
}

export function compiledTestPlan(sourceDir: string, distDir: string): CompiledPlan {
  const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".test.ts")).sort();
  const distNames = existsSync(distDir) ? readdirSync(distDir) : [];
  const wanted = sources.map((name) => name.replace(/\.ts$/, ".js"));
  const stems = new Set(sources.map((name) => name.replace(/\.ts$/, "")));
  const present = new Set(distNames);
  const stale = distNames.filter((name) => {
    if (!name.includes(".test.")) return false;
    const stem = name.replace(/\.d\.ts$/, "").replace(/\.js\.map$/, "").replace(/\.js$/, "");
    return !stems.has(stem);
  });
  return {
    run: wanted.filter((name) => present.has(name)),
    stale,
    missing: wanted.filter((name) => !present.has(name)),
  };
}

export function classifyStatus(status: number): SiteResult {
  if (status === 403 || status === 429) return "bot-blocked";
  if (status >= 200 && status < 400) return "reachable";
  return "unavailable";
}

export function outageFromReason(reason: string | undefined): { result: SiteResult; status: number } | undefined {
  if (!reason) return undefined;
  const named = reason.match(/\b5xx\s+(\d{3})\b/);
  if (named) {
    const status = Number(named[1]);
    if (status >= 500) return { result: "unavailable", status };
  }
  if (/\b5xx\b/.test(reason)) return { result: "unavailable", status: 500 };
  if (/\b429\b/.test(reason)) return { result: "bot-blocked", status: 429 };
  if (/\b403\b/.test(reason)) return { result: "bot-blocked", status: 403 };
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(reason)) return { result: "unavailable", status: 0 };
  return undefined;
}

export async function probeSite(url: string): Promise<SiteProbe> {
  let status = 0;
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    status = response.status;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    status = 0;
  }
  const result = classifyStatus(status);
  console.log(`live ${url} http=${status} result=${result}`);
  return { url, status, result };
}

export function cookieKeyPlan(source: CookieSource, platform: NodeJS.Platform): { platform: "linux" | "darwin" | "win32"; injected: boolean } {
  if (source === "synthetic-linux") return { platform: "linux", injected: true };
  if (platform === "darwin") return { platform: "darwin", injected: false };
  if (platform === "win32") return { platform: "win32", injected: false };
  return { platform: "linux", injected: false };
}

export function freshAppDirs(name: string): { home: string; chromeUserData: string; nativeHostHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), `bao-${name}-`));
  const dirs = {
    home: path.join(root, "home"),
    chromeUserData: path.join(root, "chrome"),
    nativeHostHome: path.join(root, "native-host"),
  };
  mkdirSync(dirs.home, { recursive: true });
  mkdirSync(dirs.chromeUserData, { recursive: true });
  mkdirSync(dirs.nativeHostHome, { recursive: true });
  return dirs;
}

export function applyHermeticApp(name: string, env: NodeJS.ProcessEnv = process.env): { home: string; chromeUserData: string; nativeHostHome: string } {
  const dirs = freshAppDirs(name);
  env.BAO_HOME = dirs.home;
  env.BAO_CHROME_USER_DATA = dirs.chromeUserData;
  env.BAO_HEADED = "0";
  env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  delete env.BAO_OS_HELPER;
  delete env.BAO_EXTENSION_HOST;
  delete env.BAO_CURSOR_AGENT;
  if (!env.BAO_BROWSER) {
    const pinned = pinnedTestBrowser();
    if (pinned) env.BAO_BROWSER = pinned;
  }
  return dirs;
}
