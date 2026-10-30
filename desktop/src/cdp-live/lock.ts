import { closeSync, constants, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

/** One browser socket at a time. Two agents otherwise race the Allow dialog. */
export const CDP_LOCK_PATH = "/tmp/bao-cdp-session.lock";
export const CDP_LOCK_STALE_MS = 20 * 60 * 1000;

export interface LockBody {
  agentId: string;
  startedAt: number;
  pid?: number;
  targetId?: string;
}

let heldLock: { agentId: string; file: string } | null = null;
let exitArmed = false;
const deadTargets: { file: string; targetId: string }[] = [];

function armExit(): void {
  if (exitArmed) return;
  exitArmed = true;
  process.on("exit", () => {
    if (!heldLock) return;
    const current = heldLock;
    heldLock = null;
    releaseCdpLock(current.agentId, current.file);
  });
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function rememberDead(file: string, targetId: string): void {
  const index = deadTargets.findIndex((item) => item.file === file);
  if (index >= 0) deadTargets.splice(index, 1);
  deadTargets.push({ file, targetId });
}

/** The page target a dead holder had opened, if the lock named one. */
export function takeDeadTarget(file = CDP_LOCK_PATH): string {
  const index = deadTargets.findIndex((item) => item.file === file);
  if (index < 0) return "";
  const targetId = deadTargets[index]?.targetId || "";
  deadTargets.splice(index, 1);
  return targetId;
}

export function lockText(agentId: string, startedAt: number, extra: { pid?: number; targetId?: string } = {}): string {
  const pid = extra.pid ?? process.pid;
  const lines = [`agent=${agentId}`, `startedAt=${startedAt}`, `pid=${pid}`];
  if (extra.targetId) lines.push(`targetId=${extra.targetId}`);
  return `${lines.join("\n")}\n`;
}

export function parseLock(text: string): LockBody | null {
  const keyedAgent = text.match(/^agent=(.+)$/m)?.[1]?.trim() || "";
  const keyedStart = Number(text.match(/^startedAt=(\d+)$/m)?.[1] || "");
  if (keyedAgent && Number.isFinite(keyedStart) && keyedStart > 0) {
    const pid = Number(text.match(/^pid=(\d+)$/m)?.[1] || "");
    const targetId = text.match(/^targetId=([\w.-]+)$/m)?.[1] || "";
    return {
      agentId: keyedAgent,
      startedAt: keyedStart,
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      targetId: targetId || undefined,
    };
  }
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const startedAt = Number(lines[1]);
  if (!lines[0] || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  return { agentId: lines[0], startedAt };
}

export function rememberLockTarget(agentId: string, targetId: string, file = CDP_LOCK_PATH): void {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const parsed = parseLock(text);
  if (!parsed || parsed.agentId !== agentId || !targetId) return;
  writeFileSync(file, lockText(agentId, parsed.startedAt, { pid: parsed.pid, targetId }));
}

export function lockIsStale(startedAt: number, now: number, staleMs = CDP_LOCK_STALE_MS): boolean {
  return now - startedAt > staleMs;
}

function fileIsStale(file: string, now: number, staleMs: number): boolean {
  try {
    const parsed = parseLock(readFileSync(file, "utf8"));
    if (parsed?.pid && !pidAlive(parsed.pid)) {
      if (parsed.targetId) rememberDead(file, parsed.targetId);
      return true;
    }
    if (parsed) return lockIsStale(parsed.startedAt, now, staleMs);
    return now - statSync(file).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export async function acquireCdpLock(
  agentId: string,
  opts: {
    file?: string;
    now?: () => number;
    timeoutMs?: number;
    staleMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const file = opts.file || CDP_LOCK_PATH;
  const now = opts.now || Date.now;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const staleMs = opts.staleMs ?? CDP_LOCK_STALE_MS;
  const sleep = opts.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, lockText(agentId, now()));
      } finally {
        closeSync(fd);
      }
      heldLock = { agentId, file };
      armExit();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (fileIsStale(file, now(), staleMs)) {
        try {
          unlinkSync(file);
        } catch {
          /* the other waiter removed it */
        }
        continue;
      }
    }
    if (now() >= deadline) break;
    await sleep(500);
  }
  throw new Error("cdp lock is held");
}

export function releaseCdpLock(agentId: string, file = CDP_LOCK_PATH): void {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const parsed = parseLock(text);
  if (!parsed || parsed.agentId !== agentId) return;
  if (parsed.pid && parsed.pid !== process.pid) return;
  if (heldLock && heldLock.file === file && heldLock.agentId === agentId) heldLock = null;
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
