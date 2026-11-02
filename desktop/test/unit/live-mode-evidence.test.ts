import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";
import * as recorder from "../../src/engines/cdp-video";

test("YOLO screenshots skip the veil and video starts without blur", async (t) => {
  const calls: string[] = [];
  const image = Buffer.from("readable screenshot");
  const cdp = { async send(method: string) { calls.push(method); return { data: image.toString("base64") }; } } as unknown as CdpSocket;
  let mode: unknown;
  t.mock.method(recorder, "startCdpVideo", async (_cdp: CdpSocket, _session: string, _dest: string, options: { noBlur?: true } = {}) => {
    mode = options;
    return { pause() {}, resume() {}, async endCapture() {}, async switchSession() {}, async stop() { return { wrote: false, frames: 0, truncated: false }; } };
  });
  const driver = new CdpLiveDriver(cdp, "page", "tab");
  driver.setCareful(false);
  await driver.startVideo("unused.mp4");
  assert.deepEqual(mode, { noBlur: true });
  assert.deepEqual(await driver.captureRedacted("evidence"), image);
  assert.deepEqual(calls, ["Page.captureScreenshot"]);
});

test("a session video follows owned tab switches without duplicate listeners or foreign frames", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-tabs-"));
  const encoder = path.join(root, "encoder");
  const destination = path.join(root, "clip.webm");
  await writeFile(encoder, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1), Buffer.alloc(2000));\n`, { mode: 0o700 });
  const previous = process.env.FFMPEG;
  process.env.FFMPEG = encoder;
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  const calls: { method: string; session?: string }[] = [];
  const cdp = {
    on(_method: string, session: string, handler: (params: Record<string, unknown>) => void) {
      listeners.set(session, [...(listeners.get(session) || []), handler]);
    },
    async send(method: string, _params: unknown, session?: string) { calls.push({ method, session }); return {}; },
  } as unknown as CdpSocket;
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let pending = Promise.resolve();
  const frames: Buffer[] = [];
  t.mock.method(fs, "writeFile", (...args: Parameters<typeof writeFile>) => {
    if (String(args[0]).includes("/frame-")) frames.push(Buffer.from(args[1] as Buffer));
    return pending = original(...args);
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const emit = async (session: string, text: string): Promise<void> => {
    now += 200;
    for (const handler of listeners.get(session) || []) handler({ data: Buffer.from(text).toString("base64"), sessionId: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    const video = await recorder.startCdpVideo(cdp, "first", destination, { noBlur: true });
    await emit("first", "first page");
    await video.switchSession("second");
    await emit("first", "ignored old page");
    await emit("second", "second page");
    await video.switchSession("first");
    await emit("first", "first page again");
    video.pause();
    assert.deepEqual(await video.stop(), { wrote: true, frames: 3, truncated: false });
    assert.deepEqual(frames.map((frame) => frame.toString()), ["first page", "second page", "first page again"]);
    assert.equal(listeners.get("first")!.length, 1);
    assert.equal(listeners.get("second")!.length, 1);
    assert.deepEqual(calls.filter((call) => call.method === "Page.startScreencast").map((call) => call.session), ["first", "second", "first"]);
    assert.equal((await readFile(destination)).length, 2000);
    await assert.rejects(video.switchSession("second"), /ended/);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
