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
  let latest: Buffer | undefined;
  const cdp = {
    on(_method: string, _session: string, handler: typeof emit) { emit = handler; },
    async send(method: string) {
      if (method === "Page.startScreencast" && latest) emit({ data: latest.toString("base64"), sessionId: 1 });
      return {};
    },
  } as unknown as CdpSocket;
  return { cdp, emit(data: Buffer) { latest = data; emit({ data: data.toString("base64"), sessionId: 1 }); } };
}

const ffmpeg = ffmpegBin();
const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test("MP4 clips use QuickTime-safe H.264 with square pixels and a 30 fps timeline", { skip: !ffmpeg || !hasFfprobe, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-quicktime-"));
  const destination = path.join(root, "clip.mp4");
  const source = frameSource();
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let saved: () => void = () => {};
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
    await original(...args);
    if (typeof args[0] === "string" && path.basename(args[0]).startsWith("frame-")) saved();
  });
  const jpegs = ["red", "blue"].map((color) => {
    const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=1279x813,drawbox=color=${color}:t=fill`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(jpeg.status, 0, jpeg.stderr.toString());
    return jpeg.stdout;
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const video = await startCdpVideo(source.cdp, "page", destination, { noBlur: true });
  try {
    for (const [index, gap] of [0, 730].entries()) {
      now += gap;
      const persisted = new Promise<void>((resolve) => { saved = resolve; });
      source.emit(jpegs[index]!);
      await persisted;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    now += 1270;
    video.pause();
    assert.deepEqual(await video.stop(), { wrote: true, frames: 2, truncated: false });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", destination], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.profile, "Main");
    assert.equal(stream.level, 40);
    assert.equal(stream.codec_tag_string, "avc1");
    assert.equal(stream.width, 1278);
    assert.equal(stream.height, 812);
    assert.equal(stream.sample_aspect_ratio, "1:1");
    assert.equal(stream.pix_fmt, "yuv420p");
    assert.equal(stream.color_range, "tv");
    assert.equal(stream.color_space, "bt709");
    assert.equal(stream.color_transfer, "bt709");
    assert.equal(stream.color_primaries, "bt709");
    assert.equal(stream.has_b_frames, 0);
    assert.equal(stream.r_frame_rate, "30/1");
    assert.equal(stream.avg_frame_rate, "30/1");
    assert.ok(Math.abs(Number(stream.duration) - 2.04) <= 1 / 30, `irregular captures retain their wall-clock duration: ${stream.duration}`);
    const samples = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", destination, "-vf", "select='eq(n,0)+eq(n,30)',scale=1:1", "-fps_mode", "vfr", "-frames:v", "2", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.equal(samples.status, 0, samples.stderr.toString());
    assert.equal(samples.stdout.length, 6);
    assert.ok(samples.stdout[0]! > 200 && samples.stdout[2]! < 20, "the first second starts with the red capture");
    assert.ok(samples.stdout[3]! < 20 && samples.stdout[5]! > 200, "the second second holds the latest blue capture");
    const clip = await readFile(destination);
    const boxes: string[] = [];
    for (let offset = 0; offset + 8 <= clip.length;) {
      const size = clip.readUInt32BE(offset);
      assert.ok(size >= 8 && offset + size <= clip.length);
      boxes.push(clip.toString("ascii", offset + 4, offset + 8));
      offset += size;
    }
    assert.ok(boxes.includes("moov") && boxes.includes("mdat"));
    assert.ok(boxes.indexOf("moov") < boxes.indexOf("mdat"), "faststart puts metadata before media data");
  } finally {
    await video.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an MP4 keeps its full timeline and post-handoff frames across a twenty-minute pause", { skip: !ffmpeg || !hasFfprobe, timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-long-handoff-"));
  const destination = path.join(root, "clip.mp4");
  const source = frameSource();
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let saved: () => void = () => {};
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
    await original(...args);
    if (typeof args[0] === "string" && path.basename(args[0]).startsWith("frame-")) saved();
  });
  const jpegs = ["red", "blue"].map((color) => {
    const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=${color}:size=32x24`, "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"]);
    assert.equal(jpeg.status, 0, jpeg.stderr.toString());
    return jpeg.stdout;
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const video = await startCdpVideo(source.cdp, "page", destination, { noBlur: true });
  try {
    for (const [index, gap] of [0, 20 * 60 * 1000].entries()) {
      video.pause();
      video.pause();
      now += gap;
      video.resume();
      source.emit(jpegs[index]!);
      video.resume();
      const persisted = new Promise<void>((resolve) => { saved = resolve; });
      source.emit(jpegs[index]!);
      await persisted;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    now += 2000;
    video.pause();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stopped = video.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(120_000);
    assert.deepEqual(await stopped, { wrote: true, frames: 2, truncated: false });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", destination], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.ok(Math.abs(Number(stream.duration) - 1202.04) <= 1 / 30, `the entire pause and following action remain: ${stream.duration}`);
    assert.equal(stream.avg_frame_rate, "30/1");
    for (const [time, channel] of [[600, 0], [1201, 2]] as const) {
      const sample = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", destination, "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
      assert.equal(sample.status, 0, sample.stderr.toString());
      assert.equal(sample.stdout.length, 3);
      assert.ok(sample.stdout[channel]! > 200 && sample.stdout[2 - channel]! < 20, `the right frame is visible at ${time}s`);
    }
    assert.deepEqual(await readdir(root), ["clip.mp4"], "successful encoding removes the source bundle");
  } finally {
    await video.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["failure", "timeout"] as const) test(`an MP4 encoder ${outcome} retains recoverable source frames`, { skip: !ffmpeg, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-encoder-failure-"));
  const destination = path.join(root, "clip.mp4");
  const source = frameSource();
  const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { input: redactedPng(3) }).stdout;
  assert.ok(jpeg.length);
  const encoder = path.join(root, "encoder");
  await writeFile(encoder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1), Buffer.alloc(2000));\n${outcome === "timeout" ? "setInterval(() => {}, 1000);" : "process.exit(1);"}\n`, { mode: 0o700 });
  const previous = process.env.FFMPEG;
  process.env.FFMPEG = encoder;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const processes = require("node:child_process") as typeof import("node:child_process");
  const spawn = processes.spawn;
  let child: ReturnType<typeof spawn> | undefined;
  let started: () => void = () => {};
  const spawned = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(processes, "spawn", (...args: Parameters<typeof spawn>) => {
    child = spawn(...args);
    child.once("spawn", started);
    return child;
  });
  const video = await startCdpVideo(source.cdp, "page", destination, { noBlur: true });
  try {
    source.emit(jpeg);
    video.pause();
    now += 20 * 60 * 1000;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false;
    const stopped = video.stop();
    void stopped.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(stopped, /CDP video encoding (failed|timed out); video frames retained at /);
    await spawned;
    if (outcome === "timeout") {
      t.mock.timers.tick(120_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "a long clip gets more than the old fixed deadline");
      t.mock.timers.tick(20 * 60 * 1000 * 2 + 1000);
    }
    await rejected;
    await assert.rejects(readFile(destination), /ENOENT/);
    const bundle = (await readdir(root)).find((name) => name.startsWith("clip.mp4.frames-"));
    assert.ok(bundle);
    const manifest = path.join(root, bundle, "frames.txt");
    const recovered = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", manifest, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.equal(recovered.status, 0, recovered.stderr.toString());
    assert.equal(recovered.stdout.length, 96 * 54 * 3, "ffmpeg can still decode the original recording after the encoder fails");
  } finally {
    child?.kill("SIGKILL");
    await video.stop().catch(() => undefined);
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

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
    video.pause();
    source.emit(jpeg);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(files, []);
    video.resume();
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

test("explicit no-blur recording preserves source pixels in temporary frames and the encoded clip", { skip: !ffmpeg, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-eval-video-"));
  const destination = path.join(root, "clip.mp4");
  const source = frameSource();
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let frameFile = "";
  let saved: () => void = () => {};
  const firstFrame = new Promise<void>((resolve) => { saved = resolve; });
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
    await original(...args);
    if (typeof args[0] === "string" && path.basename(args[0]).startsWith("frame-")) { frameFile = args[0]; saved(); }
  });
  const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { input: redactedPng(3), maxBuffer: 16 * 1024 * 1024 }).stdout;
  const video = await startCdpVideo(source.cdp, "page", destination, { noBlur: true });
  try {
    source.emit(jpeg);
    await firstFrame;
    assert.deepEqual(await readFile(frameFile), jpeg);
    await video.endCapture();
    await assert.rejects(readFile(destination), /ENOENT/);
    assert.deepEqual(await video.stop(), { wrote: true, frames: 2, truncated: false });
    const decoded = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", destination, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.equal(decoded.stdout.length, 96 * 54 * 3);
    assert.ok(Math.min(...decoded.stdout) < 80, "encoding must not add the blur veil back");
    assert.ok(Math.abs(decoded.stdout[(27 * 96 + 10) * 3]! - decoded.stdout[(27 * 96 + 14) * 3]!) > 100, "source stripe edges stay sharp");
  } finally {
    await video.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing final screencast frame fails instead of saving only startup frames", { skip: !ffmpeg, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-final-frame-"));
  const destination = path.join(root, "clip.webm");
  const source = frameSource();
  const jpeg = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"], { input: redactedPng(3), maxBuffer: 16 * 1024 * 1024 }).stdout;
  const video = await startCdpVideo(source.cdp, "page", destination, { noBlur: true });
  try {
    source.emit(jpeg);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(source.cdp, "send", async (method: string) => {
      if (method === "Page.startScreencast") t.mock.timers.tick(5000);
      return {};
    });
    await assert.rejects(video.stop(), /final frame timed out/);
    await assert.rejects(readFile(destination), /ENOENT/);
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
