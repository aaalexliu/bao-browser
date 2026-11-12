// One debugging connection per running Chrome. Chrome asks on every new WebSocket to /devtools/browser, so a long-lived
// Bao process owns that socket for one user-data-dir (every profile in it shares the port) and publishes the local
// endpoint here. Sessions join it. A session leaving does not close it. Chrome quitting does: the kernel closes the
// loopback socket, the hold ends, and the next session starts a new hold, which is one new sheet.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { appBundleOf } from "../app/bundle";
import { chromeDataPath } from "../chrome-access";
import type { CurrentChrome } from "./current-chrome";
import { shareConnection } from "./shared-connection";
import { connectCdp } from "./socket";

const HOLD_WAIT_MS = 120_000;

/** Shared by every Bao home on this Mac, and private to this user. A private TMPDIR must not split the owner's Chrome into two sheets. */
function holdRoot(): string {
  const id = process.getuid?.();
  if (id === undefined) throw new Error("Bao's Chrome connection needs a user id");
  return `/tmp/bao-chrome-hold-${id}`;
}

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
  return path.join(holdRoot(), createHash("sha256").update(chromeDataPath(root)).digest("hex").slice(0, 32));
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

function assertOwnedDir(dir: string): void {
  const id = process.getuid?.();
  let st;
  try { st = lstatSync(dir); } catch { throw new Error("Bao's Chrome connection directory is not private"); }
  if (!st.isDirectory() || id === undefined || st.uid !== id || (st.mode & 0o777) !== 0o700) {
    throw new Error("Bao's Chrome connection directory is not private");
  }
}

async function ensureOwnedDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = process.getuid?.();
  let st = lstatSync(dir);
  if (!st.isDirectory() || id === undefined || st.uid !== id) throw new Error("Bao's Chrome connection directory is not private");
  if ((st.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700);
    st = lstatSync(dir);
    if (!st.isDirectory() || st.uid !== id || (st.mode & 0o777) !== 0o700) {
      throw new Error("Bao's Chrome connection directory is not private");
    }
  }
}

async function prepareHoldDir(dir: string): Promise<void> {
  await ensureOwnedDir(path.dirname(dir));
  await ensureOwnedDir(dir);
}

function unlinkIfSymlink(file: string): boolean {
  try {
    if (!lstatSync(file).isSymbolicLink()) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function writePrivate(file: string, text: string): void {
  assertOwnedDir(path.dirname(file));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, text);
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP" || attempt === 1 || !unlinkIfSymlink(file)) throw error;
    }
  }
}

function readPrivate(file: string): string | undefined {
  try { assertOwnedDir(path.dirname(file)); } catch { return undefined; }
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } catch {
    return undefined;
  }
}

let lockNonce = 0;
function uniqueSuffix(): string {
  lockNonce += 1;
  return `${process.pid}.${Date.now()}.${lockNonce}`;
}

/** A parsed pid that is not running. Empty, unreadable, or live content is not this. */
function deadPid(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[1-9]\d{0,9}$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  if (!Number.isSafeInteger(pid) || pidAlive(pid)) return undefined;
  return pid;
}

function restoreLock(stale: string, file: string): void {
  try { linkSync(stale, file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
  }
  try { unlinkSync(stale); } catch { /* the canonical name remains, or both are gone */ }
}

function takeDeadLock(file: string): boolean {
  let fd: number | undefined;
  let seen: { pid: number; dev: number; ino: number } | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    const pid = deadPid(readFileSync(fd, "utf8"));
    if (pid !== undefined) seen = { pid, dev: st.dev, ino: st.ino };
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!seen) return false;
  const stale = `${file}.stale.${uniqueSuffix()}`;
  try { renameSync(file, stale); } catch { return false; }
  let movedDev = 0;
  let movedIno = 0;
  let stillDead = false;
  try {
    const moved = openSync(stale, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(moved);
      movedDev = st.dev;
      movedIno = st.ino;
      stillDead = deadPid(readFileSync(moved, "utf8")) === seen.pid;
    } finally { closeSync(moved); }
  } catch { stillDead = false; }
  if (movedDev !== seen.dev || movedIno !== seen.ino || !stillDead) {
    restoreLock(stale, file);
    return false;
  }
  try { unlinkSync(stale); } catch { /* already gone */ }
  return true;
}

function releaseLock(file: string): void {
  const done = `${file}.done.${uniqueSuffix()}`;
  try {
    renameSync(file, done);
    unlinkSync(done);
  } catch { /* already released, or a new holder owns the name */ }
}

async function withHoldLock<T>(dir: string, body: () => Promise<T>): Promise<T> {
  assertOwnedDir(dir);
  const file = path.join(dir, "lock");
  const deadline = Date.now() + HOLD_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" && unlinkIfSymlink(file)) continue;
      if (code !== "EEXIST") throw error;
      if (takeDeadLock(file)) continue;
      if (Date.now() >= deadline) throw new Error("Bao is still opening its Chrome connection");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (fd === undefined) throw new Error("Bao could not start its Chrome connection");
    const held = fd;
    fd = undefined;
    try {
      writeSync(held, `${process.pid}\n`);
      closeSync(held);
      return await body();
    } finally {
      releaseLock(file);
    }
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  const text = readPrivate(file);
  if (!text) return undefined;
  try { return JSON.parse(text) as T; }
  catch { return undefined; }
}

function isRecord(value: HoldRecord | undefined, root: string): value is HoldRecord {
  return !!value && value.root === root && Number.isInteger(value.port) && value.browserPath.startsWith("/devtools/browser")
    && Number.isInteger(value.holderPid) && Number.isInteger(value.chromePid) && typeof value.executable === "string";
}

function sameHold(a: HoldRecord, b: HoldRecord): boolean {
  return a.root === b.root && a.port === b.port && a.browserPath === b.browserPath
    && a.holderPid === b.holderPid && a.chromePid === b.chromePid && a.executable === b.executable;
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
  const text = readPrivate(path.join(dir, "hold.err"))?.trim();
  return text || undefined;
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
    writePrivate(path.join(dir, "starting.json"), JSON.stringify({ holderPid, startedAt: Date.now() }));
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
    const starting = await readStarting(dir);
    if (starting && pidAlive(starting.holderPid)) {
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
    }
    const again = await readLive(dir, root);
    if (again) return again;
    const err = await readErr(dir);
    if (starting && pidAlive(starting.holderPid)) throw new Error(err || "Bao's Chrome connection did not open");
    throw new Error(err || "Bao's Chrome connection stopped before it was ready");
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

function connectionRefused(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
}

async function dropUnchanged(dir: string, record: HoldRecord): Promise<void> {
  await withHoldLock(dir, async () => {
    const current = await readJson<HoldRecord>(path.join(dir, "hold.json"));
    if (current && isRecord(current, record.root) && !sameHold(current, record)) return;
    await rm(path.join(dir, "hold.json"), { force: true });
    await rm(path.join(dir, "hold.err"), { force: true });
    const starting = await readStarting(dir);
    if (!starting || starting.holderPid === record.holderPid) await rm(path.join(dir, "starting.json"), { force: true });
  });
}

/** Joins the hold for this user-data-dir, starting it when Chrome has none. A second call does not open a second socket. */
export async function joinOrStartHold(options: HoldOptions): Promise<CurrentChrome> {
  const root = chromeDataPath(options.root);
  const dir = holdDir(root);
  await prepareHoldDir(dir);
  let missed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = await ensureHold(dir, root, options);
    try {
      return await joinRecord(record, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (connectionRefused(error)) {
        await dropUnchanged(dir, record);
        continue;
      }
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

/** The throwaway listener a test named. Absent in a normal session, so that session cannot skip the Allow sheet. */
export function holdFixtureEndpoint(): { port: number; browserPath: string } | undefined {
  const fixture = readFixture();
  return fixture ? { port: fixture.port, browserPath: fixture.browserPath } : undefined;
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

/** Owns the Chrome socket until that socket closes, and publishes the endpoint sessions join. */
export async function serveHold(chrome: CurrentChrome, signal?: AbortSignal): Promise<void> {
  const root = chromeDataPath(chrome.root);
  const dir = holdDir(root);
  const record: HoldRecord = {
    root, chromePid: chrome.pid, executable: chrome.executable,
    port: chrome.endpoint.port, browserPath: chrome.endpoint.browserPath, holderPid: process.pid,
  };
  await prepareHoldDir(dir);
  await withHoldLock(dir, async () => {
    writePrivate(path.join(dir, "hold.json"), JSON.stringify(record));
    await rm(path.join(dir, "starting.json"), { force: true });
    await rm(path.join(dir, "hold.err"), { force: true });
  });
  const stopped = new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([chrome.closed, stopped]);
  chrome.detach();
  await withHoldLock(dir, async () => {
    const current = await readJson<HoldRecord>(path.join(dir, "hold.json"));
    if (!current || current.holderPid === process.pid) await rm(path.join(dir, "hold.json"), { force: true });
    const starting = await readStarting(dir);
    if (!starting || starting.holderPid === process.pid) await rm(path.join(dir, "starting.json"), { force: true });
  });
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** `bao chrome-hold`. Not a user command: sessions start it and then join its endpoint. The opener is passed in so this module does not import the session entry that joins it. */
export async function holdMain(
  args: readonly string[],
  openChrome?: (options: { root: string; axLog: string }) => Promise<CurrentChrome>,
): Promise<void> {
  const rootArg = flag(args, "--root");
  const axLog = flag(args, "--ax-log");
  if (!rootArg || !axLog) throw new Error("usage: bao chrome-hold --root dir --ax-log file");
  const root = chromeDataPath(rootArg);
  const dir = holdDir(root);
  await prepareHoldDir(dir);
  writePrivate(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }));
  const stopping = new AbortController();
  process.once("SIGTERM", () => stopping.abort());
  process.once("SIGINT", () => stopping.abort());
  try {
    const fixture = readFixture();
    let chrome: CurrentChrome;
    if (fixture) chrome = await connectFixture(root, fixture);
    else if (openChrome) chrome = await openChrome({ root, axLog });
    else throw new Error("bao chrome-hold was started without its Chrome opener");
    await serveHold(chrome, stopping.signal);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withHoldLock(dir, async () => {
      writePrivate(path.join(dir, "hold.err"), message);
      const starting = await readStarting(dir);
      if (!starting || starting.holderPid === process.pid) await rm(path.join(dir, "starting.json"), { force: true });
    });
    throw error;
  }
}
