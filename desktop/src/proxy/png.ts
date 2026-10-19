// PNG helpers for the Claude adapter. Screenshots sent to the model are a
// scaled copy of the viewport. ffmpeg does the resize; the IHDR is enough to
// read the size back.

import { spawn } from "node:child_process";

export function pngSize(png: Buffer): { w: number; h: number } {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("not a png");
  }
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

function ffmpegPng(png: Buffer, vf: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vf", vf,
      "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) reject(new Error(err || `ffmpeg exited ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    ff.stdin.write(png);
    ff.stdin.end();
  });
}

/** Scale by numer/denom. The Claude spike uses 1/2 so a missing scale misses the control. */
export function scalePng(png: Buffer, numer: number, denom: number): Promise<Buffer> {
  return ffmpegPng(png, `scale=trunc(iw*${numer}/${denom}):trunc(ih*${numer}/${denom})`);
}

/** Fit inside a box, preserving aspect. Used for zoom images. */
export async function fitPng(png: Buffer, box: { w: number; h: number }): Promise<Buffer> {
  const size = pngSize(png);
  if (size.w <= box.w && size.h <= box.h) return png;
  return ffmpegPng(png, `scale=${box.w}:${box.h}:force_original_aspect_ratio=decrease`);
}
