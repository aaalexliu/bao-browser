// One debugging connection per running Chrome. Chrome asks on every new WebSocket to /devtools/browser, so a long-lived
// Bao process owns that socket for one user-data-dir (every profile in it shares the port) and publishes the local
// endpoint here. Sessions join it. A session leaving does not close it. Chrome quitting does: the next session starts
// a new hold, which is one new sheet.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appBundleOf } from "../app/bundle";
import type { CurrentChrome } from "./current-chrome";
import { shareConnection } from "./shared-connection";
import { connectCdp } from "./socket";

/** Shared by every Bao home on this Mac. A private TMPDIR must not split the owner's Chrome into two sheets. */
const HOLD_ROOT = "/tmp/bao-chrome-hold";
const HOLD_WAIT_MS = 120_000;

export interface HoldOptions {
  root: string;
  axLog: string;
  signal?: AbortSignal;
}

interface HoldRecord {
  root: string;
  chromePid: number;
  executable: string;
  port: number;
  browserPath: string;
  holderPid: number;
}

interface HoldStarting {
  holderPid: number;
  startedAt: number;
}

interface HoldFixture {
  port: number;
  browserPath: string;
  chromePid: number;
  executable: string;
}

export function holdDir(root: string): string {
  const real = realpathSync(root);
  return path.join(HOLD_ROOT, createHash("sha256").update(real).digest("hex").slice(0, 32));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cliPath(): string {
  return path.join(__dirname, "../app/cli.js");
}

/**
 * Inside Bao.app, Node must stay a child of `bao --run-node` so macOS attributes the Chrome folder read to Bao.
 * A checkout has no app executable, so it starts Node directly, as `bao mcp` does there.
 */
export function holdLaunch(cli: string, options: HoldOptions, bao?: string): { command: string; args: string[] } {
  const args = ["chrome-hold", "--root", options.root, "--ax-log", options.axLog];
  if (bao) return { command: bao, args: ["--run-node", "--own", cli, ...args] };
  return { command: process.execPath, args: [cli, ...args] };
}

function spawnHolder(options: HoldOptions): number {
  const cli = cliPath();
  const app = appBundleOf(cli);
  const bao = app ? path.join(app, "Contents", "MacOS", "bao") : undefined;
  const launch = holdLaunch(cli, options, bao && existsSync(bao) ? bao : undefined);
  const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  if (!child.pid) throw new Error("Bao could not start its Chrome connection");
  return child.pid;
}

async function withHoldLock<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const file = path.join(dir, "lock");
  const deadline = Date.now() + HOLD_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      try {
        return await body();
      } finally {
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let dead = false;
      try { dead = !pidAlive(Number(readFileSync(file, "utf8").trim())); }
      catch { dead = false; }
      if (dead) {
        try { unlinkSync(file); continue; } catch { /* the other taker won */ }
      }
      if (Date.now() >= deadline) throw new Error("Bao is still opening its Chrome connection");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch { return undefined; }
}

function isRecord(value: HoldRecord | undefined, root: string): value is HoldRecord {
  return !!value && value.root === root && Number.isInteger(value.port) && value.browserPath.startsWith("/devtools/browser")
    && Number.isInteger(value.holderPid) && Number.isInteger(value.chromePid) && typeof value.executable === "string";
}

/** The published hold, if its process is still alive. The caller removes a dead record while it holds the lock. */
async function readLive(dir: string, root: string): Promise<HoldRecord | undefined> {
  const record = await readJson<HoldRecord>(path.join(dir, "hold.json"));
  if (!isRecord(record, root) || !pidAlive(record.holderPid)) return undefined;
  return record;
}

async function readStarting(dir: string): Promise<HoldStarting | undefined> {
  const starting = await readJson<HoldStarting>(path.join(dir, "starting.json"));
  if (!starting || !Number.isInteger(starting.holderPid) || !Number.isFinite(starting.startedAt)) return undefined;
  return starting;
}

async function readErr(dir: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path.join(dir, "hold.err"), "utf8")).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function ensureHold(dir: string, root: string, options: HoldOptions): Promise<HoldRecord> {
  const ready = await withHoldLock(dir, async () => {
    const live = await readLive(dir, root);
    if (live) return live;
    const starting = await readStarting(dir);
    if (starting && pidAlive(starting.holderPid) && Date.now() - starting.startedAt < HOLD_WAIT_MS) return undefined;
    await rm(path.join(dir, "starting.json"), { force: true });
    await rm(path.join(dir, "hold.err"), { force: true });
    await rm(path.join(dir, "hold.json"), { force: true });
    const holderPid = spawnHolder(options);
    await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid, startedAt: Date.now() }), { mode: 0o600 });
    return undefined;
  });
  return ready ?? waitForHold(dir, root, options.signal);
}

async function waitForHold(dir: string, root: string, signal?: AbortSignal): Promise<HoldRecord> {
  const deadline = Date.now() + HOLD_WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const live = await readLive(dir, root);
    if (live) return live;
    const err = await readErr(dir);
    if (err) throw new Error(err);
    const starting = await readStarting(dir);
    if (!starting || !pidAlive(starting.holderPid)) throw new Error(err || "Bao's Chrome connection stopped before it was ready");
    if (Date.now() >= deadline) throw new Error("Bao's Chrome connection did not open");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function joinRecord(record: HoldRecord, signal?: AbortSignal): Promise<CurrentChrome> {
  const endpoint = { port: record.port, browserPath: record.browserPath };
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5_000, signal });
  try {
    await cdp.send("Browser.getVersion", {}, undefined, 5_000);
  } catch (error) {
    cdp.close();
    throw error;
  }
  return {
    pid: record.chromePid,
    executable: record.executable,
    root: record.root,
    endpoint,
    cdp,
    closed: cdp.disconnected,
    isClosed: () => !cdp.isOpen,
    detach: () => cdp.close(),
  };
}

/** Joins the hold for this user-data-dir, starting it when Chrome has none. A second call does not open a second socket. */
export async function joinOrStartHold(options: HoldOptions): Promise<CurrentChrome> {
  const root = realpathSync(options.root);
  const dir = holdDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  let missed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = await ensureHold(dir, root, options);
    try {
      return await joinRecord(record, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (await readLive(dir, root)) throw error;
      if (missed) throw error;
      missed = true;
    }
  }
  throw new Error("Bao's Chrome connection closed before the session joined");
}

async function connectFixture(root: string, fixture: HoldFixture): Promise<CurrentChrome> {
  const cdp = await connectCdp(fixture.port, fixture.browserPath, { timeoutMs: 10_000 });
  try {
    await cdp.send("Browser.getVersion", {}, undefined, 10_000);
  } catch (error) {
    cdp.close();
    throw error;
  }
  const shared = await shareConnection(cdp);
  return {
    pid: fixture.chromePid,
    executable: fixture.executable,
    root,
    endpoint: shared.endpoint,
    cdp,
    closed: cdp.disconnected,
    isClosed: () => !cdp.isOpen,
    detach: () => { shared.close(); cdp.close(); },
  };
}

function readFixture(): HoldFixture | undefined {
  // A test points the hold at a throwaway browser. A normal session never has these, so it cannot skip the Allow sheet.
  if (!process.env.BAO_TEST_BROWSER && !process.env.BAO_LANE) return undefined;
  const raw = process.env.BAO_CHROME_HOLD_FIXTURE;
  if (!raw) return undefined;
  const fixture = JSON.parse(raw) as HoldFixture;
  if (!Number.isInteger(fixture.port) || !fixture.browserPath?.startsWith("/devtools/browser") || !Number.isInteger(fixture.chromePid) || !fixture.executable) {
    throw new Error("BAO_CHROME_HOLD_FIXTURE is not a throwaway Chrome endpoint");
  }
  return fixture;
}

/** Owns the Chrome socket until Chrome quits, and publishes the endpoint sessions join. */
export async function serveHold(chrome: CurrentChrome, stillRunning: () => Promise<boolean>, signal?: AbortSignal): Promise<void> {
  const root = realpathSync(chrome.root);
  const dir = holdDir(root);
  const record: HoldRecord = {
    root, chromePid: chrome.pid, executable: chrome.executable,
    port: chrome.endpoint.port, browserPath: chrome.endpoint.browserPath, holderPid: process.pid,
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, "hold.json"), JSON.stringify(record), { mode: 0o600 });
  await rm(path.join(dir, "starting.json"), { force: true });
  await rm(path.join(dir, "hold.err"), { force: true });
  let misses = 0;
  const timer = setInterval(() => {
    void stillRunning().then((running) => {
      misses = running ? 0 : misses + 1;
      if (misses >= 2) chrome.detach();
    }).catch(() => undefined);
  }, 2_000);
  timer.unref();
  const stopped = new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([chrome.closed, stopped]);
  clearInterval(timer);
  chrome.detach();
  await rm(path.join(dir, "hold.json"), { force: true });
  await rm(path.join(dir, "starting.json"), { force: true });
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** `bao chrome-hold`. Not a user command: sessions start it and then join its endpoint. */
export async function holdMain(args: readonly string[]): Promise<void> {
  const rootArg = flag(args, "--root");
  const axLog = flag(args, "--ax-log");
  if (!rootArg || !axLog) throw new Error("usage: bao chrome-hold --root dir --ax-log file");
  const root = realpathSync(rootArg);
  const dir = holdDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  const stopping = new AbortController();
  process.once("SIGTERM", () => stopping.abort());
  process.once("SIGINT", () => stopping.abort());
  try {
    const fixture = readFixture();
    const { connectOwnedChrome } = await import("./current-chrome");
    const { dailyChromePids } = await import("./remote-debugging");
    const { chromeProfilesRoot } = await import("../engines/chrome-profile-copy");
    const chrome = fixture ? await connectFixture(root, fixture) : await connectOwnedChrome({ root, axLog });
    const stillRunning = fixture
      ? async () => pidAlive(fixture.chromePid)
      : async () => (await dailyChromePids(root, chromeProfilesRoot())).includes(chrome.pid);
    await serveHold(chrome, stillRunning, stopping.signal);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(path.join(dir, "hold.err"), message, { mode: 0o600 });
    await rm(path.join(dir, "starting.json"), { force: true });
    throw error;
  }
}
