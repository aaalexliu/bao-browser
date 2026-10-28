import { closeSync, constants, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";

/** One browser socket at a time. Two agents otherwise race the Allow dialog. */
export const CDP_LOCK_PATH = "/tmp/bao-cdp-session.lock";
export const CDP_LOCK_STALE_MS = 20 * 60 * 1000;

export function lockText(agentId: string, startedAt: number): string {
  return `${agentId}\n${startedAt}\n`;
}

export function parseLock(text: string): { agentId: string; startedAt: number } | null {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const startedAt = Number(lines[1]);
  if (!lines[0] || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  return { agentId: lines[0], startedAt };
}

export function lockIsStale(startedAt: number, now: number, staleMs = CDP_LOCK_STALE_MS): boolean {
  return now - startedAt > staleMs;
}

function fileIsStale(file: string, now: number, staleMs: number): boolean {
  try {
    const parsed = parseLock(readFileSync(file, "utf8"));
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
  while (now() <= deadline) {
    try {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, lockText(agentId, now()));
      } finally {
        closeSync(fd);
      }
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
      await sleep(500);
    }
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
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}
