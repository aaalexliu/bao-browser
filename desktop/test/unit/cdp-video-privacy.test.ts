import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { startCdpVideo } from "../../src/engines/cdp-video";
import { ffmpegBin } from "../../src/v1/replay-video";
import { redactedPng } from "../../src/v1/redacted-png";

function frameSource() {
  let emit = (_params: Record<string, unknown>) => {};
  const cdp = {
    on(_method: string, _session: string, handler: typeof emit) { emit = handler; },
    async send() { return {}; },
  } as unknown as CdpSocket;
  return { cdp, emit(data: Buffer) { emit({ data: data.toString("base64"), sessionId: 1 }); } };
}

const ffmpeg = ffmpegBin();

test("temporary frames and encoded video are veiled before persistence; pause drops frames", { skip: !ffmpeg, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-privacy-"));
  const destination = path.join(root, "clip.mp4");
  const source = frameSource();
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  const files: string[] = [];
  let saved: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => { saved = resolve; });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
    await original(...args);
    if (typeof args[0] === "string" && path.basename(args[0]).startsWith("frame-")) {
      files.push(args[0]);
      saved();
    }
  });
  const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"],
    { input: redactedPng(3), maxBuffer: 16 * 1024 * 1024 }).stdout;
  assert.ok(jpeg.length);
  const video = await startCdpVideo(source.cdp, "page", destination);
  try {
    video.pause();
    source.emit(jpeg);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(files, []);
    video.resume();
    source.emit(jpeg);
    await firstFrame;
    const persisted = await readFile(files[0]!);
    assert.notDeepEqual(persisted, jpeg);
    const decode = (input: Buffer) => {
      const result = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { input, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(result.stdout.length, 96 * 54 * 3);
      return result.stdout;
    };
    const pixels = decode(persisted);
    assert.ok(Math.min(...pixels) >= 195, "the 82% light veil covers the whole persisted frame");
    for (let x = 30; x < 65; x++) {
      assert.ok(Math.abs(pixels[(27 * 96 + x) * 3]! - pixels[(27 * 96 + x + 1) * 3]!) <= 3, "blur removes the source's sharp stripe edges");
    }
    video.pause();
    source.emit(jpeg);
    const result = await video.stop();
    assert.deepEqual(result, { wrote: true, frames: 1, truncated: false });
    assert.equal(files.length, 1);
    const clip = await readFile(destination);
    assert.ok(Math.min(...decode(clip)) >= 190, "the actual encoded clip retains the veil");
    await assert.rejects(readFile(files[0]!), /ENOENT/);
  } finally {
    await video.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed frame transform never writes the raw input or leaves a clip", { skip: !ffmpeg, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-fail-closed-"));
  const source = frameSource();
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const writes = t.mock.method(fs, "writeFile");
  const makeTemp = t.mock.method(fs, "mkdtemp");
  const destination = path.join(root, "clip.webm");
  const video = await startCdpVideo(source.cdp, "page", destination);
  try {
    source.emit(Buffer.from("unreadable-private-frame"));
    await assert.rejects(video.stop(), /frame could not be veiled/);
    assert.equal(writes.mock.calls.length, 0);
    await assert.rejects(readFile(destination), /ENOENT/);
    for (const call of makeTemp.mock.calls) {
      const dir = await call.result;
      assert.ok(dir);
      await assert.rejects(readdir(dir), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
