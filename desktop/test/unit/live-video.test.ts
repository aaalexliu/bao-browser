// A live session and a live replay record their own window through the CDP
// connection that drives it, when the app is given a video folder. The browser is
// the pinned test Chromium on a temp profile, serving the Instacart fixture, so
// nothing touches the daily Chrome or the real site.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { CdpSocket } from "../../src/cdp-live/socket";
import * as screencast from "../../src/cdp-live/screencast";
import { concatList, startScreencast } from "../../src/cdp-live/screencast";
import { ffmpegBin } from "../../src/v1/replay-video";
import { Library } from "../../src/v1/store";
import { fakeChromeHelper } from "../fake-helper";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, type InstacartFixture } from "../instacart/fixture";

type Handler = (params: Record<string, unknown>) => void;

function fakeCdp(): { cdp: Parameters<typeof startScreencast>[0]; sent: [string, unknown, string | undefined][]; emit(params: Record<string, unknown>): void } {
  const handlers: Handler[] = [];
  const sent: [string, unknown, string | undefined][] = [];
  return {
    sent,
    emit: (params) => handlers.forEach((handler) => handler(params)),
    cdp: {
      on: (method: string, _session: string | undefined, handler: Handler) => {
        if (method === "Page.screencastFrame") handlers.push(handler);
      },
      send: async <T>(method: string, params?: Record<string, unknown>, session?: string) => {
        sent.push([method, params, session]);
        return {} as T;
      },
    } as Parameters<typeof startScreencast>[0],
  };
}

test("each frame shows until the next one, and the last until the end", () => {
  const list = concatList([{ file: "/x/frame-00000.jpg", at: 10 }, { file: "/x/frame-00001.jpg", at: 10.25 }], 12);
  assert.equal(list, [
    "ffconcat version 1.0",
    "file 'frame-00000.jpg'",
    "duration 0.250",
    "file 'frame-00001.jpg'",
    "duration 1.750",
    "file 'frame-00001.jpg'",
    "",
  ].join("\n"));
});

test("the screencast acks every frame, keeps frames until stop, and drops them after the write", async () => {
  const { cdp, sent, emit } = fakeCdp();
  let clock = 100;
  let encoded = "";
  const dest = path.join(mkdtempSync(path.join(tmpdir(), "bao-video-")), "clip.webm");
  const cast = await startScreencast(cdp, "S1", dest, async (list, out) => {
    encoded = readFileSync(list, "utf8");
    assert.equal(out, dest);
    return true;
  }, () => clock);
  assert.deepEqual(sent[0]?.[0], "Page.startScreencast");
  const jpeg = Buffer.from("not really a jpeg").toString("base64");
  emit({ data: jpeg, sessionId: 1, metadata: { timestamp: 100 } });
  emit({ data: jpeg, sessionId: 2, metadata: { timestamp: 100.5 } });
  clock = 101;
  await cast.stop();
  emit({ data: jpeg, sessionId: 3, metadata: { timestamp: 101.5 } });
  assert.deepEqual(
    sent.filter(([method]) => method === "Page.screencastFrameAck").map(([, params, session]) => [params, session]),
    [[{ sessionId: 1 }, "S1"], [{ sessionId: 2 }, "S1"], [{ sessionId: 3 }, "S1"]],
  );
  assert.ok(sent.some(([method]) => method === "Page.stopScreencast"));
  assert.equal(await cast.write(), dest);
  assert.match(encoded, /file 'frame-00000\.jpg'\nduration 0\.500\nfile 'frame-00001\.jpg'\nduration 0\.500\nfile 'frame-00001\.jpg'\n$/);
});

test("a 60 fps stream keeps the newest frame in each 0.1-second slot and acks all frames", async () => {
  const { cdp, sent, emit } = fakeCdp();
  const newest = new Map<number, string>();
  const cast = await startScreencast(cdp, "S1", "/nowhere/clip.webm", async (list) => {
    const dir = path.dirname(list);
    const files = readdirSync(dir).filter((name) => name.endsWith(".jpg")).sort();
    assert.equal(files.length, 100);
    assert.deepEqual(files.map((file) => readFileSync(path.join(dir, file), "utf8")), [...newest.values()]);
    const encoded = readFileSync(list, "utf8");
    assert.match(encoded, /frame-00099\.jpg/);
    assert.doesNotMatch(encoded, /frame-00100\.jpg/);
    return true;
  }, () => 110);
  for (let frame = 0; frame < 600; frame += 1) {
    const at = 100 + frame / 60;
    const value = `frame ${frame}`;
    newest.set(Math.floor(at * 10), value);
    emit({ data: Buffer.from(value).toString("base64"), sessionId: frame, metadata: { timestamp: at } });
  }
  assert.equal(await cast.write(), "/nowhere/clip.webm");
  assert.equal(sent.filter(([method]) => method === "Page.screencastFrameAck").length, 600);
});

test("the audit veil skip extends past its removal, even when the screenshot fails", async (t) => {
  let clock = 1_000_000;
  let fail = false;
  const skips: [number, number][] = [];
  t.mock.method(Date, "now", () => clock);
  t.mock.method(screencast, "startScreencast", async () => ({
    skip: (from: number, to: number) => { skips.push([from, to]); },
    stop: async () => undefined,
    write: async () => null,
  }));
  const cdp = {
    send: async (method: string, params: { expression?: string }) => {
      if (method === "Page.captureScreenshot") {
        clock += 1000;
        if (fail) throw new Error("screenshot failed");
        return { data: Buffer.from("png").toString("base64") };
      }
      if (params.expression === 'document.getElementById("bao-redact")?.remove()') clock += 1000;
      return { result: {} };
    },
  } as unknown as CdpSocket;
  const driver = new CdpLiveDriver(cdp, "S1", "T1");
  await driver.recordVideo("/nowhere/clip.webm");
  assert.equal((await driver.captureRedacted("audit")).toString(), "png");
  assert.deepEqual(skips, [[999.95, 1002.1]]);
  fail = true;
  await assert.rejects(driver.captureRedacted("audit failure"), /screenshot failed/);
  assert.deepEqual(skips[1], [1001.95, 1004.1]);
});

test("frames painted under an audit screenshot's veil are left out", async () => {
  const { cdp, emit } = fakeCdp();
  let encoded = "";
  const cast = await startScreencast(cdp, "S1", "/nowhere/clip.webm", async (list) => {
    encoded = readFileSync(list, "utf8");
    return true;
  }, () => 103);
  const jpeg = Buffer.from("x").toString("base64");
  for (const [frame, at] of [[1, 100], [2, 101], [3, 101.2], [4, 102]] as const) emit({ data: jpeg, sessionId: frame, metadata: { timestamp: at } });
  cast.skip(100.9, 101.5);
  assert.equal(await cast.write(), "/nowhere/clip.webm");
  assert.equal(encoded, "ffconcat version 1.0\nfile 'frame-00000.jpg'\nduration 2.000\nfile 'frame-00003.jpg'\nduration 1.000\nfile 'frame-00003.jpg'\n");
});

test("a screencast with no frame writes no video", async () => {
  const { cdp } = fakeCdp();
  const cast = await startScreencast(cdp, "S1", "/nowhere/clip.webm", async () => {
    throw new Error("no encode without a frame");
  });
  assert.equal(await cast.write(), null);
});

describe("a live session and a live replay record their window", { timeout: 180_000, skip: ffmpegBin() ? false : "no ffmpeg" }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
  });

  after(async () => {
    await browser?.close();
    await fixture?.close();
  });

  it("releases CDP before writing session, replay, and failed-start videos", async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-video-"));
    const videoDir = path.join(home, "videos");
    const lockFile = path.join(home, "lock");
    let closed = 0;
    let written = 0;
    const close = CdpSocket.prototype.close;
    const writeVideo = CdpLiveDriver.prototype.writeVideo;
    t.mock.method(CdpSocket.prototype, "close", function (this: CdpSocket) {
      close.call(this);
      assert.equal(this.isOpen, false);
      closed += 1;
    });
    t.mock.method(CdpLiveDriver.prototype, "writeVideo", async function (this: CdpLiveDriver) {
      assert.equal(closed, written + 1);
      assert.equal(existsSync(lockFile), false);
      const targets = await (await fetch(`${browser.cdpUrl}/json/list`)).json() as { id: string }[];
      assert.ok(!targets.some((target) => target.id === this.targetId));
      await writeVideo.call(this);
      written += 1;
    });
    fixture.reset();
    const host = createLiveHost({
      home,
      lockFile,
      target: { kind: "throwaway", portFile: browser.portFile },
      helper: () => fakeChromeHelper().helper,
      openProfile: async () => {
        throw new Error("a throwaway Chrome has no profile window");
      },
      idleMs: 0,
      videoDir,
    });
    type Body = { outcome?: { kind?: string }; session?: string; view?: { controls: { ref: string; label: string }[] } | null };
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
    try {
      const started = await call({ op: "live_session_start", intent: "search costco for blueberries", url: fixture.url("/store/costco/storefront"), client: "mock-user" });
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      const search = (body: Body) => body.view?.controls.find((item) => item.label === "Search Costco")?.ref || "";
      const typed = await call({ op: "live_type", ref: search(started), text: "blueberries" });
      assert.equal(typed.outcome?.kind, "applied", JSON.stringify(typed.outcome));
      const entered = await call({ op: "live_key", key: "Enter", ref: search(typed) });
      assert.equal(entered.outcome?.kind, "applied", JSON.stringify(entered.outcome));
      assert.equal((await call({ op: "live_stop" })).outcome?.kind, "stopped");
      const session = readdirSync(videoDir).filter((name) => name.startsWith(`live-${started.session}-`) && name.endsWith(".webm"));
      assert.equal(session.length, 1, readdirSync(videoDir).join(", "));
      assert.ok(statSync(path.join(videoDir, session[0] as string)).size > 1000);

      const run = await host.replay(new Library(home).read(started.session || ""));
      assert.equal(run.status, "passed", JSON.stringify(run.failure));
      assert.equal(run.modelCalls, 0);
      const clip = path.join(videoDir, `${run.runId}.webm`);
      assert.ok(existsSync(clip) && statSync(clip).size > 1000, readdirSync(videoDir).join(", "));
      t.mock.method(CdpLiveDriver.prototype, "goto", async () => { throw new Error("failed start"); });
      assert.equal((await call({ op: "live_session_start", intent: "failed start", url: fixture.url("/store/costco/storefront") })).outcome?.kind, "rejected");
      assert.equal(written, 3);
    } finally {
      await host.close();
    }
  });
});
