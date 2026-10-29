// Process and artifact helpers for the macOS spike.
// Only apps this process launched are quit. Temp files it created are removed.

import { execFile } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export const CALC_BUNDLE = "com.apple.calculator";
export const EDIT_BUNDLE = "com.apple.TextEdit";
export const HELPER = process.env.BAO_OS_MACOS
  || path.resolve("desktop/os-helper-macos/BaoOSHelper.app");

export function artifactsDir(): string {
  const explicit = process.env.BAO_SPIKE_ARTIFACTS?.trim();
  if (explicit) return explicit;
  const store = process.env.BAO_AGENT_STORE_DIR?.trim();
  if (store) return path.join(store, "bao-mac-spike");
  throw new Error("Set BAO_SPIKE_ARTIFACTS or BAO_AGENT_STORE_DIR");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BIN = {
  pgrep: "/usr/bin/pgrep",
  open: "/usr/bin/open",
  kill: "/bin/kill",
  screencapture: "/usr/sbin/screencapture",
};

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function pidsOf(name: string): Promise<number[]> {
  const { code, stdout } = await exec(BIN.pgrep, ["-x", name]);
  if (code !== 0) return [];
  return stdout.split("\n").map((s) => Number(s.trim())).filter((n) => n > 0);
}

/** Launch only when the app is not already running. Returns the pid we own. */
export async function launchIfDown(app: string, processName: string): Promise<number | null> {
  const before = await pidsOf(processName);
  if (before.length > 0) return null;
  const opened = await exec(BIN.open, ["-a", app]);
  if (opened.code !== 0) throw new Error(`open -a ${app} failed: ${opened.stderr}`);
  for (let i = 0; i < 40; i++) {
    const now = await pidsOf(processName);
    const owned = now.find((pid) => !before.includes(pid));
    if (owned) return owned;
    await sleep(250);
  }
  throw new Error(`${app} did not start`);
}

export async function quitOwned(pid: number | null, processName: string): Promise<void> {
  if (pid == null) return;
  const live = await pidsOf(processName);
  if (!live.includes(pid)) return;
  await exec(BIN.kill, [String(pid)]);
  for (let i = 0; i < 20; i++) {
    if (!(await pidsOf(processName)).includes(pid)) return;
    await sleep(150);
  }
  await exec(BIN.kill, ["-KILL", String(pid)]);
  for (let i = 0; i < 20; i++) {
    if (!(await pidsOf(processName)).includes(pid)) return;
    await sleep(150);
  }
}

/** A rectangle in screen points. This is not a full-screen grab. */
export async function captureRegion(x: number, y: number, w: number, h: number, out: string): Promise<void> {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.max(40, Math.min(220, Math.round(w)));
  const rh = Math.max(40, Math.min(160, Math.round(h)));
  const shot = await exec(BIN.screencapture, ["-R", `${rx},${ry},${rw},${rh}`, "-o", "-x", out]);
  if (shot.code !== 0) throw new Error(shot.stderr || "region capture failed");
}

export async function namesIn(dir: string): Promise<Set<string>> {
  if (process.env.BAO_SKIP_AUTOSAVE === "1") return new Set();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("readdir timed out")), 4000);
      readdir(dir).then(
        (names) => { clearTimeout(timer); resolve(new Set(names)); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  } catch {
    return new Set();
  }
}

export const TEXTEDIT_AUTOSAVE = path.join(
  homedir(),
  "Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information",
);

/** Delete only new Untitled autosave files this run created. */
export async function cleanupNewAutosave(before: Set<string>): Promise<string[]> {
  const now = await namesIn(TEXTEDIT_AUTOSAVE);
  const removed: string[] = [];
  for (const name of now) {
    if (before.has(name)) continue;
    if (!/untitled/i.test(name)) continue;
    await rm(path.join(TEXTEDIT_AUTOSAVE, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function ensureArtifacts(): Promise<void> {
  await mkdir(artifactsDir(), { recursive: true });
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const file = path.join(artifactsDir(), name);
  await writeFile(file, JSON.stringify(value, null, 2));
  return file;
}

export function workDir(): string {
  return path.join(tmpdir(), `bao-mac-spike-${process.pid}`);
}
