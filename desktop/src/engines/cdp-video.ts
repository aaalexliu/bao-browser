import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CdpSocket } from "../cdp-live/socket";
import { ffmpegBin } from "../v1/replay-video";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

async function veilFrame(ffmpeg: string, data: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-max_pixels", "2073600", "-i", "pipe:0",
      "-vf", "gblur=sigma=18,lutrgb=r=val*0.18+245*0.82:g=val*0.18+245*0.82:b=val*0.18+247*0.82",
      "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"],
    { encoding: "buffer", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: MAX_FRAME_BYTES, env: { PATH: "/usr/bin:/bin" } }, (error, output) => {
      if (error || output.length < 4 || output.readUInt16BE(0) !== 0xffd8 || output.readUInt16BE(output.length - 2) !== 0xffd9) {
        reject(new Error("CDP video frame could not be veiled"));
      } else resolve(output);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(data);
  });
}

export interface CdpVideo {
  pause(): void;
  resume(): void;
  endCapture(): Promise<void>;
  stop(): Promise<{ wrote: boolean; frames: number; truncated: boolean }>;
}

/** Records only the run's page. No OS screenshot or Screen Recording permission is used. */
export async function startCdpVideo(cdp: CdpSocket, sessionId: string, destination: string, opts: { noBlur?: true } = {}): Promise<CdpVideo> {
  const ffmpeg = ffmpegBin();
  if (!ffmpeg) throw new Error("CDP video needs ffmpeg; the run has not started");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const mp4 = path.extname(destination) === ".mp4";
  const dir = await mkdtemp(mp4 ? `${destination}.frames-` : "/tmp/bao-cdp-video-");
  await chmod(dir, 0o700);
  const frames: { file: string; at: number }[] = [];
  let active = true;
  let pauses = 0;
  let writing = false;
  let truncated = false;
  let failure: Error | undefined;
  let pending = Promise.resolve();
  let last = 0;
  let bytes = 0;
  let stopping: ReturnType<CdpVideo["stop"]> | undefined;
  let endedAt = 0;
  let ending: Promise<void> | undefined;
  let finalFrame: (() => void) | undefined;
  const startCapture = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, sessionId);
  const endCapture = (): Promise<void> => {
    ending ??= (async () => {
      active = false;
      await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
      await pending;
      if (pauses === 0 && !failure && !truncated) {
        // Let the last action paint before requesting a fresh screencast frame.
        // A short or static page may not send another sample on its own.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await cdp.send("Runtime.evaluate", {
            expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
            awaitPromise: true,
          }, sessionId, 5000);
          active = true;
          last = 0;
          const captured = new Promise<void>((resolve, reject) => {
            finalFrame = resolve;
            timer = setTimeout(() => reject(new Error("CDP video final frame timed out")), 5000);
          });
          await Promise.all([startCapture(), captured]);
        }
        catch (error) { failure ??= error instanceof Error ? error : new Error("CDP video final frame failed"); }
        finally {
          clearTimeout(timer);
          finalFrame = undefined;
          active = false;
          await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
        }
      }
      endedAt = Date.now();
      await pending;
    })();
    return ending;
  };
  const stop = (): ReturnType<CdpVideo["stop"]> => {
    stopping ??= (async () => {
      await endCapture();
      let keepFrames = false;
      try {
        if (failure) throw failure;
        if (!frames.length) throw new Error("CDP video recorded no frames");
        keepFrames = mp4;
        let duration = 40;
        const entry = (file: string) => mp4 ? `file '${path.basename(file)}'\noption framerate 1000` : `file '${file}'`;
        const list = frames.map((frame, index) => {
          const span = Math.max(40, (frames[index + 1]?.at ?? endedAt) - frame.at);
          duration += span;
          return `${entry(frame.file)}\nduration ${(span / 1000).toFixed(3)}`;
        }).join("\n") + `\n${entry(frames[frames.length - 1]!.file)}\n${mp4 ? "duration 0.040\n" : ""}`;
        const manifest = path.join(dir, "frames.txt");
        await writeFile(manifest, list, { mode: 0o600 });
        const encoding = mp4 ? [
          "-t", (duration / 1000).toFixed(3),
          "-vf", "fps=30:round=up,scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
          "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "fast",
          "-profile:v", "main", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-bf", "0", "-maxrate", "20M", "-bufsize", "25M",
          "-color_range", "tv", "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", "-movflags", "+faststart",
        ] : [
          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "vfr", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "5",
        ];
        await new Promise<void>((resolve, reject) => {
          const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifest, ...encoding, destination],
            { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
          const timer = setTimeout(() => { child.kill("SIGKILL"); }, mp4 ? 120_000 + duration * 2 : 120_000);
          child.once("error", () => { clearTimeout(timer); reject(new Error("CDP video encoder did not start")); });
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(signal === "SIGKILL" ? "CDP video encoding timed out" : "CDP video encoding failed"));
          });
        });
        if ((await stat(destination)).size < 1000) throw new Error("CDP video output was empty");
        keepFrames = false;
        return { wrote: true, frames: frames.length, truncated };
      } catch (error) {
        await rm(destination, { force: true });
        if (keepFrames) throw new Error(`${error instanceof Error ? error.message : "CDP video encoding failed"}; video frames retained at ${dir}`);
        throw error;
      } finally { if (!keepFrames) await rm(dir, { recursive: true, force: true }); }
    })();
    return stopping;
  };
  cdp.on("Page.screencastFrame", sessionId, (params) => {
    void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => undefined);
    if (!active || pauses > 0 || writing || Date.now() - last < 150) return;
    const data = typeof params.data === "string" && params.data.length <= Math.ceil(MAX_FRAME_BYTES / 3) * 4 ? Buffer.from(params.data, "base64") : undefined;
    if (!data || data.length > MAX_FRAME_BYTES) {
      failure = new Error("CDP video frame was invalid or too large");
      void stop().catch(() => undefined);
      return;
    }
    if (bytes + data.length > MAX_VIDEO_BYTES) {
      truncated = true;
      void stop().catch(() => undefined);
      return;
    }
    bytes += data.length;
    const file = path.join(dir, `frame-${String(frames.length).padStart(6, "0")}.jpg`);
    last = Date.now();
    frames.push({ file, at: last });
    writing = true;
    pending = (opts.noBlur ? Promise.resolve(data) : veilFrame(ffmpeg, data)).then(async (veiled) => {
      const extra = Math.max(0, veiled.length - data.length);
      if (bytes + extra > MAX_VIDEO_BYTES) {
        frames.pop();
        truncated = true;
        void stop().catch(() => undefined);
        return;
      }
      bytes += extra;
      await writeFile(file, veiled, { mode: 0o600 });
    }).catch(() => {
      failure = new Error("CDP video frame could not be veiled or saved");
      void stop().catch(() => undefined);
    }).finally(() => { writing = false; });
    finalFrame?.();
    if (frames.length >= 6000) {
      truncated = true;
      void stop().catch(() => undefined);
    }
  });
  try {
    await startCapture();
  } catch (error) { active = false; await pending; await rm(dir, { recursive: true, force: true }); throw error; }
  return {
    pause() { pauses += 1; },
    resume() { pauses = Math.max(0, pauses - 1); },
    endCapture,
    stop,
  };
}
