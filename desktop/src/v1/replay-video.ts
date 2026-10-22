// Headed macOS replays record the one window they are driving.
// The grabber is ScreenCaptureKit's desktop-independent window filter.
// A false preflight returns without calling SCShareableContent.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function shouldRecordOwnedWindow(platform: NodeJS.Platform, headed: boolean): boolean {
  return platform === "darwin" && headed;
}

export function bundledWindowVideoApp(): string | undefined {
  const fromEnv = process.env.BAO_WINDOW_VIDEO;
  if (fromEnv && existsSync(path.join(fromEnv, "Contents", "MacOS", "bao-window-video"))) return fromEnv;
  const candidates = [
    path.resolve(process.cwd(), "..", "BaoWindowVideo.app"),
    path.resolve(process.cwd(), "desktop/packaging/macos/dist/BaoWindowVideo.app"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "Contents", "MacOS", "bao-window-video")));
}

export interface ReplayVideo {
  stop(): Promise<{ wrote: boolean; frames: number }>;
}

const noop: ReplayVideo = { async stop() { return { wrote: false, frames: 0 }; } };

let screenOk: boolean | undefined;

export async function openReplayVideo(pids: number[], dest: string): Promise<ReplayVideo> {
  const ids = pids.filter((pid) => pid > 0);
  if (!shouldRecordOwnedWindow(process.platform, process.env.BAO_HEADED === "1") || ids.length === 0) return noop;
  return startReplayVideo(ids, dest);
}

/** Computer-use replays are on screen even when the product window is not headed. */
export async function openOsReplayVideo(pid: number, dest: string): Promise<ReplayVideo> {
  if (process.platform !== "darwin" || process.env.BAO_REPLAY_VIDEO === "0" || !(pid > 0)) return noop;
  return startReplayVideo([pid], dest);
}

async function startReplayVideo(pids: number[], dest: string): Promise<ReplayVideo> {
  const app = bundledWindowVideoApp();
  if (!app) return noop;
  if (screenOk === false) return noop;
  const dir = await mkdtemp(path.join(tmpdir(), "bao-winvideo-"));
  try {
    if (screenOk !== true) {
      const probe = await runOnce(app, ["probe", "--result", path.join(dir, "probe.json")]);
      screenOk = probe.screenCapture === true && probe.ok === true;
      if (!screenOk) return noop;
    }
    mkdirSync(dir, { recursive: true });
    spawn("/usr/bin/open", [
      "-n", "-g", "-a", app,
      "--args", "record", "--pid", pids.join(","), "--dir", dir,
    ], { stdio: "ignore" });
    const ready = Date.now() + 4000;
    while (Date.now() < ready && !existsSync(path.join(dir, "frame-0001.png"))) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return noop;
  }
  return {
    async stop() {
      // Replay has returned, so the page is already on the result. Wait
      // until a frame is written after that, then stop. The last frame is
      // the welcome and the dropped file, not the fixture's first paint.
      const after = Date.now();
      const settleBy = after + 5000;
      while (Date.now() < settleBy && newestFrameMtime(dir) < after + 700) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      writeFileSync(path.join(dir, "stop"), "1");
      const status = await waitStatus(dir);
      const frames = Number(status?.frames || 0);
      let wrote = false;
      if (frames > 0) wrote = await encodeWebm(dir, frames, dest);
      const pid = readPid(dir);
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return { wrote, frames };
    },
  };
}

function readPid(dir: string): number {
  try {
    const pid = Number(readFileSync(path.join(dir, "pid"), "utf8").trim());
    return pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

async function waitStatus(dir: string): Promise<{ frames?: number } | undefined> {
  const file = path.join(dir, "status.json");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, "utf8")) as { frames?: number }; } catch { /* partial write */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return undefined;
}

function ffmpegBin(): string | undefined {
  const fromEnv = process.env.FFMPEG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const found = spawnSync("/usr/bin/which", ["ffmpeg"], { encoding: "utf8" });
  const line = (found.stdout || "").trim();
  if (found.status === 0 && line) return line;
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function encodeWebm(dir: string, frames: number, dest: string): Promise<boolean> {
  const bin = ffmpegBin();
  if (!bin) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  const rate = frames >= 8 ? "8" : "4";
  const result = spawnSync(bin, [
    "-y", "-framerate", rate,
    "-i", path.join(dir, "frame-%04d.png"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
    "-c:v", "libvpx", "-b:v", "1M", "-an",
    dest,
  ], { encoding: "utf8" });
  const wrote = result.status === 0 && existsSync(dest) && statSync(dest).size > 1000;
  if (wrote) {
    const last = path.join(dir, `frame-${String(frames).padStart(4, "0")}.png`);
    if (existsSync(last)) copyFileSync(last, dest.replace(/\.webm$/, ".png"));
  }
  return wrote;
}

function newestFrameMtime(dir: string): number {
  let latest = 0;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!/^frame-\d+\.png$/.test(name)) continue;
    try {
      const mtime = statSync(path.join(dir, name)).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch { /* raced with the recorder */ }
  }
  return latest;
}

function runOnce(app: string, args: string[]): Promise<{ ok?: boolean; screenCapture?: boolean }> {
  const result = args.includes("--result") ? args[args.indexOf("--result") + 1] : "";
  const dir = result ? path.dirname(result) : tmpdir();
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/open", [
      "-n", "-W", "-g", "-a", app,
      "--stdout", path.join(dir, "out.json"),
      "--stderr", path.join(dir, "err.txt"),
      "--args", ...args,
    ], { stdio: "ignore" });
    const started = Date.now();
    const timer = setInterval(() => {
      const parsed = readResult(result);
      if (parsed.ok !== undefined || parsed.screenCapture !== undefined || Date.now() - started > 15000) {
        clearInterval(timer);
        child.kill("SIGKILL");
        resolve(parsed.screenCapture === undefined ? readResult(path.join(dir, "out.json")) : parsed);
      }
    }, 80);
  });
}

function readResult(file: string): { ok?: boolean; screenCapture?: boolean } {
  if (!file) return {};
  try { return JSON.parse(readFileSync(file, "utf8")) as { ok?: boolean; screenCapture?: boolean }; } catch { return {}; }
}
