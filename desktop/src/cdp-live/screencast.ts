// Records a live window through the CDP connection that drives it. Page.startScreencast sends a
// frame each time the page paints. Each frame goes to a temp folder as it comes. ffmpeg then joins
// the frames into one webm, each frame shown until the next one came. No macOS screen recording.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegBin } from "../v1/replay-video";
import type { CdpSocket } from "./socket";

const MAX_FRAMES = 20_000;

export interface Frame {
  file: string;
  /** Seconds since the epoch, from the frame's metadata. */
  at: number;
}

export interface Screencast {
  /** Leaves out frames painted between these times, in seconds since the epoch, such as the blur veil of an audit screenshot. */
  skip(from: number, to: number): void;
  /** Stops the frames. The window may close after this. */
  stop(): Promise<void>;
  /** Writes the video and drops the frames. The path, or null when no frame came or ffmpeg failed. */
  write(): Promise<string | null>;
}

export type EncodeFrames = (list: string, dest: string) => Promise<boolean>;

/** An ffconcat list that shows each frame until the next one, and the last one until `end`. */
export function concatList(frames: readonly Frame[], end: number): string {
  const lines = ["ffconcat version 1.0"];
  frames.forEach((frame, index) => {
    const next = frames[index + 1]?.at ?? end;
    lines.push(`file '${path.basename(frame.file)}'`, `duration ${Math.max(0.001, next - frame.at).toFixed(3)}`);
  });
  const last = frames[frames.length - 1];
  if (last) lines.push(`file '${path.basename(last.file)}'`);
  return `${lines.join("\n")}\n`;
}

/** Ten frames a second of VP8, which the app's run view plays. */
export const encodeFrames: EncodeFrames = (list, dest) => {
  const bin = ffmpegBin();
  if (!bin) return Promise.resolve(false);
  mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(bin, [
      "-y", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", list,
      "-vf", "fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libvpx", "-b:v", "1M", "-an",
      dest,
    ], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => {
      try {
        resolve(code === 0 && statSync(dest).size > 1000);
      } catch {
        resolve(false);
      }
    });
  });
};

export async function startScreencast(
  cdp: Pick<CdpSocket, "send" | "on">,
  sessionId: string,
  dest: string,
  encode: EncodeFrames = encodeFrames,
  now: () => number = () => Date.now() / 1000,
): Promise<Screencast> {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-screencast-"));
  const frames: Frame[] = [];
  const skipped: [number, number][] = [];
  let recording = true;
  let end = 0;
  cdp.on("Page.screencastFrame", sessionId, (params) => {
    // The event's sessionId is the frame number Chrome waits on before it sends the next frame.
    if (typeof params.sessionId === "number") {
      void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => undefined);
    }
    if (!recording || typeof params.data !== "string") return;
    const stamp = (params.metadata as { timestamp?: unknown } | undefined)?.timestamp;
    const at = typeof stamp === "number" ? stamp : now();
    const last = frames[frames.length - 1];
    if (last && Math.floor(last.at * 10) === Math.floor(at * 10)) {
      writeFileSync(last.file, Buffer.from(params.data, "base64"));
      last.at = at;
      return;
    }
    if (frames.length >= MAX_FRAMES) return;
    const file = path.join(dir, `frame-${String(frames.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(params.data, "base64"));
    frames.push({ file, at });
  });
  try {
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 960, everyNthFrame: 1 }, sessionId);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const stop = async (): Promise<void> => {
    if (!recording) return;
    recording = false;
    end = now();
    await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
  };
  return {
    skip(from, to) {
      skipped.push([from, to]);
    },
    stop,
    async write() {
      await stop();
      try {
        const kept = frames.filter((frame) => !skipped.some(([from, to]) => frame.at >= from && frame.at <= to));
        if (!kept.length) return null;
        const list = path.join(dir, "frames.txt");
        writeFileSync(list, concatList(kept, Math.max(end, kept[kept.length - 1]?.at ?? end)));
        return (await encode(list, dest)) ? dest : null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
