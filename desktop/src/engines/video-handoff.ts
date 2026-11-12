// A host stop exits after 15 seconds. libx264 can still be running, and a child of
// the exiting process would die with it, so the encode runs here, detached.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

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

async function finish(specPath: string, wrote: boolean): Promise<void> {
  const opened = readSpec(specPath);
  if (!opened) { process.exit(wrote ? 0 : 1); return; }
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    const spec = readSpec(specPath) ?? opened;
    const released = existsSync(handoffPaths(spec.destination).released);
    if (!released && !parentGone(spec.parentPid)) { await delay(50); continue; }
    if (released && !parentGone(spec.parentPid)) await delay(50);
    const latest = readSpec(specPath) ?? spec;
    try { if (latest.runFile) attach(latest, wrote); }
    catch { /* the run directory is already gone */ }
    process.exit(0);
  }
  process.exit(wrote ? 0 : 1);
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
    void finish(specPath, wrote);
  };
  child.once("error", () => done(null, null));
  child.once("exit", (code, signal) => done(code, signal));
}

if (require.main === module) finishHandedOffVideo(process.argv[2] ?? "");
