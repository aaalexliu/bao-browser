import { execFile, spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CdpSocket } from "../cdp-live/socket";
import { ffmpegBin } from "../v1/replay-video";
import { handoffPaths, type VideoHandoffResult, type VideoHandoffSpec } from "./video-handoff";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

// Tests set BAO_CDP_VIDEO_MAX_BYTES and BAO_CDP_VIDEO_MAX_FRAMES. A normal session leaves both unset.
function videoByteLimit(): number {
  const raw = process.env.BAO_CDP_VIDEO_MAX_BYTES;
  if (!raw) return MAX_VIDEO_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : MAX_VIDEO_BYTES;
}

function videoFrameLimit(): number {
  const raw = process.env.BAO_CDP_VIDEO_MAX_FRAMES;
  if (!raw) return 6000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 6000;
}

function killEncoderGroup(child: ReturnType<typeof spawn> | undefined): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}

export interface VideoEncodeOwner {
  runFile: string;
  videoName: string;
  startedAt: number;
}

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
  switchSession(sessionId: string): Promise<void>;
  stop(): Promise<{ wrote: boolean; frames: number; truncated: boolean }>;
  abandonEncode(): void;
  /** finished: the MP4 is already on disk. released: a detached encode will attach it after this process exits. */
  releaseEncode(owner: VideoEncodeOwner): { kind: "finished"; truncated: boolean } | { kind: "released" } | { kind: "none" };
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
  let encoder: ReturnType<typeof spawn> | undefined;
  let encodeTimer: ReturnType<typeof setTimeout> | undefined;
  let encoded = false;
  let releasedEncode = false;
  let releaseWaiter: (() => void) | undefined;
  const maxBytes = videoByteLimit();
  const maxFrames = videoFrameLimit();
  const paths = handoffPaths(destination);
  const encodeBudget = (duration: number): number => mp4 ? 120_000 + duration * 2 : 120_000;
  const clearHandoff = (): void => {
    rmSync(paths.spec, { force: true });
    rmSync(paths.result, { force: true });
    rmSync(paths.released, { force: true });
  };
  const readResult = (): VideoHandoffResult | undefined => {
    try { return JSON.parse(readFileSync(paths.result, "utf8")) as VideoHandoffResult; }
    catch { return undefined; }
  };
  const fileReady = (): boolean => {
    try { return statSync(destination).size >= 1000; } catch { return false; }
  };
  const publishSpec = (spec: VideoHandoffSpec): void => {
    const temporary = `${paths.spec}.tmp`;
    writeFileSync(temporary, JSON.stringify(spec), { mode: 0o600 });
    renameSync(temporary, paths.spec);
  };
  const writeOwner = (owner: VideoEncodeOwner): void => {
    const spec = JSON.parse(readFileSync(paths.spec, "utf8")) as VideoHandoffSpec;
    publishSpec({ ...spec, ...owner, truncated });
  };
  const readyFrames = (): { file: string; at: number }[] => frames.filter((frame) => {
    try { return statSync(frame.file).size > 0; } catch { return false; }
  });
  const startSupervisor = (owner?: VideoEncodeOwner): boolean => {
    if (encoder) {
      if (owner) writeOwner(owner);
      return true;
    }
    const ready = readyFrames();
    if (!ready.length) return false;
    let duration = 40;
    const end = endedAt || Date.now();
    const entry = (file: string) => `file '${path.basename(file)}'\noption framerate 1000`;
    const list = ready.map((frame, index) => {
      const span = Math.max(40, (ready[index + 1]?.at ?? end) - frame.at);
      duration += span;
      return `${entry(frame.file)}\nduration ${(span / 1000).toFixed(3)}`;
    }).join("\n") + `\n${entry(ready[ready.length - 1]!.file)}\nduration 0.040\n`;
    const manifest = path.join(dir, "frames.txt");
    writeFileSync(manifest, list, { mode: 0o600 });
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifest,
      "-t", (duration / 1000).toFixed(3),
      "-vf", "fps=30:round=up,scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      "-fps_mode", "cfr", "-c:v", "libx264", "-preset", "fast",
      "-profile:v", "main", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-bf", "0", "-maxrate", "20M", "-bufsize", "25M",
      "-color_range", "tv", "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", "-movflags", "+faststart",
      destination];
    const spec: VideoHandoffSpec = {
      destination, framesDir: dir, ffmpeg, ffmpegArgs: args, deadline: Date.now() + encodeBudget(duration),
      parentPid: process.pid, truncated, ...owner,
    };
    publishSpec(spec);
    // Detached so a process-group signal and process.exit leave the encode running.
    encoder = spawn(process.execPath, [path.join(__dirname, "video-handoff.js"), paths.spec], { detached: true, stdio: "ignore" });
    encoder.unref();
    encodeTimer = setTimeout(() => killEncoderGroup(encoder), encodeBudget(duration));
    return true;
  };
  const abandonEncode = (): void => {
    if (encoded || releasedEncode) return;
    encoded = true;
    if (encodeTimer) clearTimeout(encodeTimer);
    if (!mp4 && encoder && encoder.exitCode === null && encoder.signalCode === null) {
      try { encoder.kill("SIGKILL"); } catch { /* already gone */ }
    } else killEncoderGroup(encoder);
    rmSync(destination, { force: true });
    rmSync(dir, { recursive: true, force: true });
  };
  const releaseEncode = (owner: VideoEncodeOwner): { kind: "finished"; truncated: boolean } | { kind: "released" } | { kind: "none" } => {
    if (encoded || (fileReady() && readResult()?.wrote === true)) return { kind: "finished", truncated };
    if (releasedEncode) return { kind: "released" };
    if (encoder && (encoder.exitCode !== null || encoder.signalCode !== null)) return { kind: "none" };
    if (!mp4 || !startSupervisor(owner)) return { kind: "none" };
    writeFileSync(paths.released, "", { mode: 0o600 });
    releasedEncode = true;
    if (encodeTimer) clearTimeout(encodeTimer);
    releaseWaiter?.();
    return { kind: "released" };
  };
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
        if (mp4) {
          if (!startSupervisor()) throw new Error("CDP video recorded no frames");
          await new Promise<void>((resolve, reject) => {
            if (releasedEncode || readResult()) { resolve(); return; }
            const poll = setInterval(() => {
              if (releasedEncode || readResult()) { clearInterval(poll); resolve(); }
            }, 20);
            releaseWaiter = () => { clearInterval(poll); resolve(); };
            encoder?.once("error", () => { clearInterval(poll); reject(new Error("CDP video encoder did not start")); });
            encoder?.once("exit", (_code, signal) => {
              clearInterval(poll);
              if (releasedEncode || readResult()) resolve();
              else reject(new Error(signal === "SIGKILL" ? "CDP video encoding timed out" : "CDP video encoding failed"));
            });
          });
          if (releasedEncode) return { wrote: false, frames: frames.length, truncated };
          const result = readResult();
          if (result?.wrote) encoded = true;
          clearHandoff();
          if (!result?.wrote) {
            if (result?.signal === "SIGKILL") throw new Error("CDP video encoding timed out");
            if (result?.code === 0) throw new Error("CDP video output was empty");
            throw new Error("CDP video encoding failed");
          }
        } else {
          const entry = (file: string) => `file '${file}'`;
          const list = frames.map((frame, index) => {
            const span = Math.max(40, (frames[index + 1]?.at ?? endedAt) - frame.at);
            return `${entry(frame.file)}\nduration ${(span / 1000).toFixed(3)}`;
          }).join("\n") + `\n${entry(frames[frames.length - 1]!.file)}\n`;
          const manifest = path.join(dir, "frames.txt");
          await writeFile(manifest, list, { mode: 0o600 });
          const encoding = [
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "vfr", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "5",
          ];
          await new Promise<void>((resolve, reject) => {
            encoder = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifest, ...encoding, destination],
              { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
            encodeTimer = setTimeout(() => { encoder?.kill("SIGKILL"); }, 120_000);
            encoder.once("error", () => { clearTimeout(encodeTimer); reject(new Error("CDP video encoder did not start")); });
            encoder.once("exit", (code, signal) => {
              clearTimeout(encodeTimer);
              if (code === 0) resolve();
              else reject(new Error(signal === "SIGKILL" ? "CDP video encoding timed out" : "CDP video encoding failed"));
            });
          });
        }
        if ((await stat(destination)).size < 1000) throw new Error("CDP video output was empty");
        keepFrames = false;
        encoded = true;
        return { wrote: true, frames: frames.length, truncated };
      } catch (error) {
        if (!releasedEncode && !encoded) {
          await rm(destination, { force: true });
          clearHandoff();
        }
        if (releasedEncode) return { wrote: false, frames: frames.length, truncated };
        if (keepFrames) throw new Error(`${error instanceof Error ? error.message : "CDP video encoding failed"}; video frames retained at ${dir}`);
        throw error;
      } finally {
        if (encodeTimer) clearTimeout(encodeTimer);
        if (!keepFrames && !releasedEncode) await rm(dir, { recursive: true, force: true });
      }
    })();
    return stopping;
  };
  const onFrame = (source: string, params: Record<string, unknown>): void => {
    void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, source).catch(() => undefined);
    if (source !== sessionId) return;
    if (!active || pauses > 0 || writing || Date.now() - last < 150) return;
    const data = typeof params.data === "string" && params.data.length <= Math.ceil(MAX_FRAME_BYTES / 3) * 4 ? Buffer.from(params.data, "base64") : undefined;
    if (!data || data.length > MAX_FRAME_BYTES) {
      failure = new Error("CDP video frame was invalid or too large");
      void stop().catch(() => undefined);
      return;
    }
    if (bytes + data.length > maxBytes) {
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
      if (bytes + extra > maxBytes) {
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
    if (frames.length >= maxFrames) {
      truncated = true;
      void stop().catch(() => undefined);
    }
  };
  const listening = new Set<string>();
  const listen = (source: string): void => {
    if (listening.has(source)) return;
    listening.add(source);
    cdp.on("Page.screencastFrame", source, (params) => onFrame(source, params));
  };
  listen(sessionId);
  try {
    await startCapture();
  } catch (error) { active = false; await pending; await rm(dir, { recursive: true, force: true }); throw error; }
  return {
    pause() { pauses += 1; },
    resume() { pauses = Math.max(0, pauses - 1); },
    endCapture,
    async switchSession(next: string) {
      if (ending || stopping) throw new Error("video capture has ended");
      active = false;
      await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
      await pending;
      sessionId = next;
      listen(next);
      active = true;
      last = 0;
      await startCapture();
    },
    stop,
    abandonEncode,
    releaseEncode,
  };
}
