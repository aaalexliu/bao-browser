// One debugging connection per running Chrome. The detached chrome-hold process owns that socket and is the only
// process that turns the remote-debugging switch on or off. It keeps an exclusive lock from the moment it starts
// until that off has finished. The kernel drops the lock when the process exits, so a crash leaves nothing to
// reclaim, and no client ever takes it. A session is a connection the holder has counted and confirmed on that
// socket. The client uses the shared connection only after that confirmation. When Bao turned the switch on, the
// last confirmed connection to close turns it off. When the owner had already turned it on, the hold stays while
// Chrome runs. Chrome quitting does not delete a claim Bao still owns. A holder from an older Bao takes no lock, so
// the new owner ends it before connecting.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, lstatSync, openSync, readFileSync, read as readFd, unlinkSync, writeSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appBundleOf } from "../app/bundle";
import { chromeDataPath } from "../chrome-access";
import type { CurrentChrome } from "./current-chrome";
import { REMOTE_CHECKBOX } from "./consent";
import { claimOwned, finishOwnedSwitch, testProcess, turnSwitchOff, writeClaim } from "./debug-switch";
import { shareConnection } from "./shared-connection";
import { connectCdp } from "./socket";

const HOLD_WAIT_MS = 120_000;
const ADMITTED = 0x31;

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
  /** Attach to a Chrome that is already listening. Do not start Chrome or turn the switch on. */
  listenOnly?: boolean;
  /** Turn off a leftover claim and exit. Not a session. */
  settle?: boolean;
}

interface HoldRecord {
  root: string;
  chromePid: number;
  executable: string;
  port: number;
  browserPath: string;
  holderPid: number;
  sessionPort?: number;
}

interface HoldStarting {
  holderPid: number;
  startedAt: number;
  sessionPort?: number;
  stopping?: boolean;
}

interface HoldFixture {
  port: number;
  browserPath: string;
  chromePid: number;
  executable: string;
}

interface SpawnedHold {
  pid: number;
  initiator?: net.Socket;
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

/** A live holder is waited on, including one that is still opening or turning the switch off. A dead start is replaced. */
export function starterReusable(
  starting: { holderPid: number; startedAt?: number; stopping?: boolean } | undefined,
  alive: (pid: number) => boolean,
): "wait" | "replace" {
  if (!starting || !alive(starting.holderPid)) return "replace";
  return "wait";
}

/** Whether this hold should turn the switch off, leave it, or keep serving. */
export function holdEnd(input: {
  signaled: boolean;
  chromeClosed: boolean;
  sessions: number;
  owned: boolean;
  seenSession: boolean;
}): "turn-off" | "leave" | "wait" {
  if (input.signaled || input.chromeClosed) return input.owned ? "turn-off" : "leave";
  if (input.seenSession && input.sessions === 0) return input.owned ? "turn-off" : "leave";
  return "wait";
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
  if (options.listenOnly) args.push("--listen-only");
  if (options.settle) args.push("--settle");
  if (bao) return { command: bao, args: ["--run-node", "--own", cli, ...args] };
  return { command: process.execPath, args: [cli, ...args] };
}

function spawnHolder(options: HoldOptions): SpawnedHold {
  const cli = cliPath();
  const app = appBundleOf(cli);
  const bao = app ? path.join(app, "Contents", "MacOS", "bao") : undefined;
  const launch = holdLaunch(cli, options, bao && existsSync(bao) ? bao : undefined);
  const settle = options.settle === true;
  const args = settle ? launch.args : [...launch.args, "--initiator-fd", "3"];
  const child = spawn(launch.command, args, {
    detached: true,
    stdio: settle ? "ignore" : ["ignore", "ignore", "ignore", "pipe"],
    env: process.env,
  });
  child.unref();
  if (!child.pid) throw new Error("Bao could not start its Chrome connection");
  const pipe = child.stdio[3];
  const initiator = pipe instanceof net.Socket ? pipe : undefined;
  initiator?.unref();
  return { pid: child.pid, initiator };
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

let ownerDb: DatabaseSync | undefined;

function lockBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("database is locked") || message.includes("database is busy");
}

/** Exclusive lock this process keeps open until switch cleanup finishes. A second holder gets false. The kernel drops it on exit. */
function takeOwnerLock(dir: string): boolean {
  if (ownerDb) return true;
  const file = path.join(dir, "owner.lock");
  unlinkIfSymlink(file);
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (lockBusy(error)) return false;
    throw error;
  }
  ownerDb = db;
  return true;
}

function releaseOwnerLock(): void {
  const db = ownerDb;
  ownerDb = undefined;
  try { db?.close(); } catch { /* the process is leaving */ }
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

/** The published hold, if its process is still alive. */
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

function writeHoldErr(dir: string, message: string): void {
  writePrivate(path.join(dir, "hold.err"), JSON.stringify({ holderPid: process.pid, message }));
}

function readErr(dir: string, holderPid: number | undefined): string | undefined {
  if (holderPid === undefined) return undefined;
  const text = readPrivate(path.join(dir, "hold.err"))?.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { holderPid?: unknown; message?: unknown };
    if (parsed.holderPid !== holderPid || typeof parsed.message !== "string" || !parsed.message.trim()) return undefined;
    return parsed.message;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED";
}

export interface HoldSessions {
  port: number;
  count(): number;
  drain(): void;
  resume(): void;
  nextChange(): Promise<void>;
  close(): void;
}

/** Loopback sockets the hold counts as sessions. A drain closes a new socket without confirming it. */
export function bindHoldSessions(): Promise<HoldSessions> {
  let count = 0;
  let draining = false;
  let waiters: (() => void)[] = [];
  const changed = () => {
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
  };
  const server = net.createServer((socket) => {
    if (draining) {
      socket.destroy();
      return;
    }
    count += 1;
    changed();
    socket.write(Buffer.from([ADMITTED]));
    const down = () => {
      count = Math.max(0, count - 1);
      changed();
    };
    socket.on("close", down);
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Bao could not listen for its Chrome session"));
        return;
      }
      resolve({
        port: address.port,
        count: () => count,
        drain() { draining = true; },
        resume() { draining = false; },
        nextChange: () => new Promise((done) => { waiters.push(done); }),
        close() {
          server.close();
          changed();
        },
      });
    });
  });
}

/** Resolves only after the holder has counted this socket and said so. A drain or a close rejects. */
function admitSession(port: number, signal?: AbortSignal): Promise<net.Socket> {
  const socket = net.connect({ host: "127.0.0.1", port });
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", (chunk: Buffer) => {
      if (settled || !chunk.includes(ADMITTED)) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners("data");
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
    socket.once("error", (error) => fail(error));
    socket.once("close", () => fail(Object.assign(new Error("session closed"), { code: "ECONNREFUSED" })));
  });
}

function bindSession(chrome: CurrentChrome, socket: net.Socket): CurrentChrome {
  const detach = chrome.detach.bind(chrome);
  let released = false;
  chrome.detach = () => {
    if (!released) {
      released = true;
      socket.destroy();
    }
    detach();
  };
  return chrome;
}

async function joinAdmitted(record: HoldRecord, signal?: AbortSignal): Promise<CurrentChrome> {
  if (!record.sessionPort) throw Object.assign(new Error("session closed"), { code: "ECONNREFUSED" });
  const socket = await admitSession(record.sessionPort, signal);
  try {
    return bindSession(await joinRecord(record, signal), socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function waitForPublished(
  dir: string,
  root: string,
  holderPid: number,
  socket: net.Socket,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<HoldRecord | undefined> {
  while (Date.now() < deadline && !socket.destroyed) {
    signal?.throwIfAborted();
    const record = await readLive(dir, root);
    if (record?.holderPid === holderPid && record.sessionPort) return record;
    const starting = await readStarting(dir);
    if (!starting || starting.holderPid !== holderPid || !pidAlive(holderPid)) return undefined;
    await sleep(20);
  }
  return undefined;
}

/** The opener we are waiting on failed. A published hold is not that failure. */
async function openerFailure(dir: string, root: string, holderPid: number | undefined): Promise<string | undefined> {
  if (holderPid === undefined || await readLive(dir, root)) return undefined;
  return readErr(dir, holderPid);
}

/** Joins the hold for this user-data-dir, starting it when Chrome has none. A second call does not open a second Chrome socket. */
export async function joinOrStartHold(options: HoldOptions): Promise<CurrentChrome> {
  const root = chromeDataPath(options.root);
  const dir = holdDir(root);
  await prepareHoldDir(dir);
  const deadline = Date.now() + HOLD_WAIT_MS;
  let spawned: SpawnedHold | undefined;
  let boundTo: number | undefined;
  let lastError: Error | undefined;
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const record = await readLive(dir, root);
      if (record?.sessionPort) {
        try {
          return await joinAdmitted(record, options.signal);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));
          if (!connectionRefused(error) && await readLive(dir, root)) throw lastError;
          await sleep(20);
          continue;
        }
      }
      const starting = await readStarting(dir);
      if (starting && pidAlive(starting.holderPid)) boundTo = starting.holderPid;
      if (starting && pidAlive(starting.holderPid) && !starting.sessionPort) {
        await sleep(20);
        continue;
      }
      if (starting?.sessionPort && pidAlive(starting.holderPid)) {
        try {
          const socket = await admitSession(starting.sessionPort, options.signal);
          try {
            const published = await waitForPublished(dir, root, starting.holderPid, socket, options.signal, deadline);
            if (!published) {
              socket.destroy();
              const failed = await openerFailure(dir, root, starting.holderPid);
              if (failed) throw new Error(failed);
              await sleep(20);
              continue;
            }
            try {
              return bindSession(await joinRecord(published, options.signal), socket);
            } catch (error) {
              socket.destroy();
              throw error;
            }
          } catch (error) {
            socket.destroy();
            throw error;
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const failed = await openerFailure(dir, root, starting.holderPid);
          if (failed) throw new Error(failed);
          lastError = error instanceof Error ? error : new Error(String(error));
          await sleep(20);
          continue;
        }
      }
      if (boundTo) {
        const failed = await openerFailure(dir, root, boundTo);
        if (failed) throw new Error(failed);
        if (pidAlive(boundTo)) {
          await sleep(20);
          continue;
        }
      }
      if (!spawned || !pidAlive(spawned.pid)) {
        spawned = spawnHolder(options);
        boundTo = spawned.pid;
      }
      await sleep(20);
    }
  } finally {
    spawned?.initiator?.destroy();
  }
  const err = readErr(dir, boundTo);
  throw new Error(err || lastError?.message || "Bao's Chrome connection closed before the session joined");
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
export function holdFixtureEndpoint(): { port: number; browserPath: string; chromePid: number; executable: string } | undefined {
  const fixture = readFixture();
  return fixture ? { port: fixture.port, browserPath: fixture.browserPath, chromePid: fixture.chromePid, executable: fixture.executable } : undefined;
}

/** Joins a published hold only after that hold has counted this session. Undefined when none is published. */
export async function joinLiveHold(root: string, signal?: AbortSignal): Promise<CurrentChrome | undefined> {
  const dataRoot = chromeDataPath(root);
  const dir = holdDir(dataRoot);
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const record = await readLive(dir, dataRoot);
    if (!record) return undefined;
    if (!record.sessionPort) return undefined;
    try {
      return await joinAdmitted(record, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!connectionRefused(error)) throw error;
      await sleep(20);
    }
  }
  return undefined;
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

/** Owns the Chrome socket until that socket closes or the signal fires, and publishes the endpoint sessions join. */
export async function serveHold(
  chrome: CurrentChrome,
  signal?: AbortSignal,
  extra?: { sessionPort?: number },
): Promise<void> {
  const root = chromeDataPath(chrome.root);
  const dir = holdDir(root);
  const record: HoldRecord = {
    root, chromePid: chrome.pid, executable: chrome.executable,
    port: chrome.endpoint.port, browserPath: chrome.endpoint.browserPath, holderPid: process.pid,
    ...(extra?.sessionPort ? { sessionPort: extra.sessionPort } : {}),
  };
  await prepareHoldDir(dir);
  writePrivate(path.join(dir, "hold.json"), JSON.stringify(record));
  await rm(path.join(dir, "hold.err"), { force: true });
  const stopped = new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([chrome.closed, stopped]);
  chrome.detach();
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function markStopping(dir: string, sessionPort?: number): void {
  writePrivate(path.join(dir, "starting.json"), JSON.stringify({
    holderPid: process.pid, startedAt: Date.now(), stopping: true,
    ...(sessionPort ? { sessionPort } : {}),
  }));
}

async function clearForeign(dir: string): Promise<void> {
  const current = await readJson<HoldRecord>(path.join(dir, "hold.json"));
  if (current && current.holderPid !== process.pid) await rm(path.join(dir, "hold.json"), { force: true });
  const starting = await readStarting(dir);
  if (starting && starting.holderPid !== process.pid) await rm(path.join(dir, "starting.json"), { force: true });
  await rm(path.join(dir, "hold.err"), { force: true });
}

/**
 * Holders from a Bao before the owner lock, for this root. Their command line has no flag a current holder passes.
 * A current holder that lost the lock holds no Chrome connection, and the one that won it is this process.
 * An unreadable process list finds none, so the hold still opens.
 */
async function olderHolders(root: string): Promise<{ pid: number; axLog: string }[]> {
  const { processesNaming } = await import("../launch");
  let rows: { pid: number; command: string }[];
  try { rows = processesNaming("chrome-hold --root "); } catch { return []; }
  return rows.flatMap((row) => {
    const match = / chrome-hold --root (.+?) --ax-log /.exec(row.command);
    if (!match || row.pid === process.pid) return [];
    const axLog = row.command.slice(match.index + match[0].length);
    if (/ --(?:initiator-fd|settle|listen-only)\b/.test(axLog)) return [];
    try { return chromeDataPath(match[1]!) === root ? [{ pid: row.pid, axLog }] : []; }
    catch { return []; }
  });
}

function processStart(pid: number): number | undefined {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An older Bao kept no claim. It logged a checkbox press only when it turned the switch on, so a press in that
 * holder's own audit log after this Chrome started means Bao turned it on. No such press leaves the switch the owner's.
 */
async function olderBaoTurnedSwitchOn(root: string, axLogs: readonly string[]): Promise<boolean> {
  const pid = readFixture()?.chromePid ?? await oneChromePid(root);
  const started = pid ? processStart(pid) : undefined;
  if (started === undefined) return false;
  for (const axLog of axLogs) {
    let pressed: number | undefined;
    let log = "";
    try { log = readFileSync(axLog, "utf8"); } catch { continue; }
    for (const line of log.split("\n")) {
      try {
        const entry = JSON.parse(line) as { role?: unknown; name?: unknown; at?: unknown };
        if (entry.role === "AXCheckBox" && entry.name === REMOTE_CHECKBOX && typeof entry.at === "string") pressed = Date.parse(entry.at);
      } catch { /* not a log entry */ }
    }
    if (pressed !== undefined && pressed >= started) return true;
  }
  return false;
}

/** Ends every older holder before this one connects, so Chrome never has two Bao connections. */
async function retireOlderHolders(dir: string, root: string): Promise<void> {
  const older = await olderHolders(root);
  if (!older.length) return;
  const pids = older.map((holder) => holder.pid);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
    const deadline = Date.now() + 10_000;
    while (pids.some(pidAlive) && Date.now() < deadline) await sleep(50);
    if (!pids.some(pidAlive)) break;
  }
  if (pids.some(pidAlive)) throw new Error("An older Bao Chrome connection did not stop");
  if (await olderBaoTurnedSwitchOn(root, older.map((holder) => holder.axLog))) writeClaim(dir, true);
}

async function removeOwnStarting(dir: string): Promise<void> {
  const starting = await readStarting(dir);
  if (!starting || starting.holderPid === process.pid) await rm(path.join(dir, "starting.json"), { force: true });
}

async function oneChromePid(root: string): Promise<number | undefined> {
  try {
    const { chromeProfilesRoot } = await import("../engines/chrome-profile-copy");
    const { dailyChromePids } = await import("./remote-debugging");
    const pids = await dailyChromePids(root, chromeProfilesRoot());
    return pids.length === 1 ? pids[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Turns the switch off only when this hold owns it and Chrome is still the one process we can see. A miss keeps the claim. */
async function ownedOff(dir: string, root: string, axLog: string): Promise<void> {
  if (!claimOwned(dir) || testProcess()) return;
  const pid = await oneChromePid(root);
  if (!pid) return;
  await finishOwnedSwitch(dir, () => turnSwitchOff(pid, axLog));
}

async function unpublish(dir: string): Promise<void> {
  const current = await readJson<HoldRecord>(path.join(dir, "hold.json"));
  if (!current || current.holderPid === process.pid) await rm(path.join(dir, "hold.json"), { force: true });
}

function onceAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function watchInitiator(fd: number, sessions: HoldSessions, stopping: AbortController): void {
  const buf = Buffer.alloc(16);
  const pull = () => {
    readFd(fd, buf, 0, buf.length, null, (error, bytes) => {
      if (stopping.signal.aborted) return;
      if (error || bytes === 0) {
        if (sessions.count() === 0) stopping.abort();
        return;
      }
      pull();
    });
  };
  pull();
}

function watchZeroAfterAdmit(sessions: HoldSessions, stopping: AbortController, opening: () => boolean): void {
  void (async () => {
    let seen = sessions.count() > 0;
    while (opening() && !stopping.signal.aborted) {
      if (seen && sessions.count() === 0) {
        stopping.abort();
        return;
      }
      await sessions.nextChange();
      if (sessions.count() > 0) seen = true;
    }
  })().catch(() => undefined);
}

async function waitForFirstSession(sessions: HoldSessions, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    if (sessions.count() > 0) return true;
    await Promise.race([sessions.nextChange(), onceAborted(signal), sleep(50)]);
  }
  return sessions.count() > 0 && !signal.aborted;
}

async function waitForOtherOwner(dir: string, root: string): Promise<void> {
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (Date.now() < deadline) {
    const starting = await readStarting(dir);
    if ((starting && pidAlive(starting.holderPid)) || await readLive(dir, root)) return;
    await sleep(50);
  }
}

async function watchSessions(
  sessions: HoldSessions,
  chrome: CurrentChrome,
  signal: AbortSignal,
  dir: string,
): Promise<"turn-off" | "leave"> {
  let seen = true;
  for (;;) {
    const end = holdEnd({
      signaled: signal.aborted,
      chromeClosed: chrome.isClosed(),
      sessions: sessions.count(),
      owned: claimOwned(dir),
      seenSession: seen,
    });
    if (end === "turn-off") {
      sessions.drain();
      if (!signal.aborted && !chrome.isClosed() && sessions.count() > 0) {
        sessions.resume();
        seen = true;
        continue;
      }
      return "turn-off";
    }
    if (end === "leave") {
      if (!signal.aborted && !chrome.isClosed()) {
        await Promise.race([chrome.closed, onceAborted(signal), sessions.nextChange()]);
        if (sessions.count() > 0) seen = true;
        continue;
      }
      return "leave";
    }
    if (sessions.count() > 0) seen = true;
    await Promise.race([chrome.closed, onceAborted(signal), sessions.nextChange()]);
  }
}

async function openHeldChrome(
  args: readonly string[],
  root: string,
  axLog: string,
  signal: AbortSignal,
  openChrome?: (options: { root: string; axLog: string; signal?: AbortSignal; recordClaim?: boolean }) => Promise<CurrentChrome>,
): Promise<CurrentChrome> {
  const fixture = readFixture();
  const listenOnly = args.includes("--listen-only");
  if (fixture) return connectFixture(root, fixture);
  if (openChrome) return openChrome({ root, axLog, signal, recordClaim: !listenOnly });
  throw new Error("bao chrome-hold was started without its Chrome opener");
}

/** `bao chrome-hold`. Not a user command: sessions start it and then join its endpoint. The opener is passed in so this module does not import the session entry that joins it. */
export async function holdMain(
  args: readonly string[],
  openChrome?: (options: { root: string; axLog: string; signal?: AbortSignal; recordClaim?: boolean }) => Promise<CurrentChrome>,
): Promise<void> {
  const rootArg = flag(args, "--root");
  const axLog = flag(args, "--ax-log");
  if (!rootArg || !axLog) throw new Error("usage: bao chrome-hold --root dir --ax-log file");
  const root = chromeDataPath(rootArg);
  const dir = holdDir(root);
  await prepareHoldDir(dir);
  if (!takeOwnerLock(dir)) {
    if (!args.includes("--settle")) await waitForOtherOwner(dir, root);
    process.exit(0);
  }
  let exitCode = 0;
  try {
    try { await retireOlderHolders(dir, root); }
    catch (error) {
      writeHoldErr(dir, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (args.includes("--settle")) {
      await clearForeign(dir);
      markStopping(dir);
      try { await ownedOff(dir, root, axLog); }
      finally { await removeOwnStarting(dir); }
    } else {
      await clearForeign(dir);
      const sessions = await bindHoldSessions();
      const stopping = new AbortController();
      try {
        writePrivate(path.join(dir, "starting.json"), JSON.stringify({
          holderPid: process.pid, startedAt: Date.now(), sessionPort: sessions.port,
        }));
        const initiatorFd = Number(flag(args, "--initiator-fd"));
        if (Number.isInteger(initiatorFd) && initiatorFd >= 0) watchInitiator(initiatorFd, sessions, stopping);
        process.once("SIGTERM", () => stopping.abort());
        process.once("SIGINT", () => stopping.abort());
        const admitted = await waitForFirstSession(sessions, stopping.signal);
        if (!admitted) {
          if (claimOwned(dir)) {
            markStopping(dir, sessions.port);
            await ownedOff(dir, root, axLog);
          }
          await removeOwnStarting(dir);
        } else {
          let opening = true;
          watchZeroAfterAdmit(sessions, stopping, () => opening);
          let chrome: CurrentChrome | undefined;
          try {
            chrome = await openHeldChrome(args, root, axLog, stopping.signal, openChrome);
          } catch (error) {
            if (claimOwned(dir)) {
              markStopping(dir, sessions.port);
              await ownedOff(dir, root, axLog);
            }
            if (!stopping.signal.aborted) {
              const message = error instanceof Error ? error.message : String(error);
              writeHoldErr(dir, message);
              exitCode = 1;
            }
            await removeOwnStarting(dir);
            if (exitCode === 1) throw error;
            chrome = undefined;
          }
          if (chrome && (stopping.signal.aborted || sessions.count() === 0)) {
            chrome.detach();
            if (claimOwned(dir)) {
              markStopping(dir, sessions.port);
              await ownedOff(dir, root, axLog);
            }
            await removeOwnStarting(dir);
          } else if (chrome) {
            opening = false;
            const serving = serveHold(chrome, stopping.signal, { sessionPort: sessions.port });
            const reason = await Promise.race([
              watchSessions(sessions, chrome, stopping.signal, dir),
              serving.then(() => "leave" as const),
            ]);
            markStopping(dir, sessions.port);
            await unpublish(dir);
            if (reason === "turn-off" || claimOwned(dir)) await ownedOff(dir, root, axLog);
            stopping.abort();
            await serving.catch(() => undefined);
            await removeOwnStarting(dir);
          }
        }
      } finally {
        sessions.close();
      }
    }
  } finally {
    releaseOwnerLock();
  }
  process.exit(exitCode);
}

/** Next Bao start: a crash that skipped the off leaves the claim. The hold turns it off. This process does not. */
export async function settleDebugSwitch(): Promise<void> {
  if (testProcess()) return;
  if (process.platform !== "darwin") return;
  try {
    const { chromeProfilesRoot } = await import("../engines/chrome-profile-copy");
    const root = chromeDataPath(chromeProfilesRoot());
    const dir = holdDir(root);
    if (!claimOwned(dir)) return;
    if (await readLive(dir, root)) return;
    const starting = await readStarting(dir);
    if (starterReusable(starting, pidAlive) === "wait") return;
    const axLog = path.join(dir, "ax.jsonl");
    const { pid } = spawnHolder({ root, axLog, settle: true });
    const deadline = Date.now() + 30_000;
    while (pidAlive(pid) && Date.now() < deadline) {
      await sleep(100);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
