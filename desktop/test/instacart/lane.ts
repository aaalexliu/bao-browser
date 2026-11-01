// The setup lanes L1 and L2 share: the Instacart fixture, the test browser that maps
// www.instacart.com to it, and a spawned `bao serve` with a temp home whose live target is
// that browser. Every spawned bao process gets a temp HOME, so the native host manifest and
// the app's homes stay in the temp dir, and the private live lock keeps the lane from
// waiting on, or blocking, a Bao on the same Mac.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { applyHermeticApp } from "../runtime";
import { launchFixtureBrowser, type FixtureBrowser } from "./browser";
import { startInstacartFixture, type InstacartFixture } from "./fixture";

/** The built bao CLI. */
export const CLI = path.join(__dirname, "../../src/app/cli.js");

export async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export interface Serve {
  close(): Promise<void>;
}

/** `bao serve` as a person starts it: a temp home, the test browser as the live target, and its own live lock. */
export async function startServe(env: NodeJS.ProcessEnv, home: string, portFile: string, lockFile: string, evalVideoNoBlur?: true): Promise<Serve> {
  const args = evalVideoNoBlur ? ["-e", `
    const { startApp } = require(${JSON.stringify(path.join(__dirname, "../../src/app/server.js"))});
    startApp(${JSON.stringify({ home, port: 0, extensionHost: true, liveTarget: `throwaway:${portFile}`, liveLockFile: lockFile, evalVideoNoBlur: true })}).then(app => {
      console.log('bao ' + app.port + ' home ' + ${JSON.stringify(home)});
      process.once('SIGTERM', () => app.close().then(() => process.exit(0)));
    }).catch(error => { console.error(error); process.exit(1); });
  `] : [CLI, "serve", "--home", home, "--port", "0", "--live-target", `throwaway:${portFile}`, "--live-lock", lockFile];
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await until(() => {
    if (proc.exitCode !== null) throw new Error(`bao serve exited ${proc.exitCode}: ${stderr}`);
    return /^bao \d+ home /m.test(stdout) ? true : undefined;
  }, "bao serve", 60_000);
  return {
    async close() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

export interface Lane {
  fixture: InstacartFixture;
  browser: FixtureBrowser;
  /** The env every bao process of the lane gets: the temp home and a temp HOME. */
  env: NodeJS.ProcessEnv;
  home: string;
  /** The temp dir that holds the home, the HOME, and the lock. */
  root: string;
  lockFile: string;
  /** Stop the app, the browser, and the fixture, and delete the temp dir. */
  close(): Promise<void>;
}

/** Start the fixture, the test browser, and `bao serve`. base must already be a hermetic env. */
export async function startLane(name: string, base: NodeJS.ProcessEnv, evalVideoNoBlur?: true): Promise<Lane> {
  const fixture = await startInstacartFixture();
  let browser: FixtureBrowser | undefined;
  let serve: Serve | undefined;
  let root = "";
  const close = async (): Promise<void> => {
    await serve?.close();
    await browser?.close();
    await fixture.close();
    if (root) rmSync(root, { recursive: true, force: true });
  };
  try {
    browser = await launchFixtureBrowser(fixture);
    const env = { ...base };
    const home = applyHermeticApp(name, env).home;
    root = path.dirname(home);
    env.HOME = path.join(root, "user");
    mkdirSync(env.HOME, { recursive: true });
    const lockFile = path.join(root, "live.lock");
    serve = await startServe(env, home, browser.portFile, lockFile, evalVideoNoBlur);
    return { fixture, browser, env, home, root, lockFile, close };
  } catch (err) {
    await close();
    throw err;
  }
}
