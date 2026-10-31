import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CdpSocket } from "../cdp-live/socket";
import { ffmpegBin } from "../v1/replay-video";

export interface CdpVideo {
  pause(): void;
  resume(): void;
  stop(): Promise<{ wrote: boolean; frames: number }>;
}

/** Records only the run's page. No OS screenshot or Screen Recording permission is used. */
export async function startCdpVideo(cdp: CdpSocket, sessionId: string, destination: string): Promise<CdpVideo> {
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) throw new Error("CDP video needs ffmpeg; the run has not started");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const dir = await mkdtemp("/tmp/bao-cdp-video-");
  await chmod(dir, 0o700);
  const frames: { file: string; at: number }[] = [];
  let active = true;
  let paused = false;
  let writing = false;
  let failure: Error | undefined;
  let pending = Promise.resolve();
  let last = 0;
  let bytes = 0;
  cdp.on("Page.screencastFrame", sessionId, (params) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => undefined);
    if (!active || paused || writing || Date.now() - last < 150) return;
    if (typeof params.data !== "string") { failure = new Error("CDP video frame was invalid"); return; }
    const data = Buffer.from(params.data, "base64");
    bytes += data.length;
    if (frames.length >= 6000 || bytes > 512 * 1024 * 1024) { failure = new Error("CDP video exceeded its capture limit"); active = false; return; }
    const file = path.join(dir, `frame-${String(frames.length).padStart(6, "0")}.jpg`);
    last = Date.now();
    frames.push({ file, at: last });
    writing = true;
    pending = writeFile(file, data, { mode: 0o600 }).catch(() => { failure = new Error("CDP video frame could not be saved"); }).finally(() => { writing = false; });
  });
  try {
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, sessionId);
  } catch (error) { active = false; await rm(dir, { recursive: true, force: true }); throw error; }
  let stopping: Promise<{ wrote: boolean; frames: number }> | undefined;
  return {
    pause() { paused = true; },
    resume() { paused = false; },
    stop() {
      stopping ??= (async () => {
        active = false;
        await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
        await pending;
        try {
          if (failure) throw failure;
          if (!frames.length) throw new Error("CDP video recorded no frames");
          const list = frames.map((frame, index) => {
            const next = frames[index + 1]?.at ?? Date.now();
            return `file '${frame.file}'\nduration ${Math.max(0.04, (next - frame.at) / 1000).toFixed(3)}`;
          }).join("\n") + `\nfile '${frames[frames.length - 1]!.file}'\n`;
          const manifest = path.join(dir, "frames.txt");
          await writeFile(manifest, list, { mode: 0o600 });
          const mp4 = path.extname(destination) === ".mp4";
          await new Promise<void>((resolve, reject) => {
            const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifest,
              "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "vfr", "-c:v", mp4 ? "libx264" : "libvpx-vp9",
              ...(mp4 ? ["-preset", "fast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"] : ["-deadline", "realtime", "-cpu-used", "5"]), destination], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
            const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CDP video encoding timed out")); }, 120_000);
            child.once("error", () => { clearTimeout(timer); reject(new Error("CDP video encoder did not start")); });
            child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("CDP video encoding failed")); });
          });
          if ((await stat(destination)).size < 1000) throw new Error("CDP video output was empty");
          return { wrote: true, frames: frames.length };
        } finally { await rm(dir, { recursive: true, force: true }); }
      })();
      return stopping;
    },
  };
}
