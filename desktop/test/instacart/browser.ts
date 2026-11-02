// A throwaway test browser for the Instacart fixture. It starts the pinned
// Playwright Chromium (BAO_TEST_BROWSER in the test lane) with a temp profile,
// a mock keychain and --remote-debugging-port=0, so Chrome writes
// DevToolsActivePort into the profile like a browser a user started. Both
// Instacart hosts resolve to the fixture and every other host, IP literals
// included, fails with ERR_NAME_NOT_RESOLVED. The fixture's certificate is
// trusted by its SPKI hash, which Chrome honours only with a non-default
// --user-data-dir. It never opens the installed Google Chrome or its profile.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { needsLinuxNoSandbox, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { assertNotDailyChrome } from "../../src/profile";
import { TEST_MEDIA_ARGS } from "../../src/test-browser.js";
import { FIXTURE_HOSTS } from "./fixture";

export interface FixtureTarget {
  port: number;
  spki: string;
  hosts?: readonly string[];
}

export interface FixtureBrowser {
  executable: string;
  args: string[];
  userDataDir: string;
  /** DevToolsActivePort in the temp profile, the file bao's live host reads. */
  portFile: string;
  /** The debugging port Chrome picked. */
  cdpPort: number;
  /** http://127.0.0.1:{cdpPort}, for chromium.connectOverCDP. */
  cdpUrl: string;
  /** ws://127.0.0.1:{cdpPort}/devtools/browser/{id}. */
  wsEndpoint: string;
  pid: number;
  /** Stop Chrome and delete the profile. */
  close(): Promise<void>;
}

export function hostResolverRules(port: number, hosts: readonly string[] = FIXTURE_HOSTS): string {
  return [...hosts.map((host) => `MAP ${host} 127.0.0.1:${port}`), "MAP * ~NOTFOUND"].join(", ");
}

export function fixtureBrowserArgs(
  target: FixtureTarget,
  userDataDir: string,
  opts: { headless: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): string[] {
  const sandbox = needsLinuxNoSandbox(opts.env ?? process.env, opts.platform ?? process.platform) ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  return [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--use-mock-keychain",
    "--password-store=basic",
    ...TEST_MEDIA_ARGS,
    `--host-resolver-rules=${hostResolverRules(target.port, target.hosts)}`,
    `--ignore-certificate-errors-spki-list=${target.spki}`,
    ...sandbox,
    ...(opts.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

async function waitForPortFile(file: string, child: ChildProcess, timeoutMs: number): Promise<{ port: number; wsPath: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null || child.signalCode != null) throw new Error(`test browser exited before DevToolsActivePort (${child.exitCode ?? child.signalCode})`);
    if (existsSync(file)) {
      const [port = "", wsPath = ""] = readFileSync(file, "utf8").split("\n");
      if (/^\d+$/.test(port) && wsPath.startsWith("/devtools/browser/")) return { port: Number(port), wsPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`DevToolsActivePort was not written to ${file}`);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

export async function launchFixtureBrowser(
  target: FixtureTarget,
  opts: { headless?: boolean; executablePath?: string; timeoutMs?: number } = {},
): Promise<FixtureBrowser> {
  const executable = opts.executablePath || pinTestBrowser();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bao-instacart-chrome-"));
  assertNotDailyChrome(userDataDir);
  const headless = opts.headless ?? process.env.BAO_HEADED !== "1";
  const args = fixtureBrowserArgs(target, userDataDir, { headless });
  const child = spawn(executable, args, { stdio: "ignore" });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  // A test process that crashes before close() would leave Chrome running with no parent.
  const onExit = (): void => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(userDataDir, { recursive: true, force: true });
  };
  process.once("exit", onExit);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", onExit);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    await Promise.race([exited(child), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    for (const pid of pidsForDataDir(userDataDir)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(userDataDir, { recursive: true, force: true });
  };
  try {
    const { port, wsPath } = await waitForPortFile(portFile, child, opts.timeoutMs ?? 20_000);
    return {
      executable,
      args,
      userDataDir,
      portFile,
      cdpPort: port,
      cdpUrl: `http://127.0.0.1:${port}`,
      wsEndpoint: `ws://127.0.0.1:${port}${wsPath}`,
      pid: child.pid ?? 0,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
