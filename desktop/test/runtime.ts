import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinTestBrowser } from "../src/launch";
import type { KeySources } from "../src/login-import/keys";

const SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "CURSOR_API_KEY",
];

export type TestLane = "hermetic" | "live";
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

function laneEnv(lane: TestLane, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^bao/i.test(key)) delete env[key];
  }
  for (const key of SECRET_KEYS) delete env[key];
  delete env.CI;
  env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  env.BAO_LANE = lane;
  env.BAO_REPLAY_VIDEO = "0";
  env.BAO_HEADED = "0";
  env.BAO_TEST_RUN_ID = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  if (lane === "live") env.BAO_LIVE_TESTS = "1";
  return env;
}

/**
 * Both lanes. BAO_TEST_BROWSER makes every owned launch start Playwright's
 * Chromium with a mock keychain. Without it a test would open the user's
 * Chrome, so a missing browser stops the run.
 */
export function laneChildEnv(lane: TestLane, parent: NodeJS.ProcessEnv, playwrightPath?: () => string): NodeJS.ProcessEnv {
  const env = laneEnv(lane, parent);
  pinTestBrowser(env, playwrightPath);
  return env;
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

export function liveSkip(
  probe: { status: number; url?: string },
  failure?: { phase?: string; reason?: string; url?: string },
): { result: SiteResult; status: number } | undefined {
  if (probe.status === 403 || probe.status === 429) return { result: "bot-blocked", status: probe.status };
  if (probe.status >= 500) return { result: "unavailable", status: probe.status };
  if (probe.status === 404 || probe.status === 410) return { result: "unavailable", status: probe.status };
  if (probe.status === 0) return { result: "unavailable", status: 0 };
  if (!failure || failure.phase === "find" || failure.phase === "expect") return undefined;
  if (!/net::ERR_|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(failure.reason || "")) return undefined;
  if (probe.status >= 200 && probe.status < 400) {
    if (leftOrigin(probe.url, failure.url)) return { result: "unavailable", status: 0 };
    return undefined;
  }
  return { result: "unavailable", status: 0 };
}

export interface RecordedRequest {
  url: string;
  status?: number;
}

export function offOriginFailureUrl(pageUrl: string, requests: readonly RecordedRequest[] | undefined): string | undefined {
  const origin = urlOrigin(pageUrl);
  if (!origin) return undefined;
  for (const request of requests || []) {
    const status = request.status ?? 0;
    if (status >= 200 && status < 400) continue;
    const target = urlOrigin(request.url);
    if (target && target !== origin) return request.url;
  }
  return undefined;
}

export function ownApiOutage(
  pageUrl: string,
  failure: { phase?: string; reason?: string } | undefined,
  requests: readonly RecordedRequest[] | undefined,
): { result: "unavailable"; status: number } | undefined {
  if (!failure || failure.phase !== "action") return undefined;
  const wanted = serverFailureStatus(failure.reason);
  if (wanted == null) return undefined;
  const status = ownApiStatus(pageUrl, requests, wanted);
  if (status == null) return undefined;
  return { result: "unavailable", status };
}

function serverFailureStatus(reason: string | undefined): number | undefined {
  const match = /^5xx(?:\s+(\d+))?$/.exec(reason || "");
  if (!match) return undefined;
  if (!match[1]) return 0;
  const status = Number(match[1]);
  if (status < 500 || status > 599) return undefined;
  return status;
}

function ownApiStatus(pageUrl: string, requests: readonly RecordedRequest[] | undefined, wanted: number): number | undefined {
  const origin = urlOrigin(pageUrl);
  if (!origin) return undefined;
  for (const request of requests || []) {
    const status = request.status ?? 0;
    if (status < 500 || status > 599) continue;
    if (wanted !== 0 && status !== wanted) continue;
    if (urlOrigin(request.url) !== origin) continue;
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      continue;
    }
    if (pathname !== "/api" && !pathname.startsWith("/api/")) continue;
    return status;
  }
  return undefined;
}

function leftOrigin(pageUrl: string | undefined, failedUrl: string | undefined): boolean {
  const page = urlOrigin(pageUrl);
  const failed = urlOrigin(failedUrl);
  return !!page && !!failed && page !== failed;
}

function urlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
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

/** The Safe Storage password Chromium's mock keychain returns on macOS. */
export const MAC_MOCK_KEYCHAIN_PASSWORD = "mock_password";

/**
 * Keys for the login-import test's cookies. Synthetic cookies use the Linux
 * v10 key. Browser cookies come from the test browser, whose mock keychain
 * key is fixed, so the test never reads the login keychain.
 */
export function cookieKeys(source: CookieSource, platform: NodeJS.Platform): KeySources {
  if (source === "synthetic-linux") return { platform: "linux" };
  if (platform === "darwin") return { platform: "darwin", secret: MAC_MOCK_KEYCHAIN_PASSWORD };
  if (platform === "win32") return { platform: "win32" };
  return { platform: "linux" };
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
  delete env.BAO_BROWSER;
  return dirs;
}
