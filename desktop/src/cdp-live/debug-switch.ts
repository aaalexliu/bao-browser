// Whether Bao turned Chrome's remote-debugging switch on, and which sessions still use it.
// The files live in the chrome-hold directory for that user-data-dir, so every Bao process
// sees the same claim. Bao turns the switch off only when it owns the claim and no live lease remains.

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

const CLAIM = "switch.json";
const LEASES = "leases";
const LOCK = "switch.lock";
const LOCK_WAIT_MS = 120_000;

export interface SwitchClaim {
  /** True when Bao turned the switch on and has not turned it off since. */
  owned: boolean;
}

export interface SwitchLease {
  release(): void;
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

function unlinkIfSymlink(file: string): boolean {
  try {
    if (!lstatSync(file).isSymbolicLink()) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function readText(file: string): string | undefined {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  } catch {
    return undefined;
  }
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); }
  finally { closeSync(fd); }
  renameSync(tmp, file);
}

export function readClaim(dir: string): SwitchClaim | undefined {
  const text = readText(path.join(dir, CLAIM));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { owned?: unknown };
    if (typeof parsed.owned !== "boolean") return undefined;
    return { owned: parsed.owned };
  } catch {
    return undefined;
  }
}

/** Bao just enabled the switch, or found it already on. An already-on port does not clear a claim Bao still owns. */
export function rememberSwitch(dir: string, enabledByBao: boolean): void {
  const previous = readClaim(dir);
  const owned = enabledByBao || previous?.owned === true;
  writePrivate(path.join(dir, CLAIM), JSON.stringify({ owned }));
}

function leasePid(file: string): number | undefined {
  const name = path.basename(file);
  const pid = Number(name.split(".")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function leaseFiles(dir: string): string[] {
  const leases = path.join(dir, LEASES);
  try { return readdirSync(leases).map((name) => path.join(leases, name)); }
  catch { return []; }
}

/** Drops lease files whose process is gone. A crash, a quit, or a killed session leaves one of these. */
export function reapDeadLeases(dir: string, alive: (pid: number) => boolean = pidAlive): void {
  for (const file of leaseFiles(dir)) {
    const pid = leasePid(file);
    if (pid === undefined || alive(pid)) continue;
    try { unlinkSync(file); } catch { /* already released */ }
  }
}

export function liveLeaseCount(dir: string, alive: (pid: number) => boolean = pidAlive): number {
  reapDeadLeases(dir, alive);
  return leaseFiles(dir).filter((file) => {
    const pid = leasePid(file);
    return pid !== undefined && alive(pid);
  }).length;
}

let leaseNonce = 0;

/** One session using the switch. Release it when that session ends. */
export function takeLease(dir: string, pid = process.pid): SwitchLease {
  const leases = path.join(dir, LEASES);
  mkdirSync(leases, { recursive: true, mode: 0o700 });
  leaseNonce += 1;
  const file = path.join(leases, `${pid}.${Date.now()}.${leaseNonce}`);
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try { unlinkSync(file); } catch { /* already reaped */ }
    },
  };
}

function deadLockPid(file: string): boolean {
  const text = readText(file)?.trim() ?? "";
  if (!/^[1-9]\d{0,9}$/.test(text)) return false;
  return !pidAlive(Number(text));
}

function releaseLock(file: string): void {
  const done = `${file}.done.${process.pid}.${Date.now()}`;
  try {
    renameSync(file, done);
    unlinkSync(done);
  } catch { /* already released */ }
}

/** Serializes a switch change. The off and the next on must not overlap. */
export async function withSwitchLock<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const file = path.join(dir, LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" && unlinkIfSymlink(file)) continue;
      if (code !== "EEXIST") throw error;
      if (deadLockPid(file)) {
        try { unlinkSync(file); } catch { /* the owner released it */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Bao is still changing Chrome's debugging switch");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      fd = undefined;
      return await body();
    } finally {
      if (fd !== undefined) closeSync(fd);
      releaseLock(file);
    }
  }
}

/**
 * Turns the switch off when Bao owns it and no live session remains.
 * A live holder does this itself; another process leaves that holder to do it.
 * A failed off keeps the claim so the next start can try again.
 */
export async function turnOffIfIdle(dir: string, turnOff: () => Promise<void>, opts?: { holderAlive?: boolean }): Promise<boolean> {
  if (opts?.holderAlive) return false;
  if (!existsSync(path.join(dir, CLAIM))) return false;
  return withSwitchLock(dir, async () => {
    if (!existsSync(path.join(dir, CLAIM))) return false;
    const claim = readClaim(dir);
    if (!claim?.owned) return false;
    if (liveLeaseCount(dir) > 0) return false;
    try { await turnOff(); }
    catch { return false; }
    if (liveLeaseCount(dir) > 0) return false;
    try { unlinkSync(path.join(dir, CLAIM)); } catch { /* already cleared */ }
    return true;
  });
}

export function testProcess(): boolean {
  return process.env.BAO_LANE === "hermetic" || process.env.BAO_LANE === "live" || process.env.BAO_TEST_BROWSER !== undefined || process.env.BAO_LIVE_TESTS === "1";
}

/** The helper uncheck. Tests never call this. */
export async function productionTurnOff(portFile: string, axLog: string): Promise<void> {
  if (process.platform !== "darwin") return;
  if (testProcess()) throw new Error("tests never change Chrome's debugging switch");
  const { setRemoteDebugging, remoteDebuggingDeps } = await import("./remote-debugging");
  const { chromeHelper } = await import("./ax");
  await setRemoteDebugging(false, remoteDebuggingDeps(chromeHelper(), portFile, axLog));
}
