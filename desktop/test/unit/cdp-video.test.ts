import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { startCdpVideo } from "../../src/engines/cdp-video";

test("the frame limit finalizes and retains a truncated clip without rejecting stop", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-limit-"));
  const encoder = path.join(root, "encoder");
  const destination = path.join(root, "clip.webm");
  const previous = process.env.FFMPEG;
  await writeFile(encoder, `#!${process.execPath}
const fs = require('node:fs');
const list = fs.readFileSync(process.argv[process.argv.indexOf('-i') + 1], 'utf8');
fs.writeFileSync(${JSON.stringify(path.join(root, "frames.txt"))}, list);
fs.writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
`, { mode: 0o700 });
  process.env.FFMPEG = encoder;
  let frame: (params: Record<string, unknown>) => void = () => { throw new Error("missing listener"); };
  let stops = 0;
  const cdp = {
    on(_method: string, _session: string, handler: typeof frame) { frame = handler; },
    async send(method: string) { if (method === "Page.stopScreencast") stops++; return {}; },
  } as unknown as CdpSocket;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.writeFile;
  let pending: Promise<void> = Promise.resolve();
  t.mock.method(fs, "writeFile", (...args: Parameters<typeof writeFile>) => { pending = original(...args); return pending; });
  try {
    const video = await startCdpVideo(cdp, "page", destination);
    for (let index = 0; index < 6000; index++) {
      now += 151;
      frame({ data: "aW1hZ2U=", sessionId: index });
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(stops, 1, "capture limit stops and finalizes without waiting for session end");
    const result = await video.stop();
    assert.deepEqual(result, { wrote: true, frames: 6000, truncated: true });
    assert.deepEqual(await video.stop(), result);
    assert.equal(stops, 1);
    assert.equal((await readFile(destination)).length, 2000);
    const manifest = await readFile(path.join(root, "frames.txt"), "utf8");
    assert.equal(manifest.split("\n").filter((line) => line.startsWith("duration ")).length, 6000);
    const temporary = manifest.split("'")[1]!;
    await assert.rejects(readFile(temporary), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
