// A host stop exits after 15 seconds. libx264 can still be running, and a child of
// the exiting process would die with it, so the encode runs here, detached.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const HOST_STOP_VIDEO_UNAVAILABLE = "Bao stopped before the video finished";

export interface VideoHandoffSpec {
  destination: string;
  framesDir: string;
  ffmpeg: string;
  ffmpegArgs: string[];
  deadline: number;
  parentPid: number;
  truncated: boolean;
  runFile?: string;
  videoName?: string;
  startedAt?: number;
}

export interface VideoHandoffResult {
  wrote: boolean;
  code: number | null;
  signal: string | null;
}

export function handoffPaths(destination: string): { spec: string; released: string; result: string } {
  return {
    spec: `${destination}.handoff.json`,
    released: `${destination}.released`,
    result: `${destination}.result.json`,
  };
}

function parentGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSpec(specPath: string): VideoHandoffSpec | undefined {
  try { return JSON.parse(readFileSync(specPath, "utf8")) as VideoHandoffSpec; }
  catch { return undefined; }
}

function fileOk(file: string): boolean {
  try { return statSync(file).size >= 1000; }
  catch { return false; }
}

function writeResult(destination: string, result: VideoHandoffResult): void {
  writeFileSync(handoffPaths(destination).result, JSON.stringify(result), { mode: 0o600 });
}

function dropFrames(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); }
  catch { /* the next Bao start sweeps a claimed video's frames */ }
}

function framesVideoName(name: string): string | undefined {
  const mark = ".mp4.frames-";
  const at = name.indexOf(mark);
  if (at <= 0) return undefined;
  return name.slice(0, at + ".mp4".length);
}

/** Removes frames directories whose run already names that MP4. Never deletes an MP4. */
export function sweepClaimedVideoFrames(home: string): void {
  const videos = path.join(home, "videos");
  let names: string[];
  try { names = readdirSync(videos); }
  catch { return; }
  for (const name of names) {
    const videoName = framesVideoName(name);
    if (!videoName) continue;
    const dir = path.join(videos, name);
    try { if (!lstatSync(dir).isDirectory()) continue; }
    catch { continue; }
    const runId = videoName.slice(0, -".mp4".length);
    let video: unknown;
    try { video = (JSON.parse(readFileSync(path.join(home, "runs", `${runId}.json`), "utf8")) as { video?: unknown }).video; }
    catch { continue; }
    if (video !== videoName) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { /* a later start tries again */ }
  }
}

function attach(spec: VideoHandoffSpec, wrote: boolean): void {
  if (!spec.runFile || !spec.videoName || spec.startedAt === undefined) return;
  const run = JSON.parse(readFileSync(spec.runFile, "utf8")) as Record<string, unknown>;
  if (wrote && fileOk(spec.destination)) {
    run.video = spec.videoName;
    run.videoStartedAt = spec.startedAt;
    run.videoTruncated = spec.truncated;
    delete run.videoUnavailable;
  } else {
    delete run.video;
    delete run.videoStartedAt;
    delete run.videoTruncated;
    run.videoUnavailable = HOST_STOP_VIDEO_UNAVAILABLE;
    rmSync(spec.destination, { force: true });
  }
  const temporary = `${spec.runFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(run, null, 2));
  renameSync(temporary, spec.runFile);
  rmSync(spec.framesDir, { recursive: true, force: true });
  const paths = handoffPaths(spec.destination);
  rmSync(paths.spec, { force: true });
  rmSync(paths.released, { force: true });
  rmSync(paths.result, { force: true });
}

function exitSupervisor(code: number, framesDir: string, wrote: boolean): void {
  if (wrote) dropFrames(framesDir);
  process.exit(code);
}

async function finish(specPath: string, wrote: boolean, framesDir: string): Promise<void> {
  const opened = readSpec(specPath);
  // A host stop can exit this process during the release wait. The MP4 is already written.
  if (wrote) dropFrames(framesDir);
  if (!opened) { exitSupervisor(wrote ? 0 : 1, framesDir, wrote); return; }
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    const spec = readSpec(specPath) ?? opened;
    const released = existsSync(handoffPaths(spec.destination).released);
    if (!released && !parentGone(spec.parentPid)) { await delay(50); continue; }
    if (released && !parentGone(spec.parentPid)) await delay(50);
    const latest = readSpec(specPath) ?? spec;
    try { if (latest.runFile) attach(latest, wrote); }
    catch { /* the run directory is already gone */ }
    exitSupervisor(0, framesDir, wrote);
  }
  exitSupervisor(wrote ? 0 : 1, framesDir, wrote);
}

/** Runs as its own process. The parent exits on the host-stop cap; this one does not. */
export function finishHandedOffVideo(specPath: string): void {
  const spec = readSpec(specPath);
  if (!spec) { process.exit(1); return; }
  const child = spawn(spec.ffmpeg, spec.ffmpegArgs, { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, Math.max(0, spec.deadline - Date.now()));
  const done = (code: number | null, signal: NodeJS.Signals | null): void => {
    clearTimeout(timer);
    const wrote = code === 0 && fileOk(spec.destination);
    writeResult(spec.destination, { wrote, code, signal });
    void finish(specPath, wrote, spec.framesDir);
  };
  child.once("error", () => done(null, null));
  child.once("exit", (code, signal) => done(code, signal));
}

if (require.main === module) finishHandedOffVideo(process.argv[2] ?? "");
