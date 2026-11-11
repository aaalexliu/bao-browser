import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { abandonVideoOnHostStop, AgentBrowserRun } from "../../src/engines/agent-browser-record";
import * as cdpVideo from "../../src/engines/cdp-video";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { ffmpegBin } from "../../src/v1/replay-video";
import { chromeProfiles } from "../support/chrome-profiles";
import { scaledMs } from "../runtime";

pinTestBrowser();
const ffmpeg = ffmpegBin();
const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function evaluate<T>(cdp: CdpSocket, targetId: string, expression: string): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result } = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    return result.value;
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-video-"));
  const source = path.join(root, "chrome");
  await chromeProfiles(source);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>${request.url}</title><style>body{background:${request.url === "/blue" ? "blue" : "red"}}</style><input id=q><button id=b>Save</button><p id=out>Ready</p><script>b.onclick=()=>out.textContent='Saved '+q.value</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: source, headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  return { root, source, base, chrome, cdp, endpoint, async close() {
    cdp.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  } };
}

function sample(file: string, end = false): Buffer {
  const result = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", ...(end ? ["-sseof", "-0.1"] : ["-ss", "0.2"]),
    "-i", file, "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, 3);
  return result.stdout;
}

function frames(file: string): Buffer[] {
  const result = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", file,
    "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length % 3, 0);
  const pixels: Buffer[] = [];
  for (let i = 0; i < result.stdout.length; i += 3) pixels.push(result.stdout.subarray(i, i + 3));
  return pixels;
}

for (const end of ["tab closes", "CDP disconnects"] as const) test(`tab video follows the agent target and survives when ${end}`, { skip: !ffmpeg, timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const run = new AgentBrowserRun(path.join(f.root, "home"));
  try {
    const open = async (url: string) => {
      const { targetId } = await f.cdp.send<{ targetId: string }>("Target.createTarget", { url });
      const deadline = Date.now() + scaledMs(5000);
      while (!await evaluate(f.cdp, targetId, `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`)) {
        assert.ok(Date.now() < deadline, "fixture page loaded");
        await wait(20);
      }
      return targetId;
    };
    const red = await open(`${f.base}/red`);
    await run.recordTab(f.cdp, red);
    await wait(400);
    const blue = await open(`${f.base}/blue`);
    await run.recordTab(f.cdp, blue);
    await run.recordTab(f.cdp, blue);
    await wait(400);
    if (end === "tab closes") await f.cdp.send("Target.closeTarget", { targetId: blue });
    else f.cdp.close();
    await run.endVideoCapture();
    await run.encodeVideo();
    await run.endVideoCapture();
    await run.encodeVideo();
    run.finish();
    const receipt = new Library(path.join(f.root, "home")).listRuns()[0]!;
    assert.equal(receipt.video, `${run.id}.mp4`);
    assert.ok(receipt.videoStartedAt! >= receipt.at);
    const file = path.join(f.root, "home", "videos", receipt.video!);
    assert.ok((await stat(file)).size > 1000);
    const first = sample(file);
    const last = sample(file, true);
    assert.ok(first[0]! > 180 && first[2]! < 50, `first target is red: ${first.toJSON().data}`);
    assert.ok(last[2]! > 180 && last[0]! < 50, `last target is blue: ${last.toJSON().data}`);
  } finally { await run.endVideoCapture(); await run.encodeVideo(); await f.close(); }
});

test("tab video omits frames painted during an owner wait", { skip: !ffmpeg, timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const run = new AgentBrowserRun(path.join(f.root, "home"));
  try {
    const url = `${f.base}/red`;
    const { targetId } = await f.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    const deadline = Date.now() + scaledMs(5000);
    while (!await evaluate(f.cdp, targetId, `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`)) {
      assert.ok(Date.now() < deadline, "fixture page loaded");
      await wait(20);
    }
    await run.recordTab(f.cdp, targetId);
    await wait(400);
    run.ownerWaiting(true);
    run.ownerWaiting(true);
    await evaluate(f.cdp, targetId, "document.documentElement.style.background='#00ff00';document.body.style.background='#00ff00'");
    await wait(800);
    run.ownerWaiting(false);
    await evaluate(f.cdp, targetId, "document.documentElement.style.background='blue';document.body.style.background='blue'");
    await wait(400);
    await run.endVideoCapture();
    await run.encodeVideo();
    run.finish();
    const file = path.join(f.root, "home", "videos", `${run.id}.mp4`);
    assert.ok((await stat(file)).size > 1000);
    const pixels = frames(file);
    assert.ok(pixels.some((pixel) => pixel[0]! > 180 && pixel[2]! < 50), "recording before the wait is red");
    assert.ok(pixels.some((pixel) => pixel[2]! > 180 && pixel[0]! < 50), "recording resumes after the wait");
    const duringWait = pixels.filter((pixel) => pixel[1]! > 180 && pixel[0]! < 80 && pixel[2]! < 80);
    assert.equal(duringWait.length, 0, "owner wait painted green and must not appear");
  } finally { await run.endVideoCapture(); await run.encodeVideo(); await f.close(); }
});

test("a capture started during an owner wait omits the wait and resumes after it", { skip: !ffmpeg, timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const run = new AgentBrowserRun(path.join(f.root, "home"));
  try {
    const url = `${f.base}/red`;
    const { targetId } = await f.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    const deadline = Date.now() + scaledMs(5000);
    while (!await evaluate(f.cdp, targetId, `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`)) {
      assert.ok(Date.now() < deadline, "fixture page loaded");
      await wait(20);
    }
    run.ownerWaiting(true);
    await evaluate(f.cdp, targetId, "document.documentElement.style.background='#00ff00';document.body.style.background='#00ff00'");
    await run.recordTab(f.cdp, targetId);
    run.ownerWaiting(true);
    await wait(800);
    run.ownerWaiting(false);
    await evaluate(f.cdp, targetId, "document.documentElement.style.background='blue';document.body.style.background='blue'");
    await wait(400);
    await run.endVideoCapture();
    await run.encodeVideo();
    const file = path.join(f.root, "home", "videos", `${run.id}.mp4`);
    assert.ok((await stat(file)).size > 1000);
    const pixels = frames(file);
    assert.ok(pixels.some((pixel) => pixel[2]! > 180 && pixel[0]! < 50), "recording resumes after the wait");
    const duringWait = pixels.filter((pixel) => pixel[1]! > 180 && pixel[0]! < 80 && pixel[2]! < 80);
    assert.equal(duringWait.length, 0, "a capture started during the wait must not keep those frames");
  } finally { await run.endVideoCapture(); await run.encodeVideo(); await f.close(); }
});

test("unavailable tab recording does not fail commands or their receipt", { timeout: scaledMs(30_000) }, async (t) => {
  const f = await fixture();
  const home = path.join(f.root, "home");
  const run = new AgentBrowserRun(home);
  let starts = 0;
  t.mock.method(cdpVideo, "startCdpVideo", async () => { starts++; throw new Error("encoder unavailable"); });
  try {
    const { targetId } = await f.cdp.send<{ targetId: string }>("Target.createTarget", { url: `${f.base}/red` });
    await run.recordTab(f.cdp, targetId);
    await run.recordTab(f.cdp, targetId);
    const step = run.begin("snapshot", []);
    await run.complete(step, [{ stdout: "Read the page", stderr: "", exitCode: 0 }], home, async () => {
      const { sessionId } = await f.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      try {
        const { data } = await f.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg" }, sessionId);
        return Buffer.from(data, "base64");
      } finally { await f.cdp.send("Target.detachFromTarget", { sessionId }); }
    });
    await run.endVideoCapture();
    await run.encodeVideo();
    run.finish();
    const receipt = new Library(home).listRuns()[0]!;
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.video, undefined);
    assert.ok(Object.hasOwn(receipt.steps[0]!, "afterShot"));
    assert.equal(starts, 1);
  } finally { await f.close(); }
});

test("Running Chrome records the background task without changing the owner tab, and saves video on finish, close and disconnect", { skip: !binary || !ffmpeg, timeout: scaledMs(90_000) }, async (t) => {
  const f = await fixture();
  const probe = await connectCdp(f.endpoint.port, f.endpoint.browserPath);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const upstream = await connectCdp(f.endpoint.port, f.endpoint.browserPath);
    const shared = await shareConnection(upstream);
    const cdp = await connectCdp(shared.endpoint.port, shared.endpoint.browserPath);
    return { pid: 7, executable: pinTestBrowser(), root: f.source, endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { cdp.close(); shared.close(); upstream.close(); } };
  });
  try {
    const { targetId: owner } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${f.base}/owner` });
    const ownerReady = Date.now() + scaledMs(5000);
    while (!await evaluate(probe, owner, `document.readyState === 'complete' && location.href === ${JSON.stringify(`${f.base}/owner`)}`)) {
      assert.ok(Date.now() < ownerReady, "owner fixture page loaded");
      await wait(20);
    }
    await evaluate(probe, owner, "window.ownerEvents=[];addEventListener('blur',()=>ownerEvents.push('blur'));document.addEventListener('visibilitychange',()=>ownerEvents.push(document.visibilityState))");
    for (const end of ["finish", "close", "disconnect"] as const) {
      const home = path.join(f.root, end);
      const proxy = new AgentBrowserProxy({ home, sourceRoot: f.source, executable: binary });
      try {
        const opened = await proxy.execute("open", [`${f.base}/red`], "current");
        assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
        const id = proxy.activeRunId!;
        for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]]] as const) {
          const [result] = await proxy.execute(command, [...args], undefined, false, undefined, {}, id);
          assert.equal(result!.exitCode, 0, result!.stderr);
        }
        const { targetInfos: tabs } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
        const task = tabs.find(tab => tab.url === `${f.base}/red`)!;
        assert.equal(await evaluate(probe, task.targetId, "out.textContent"), "Saved Ada");
        await wait(200);
        if (end === "finish") await proxy.finishTask({ outcome: "passed", reason: "Saved Ada" }, id);
        else if (end === "close") await proxy.execute("close", [], undefined, false, undefined, {}, id);
        else await proxy.end();
        const run = new Library(home).listRuns()[0]!;
        assert.equal(run.status, "passed");
        assert.equal(run.video, `${id}.mp4`);
        assert.ok((await readFile(path.join(home, "videos", run.video!))).length > 1000);
        assert.deepEqual(await evaluate(probe, owner, "({visibility:document.visibilityState,events:ownerEvents})"), { visibility: "visible", events: [] });
        let pages: string[] = [];
        const deadline = Date.now() + scaledMs(2000);
        do {
          const { targetInfos } = await probe.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
          pages = targetInfos.filter(target => target.type === "page").map(target => target.targetId);
          if (pages.length === 1) break;
          await wait(25);
        } while (Date.now() < deadline);
        assert.deepEqual(pages, [owner]);
      } finally { await proxy.end(); }
    }
  } finally { probe.close(); await f.close(); }
});

test("a stop that cuts off an in-progress encode leaves the encoder running and attaches the video", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-cutoff-"));
  const home = path.join(root, "home");
  const pidFile = path.join(root, "encoder.pid");
  const encoder = path.join(root, "encoder");
  const previous = process.env.FFMPEG;
  let pid = 0;
  await writeFile(encoder, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {
  fs.writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
  process.exit(0);
}, 400);
`, { mode: 0o700 });
  process.env.FFMPEG = encoder;
  const frames = new Map<string, (params: Record<string, unknown>) => void>();
  const cdp = {
    on(method: string, _session: string, handler: (params: Record<string, unknown>) => void) { frames.set(method, handler); },
    async send(method: string) {
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "Page.startScreencast") {
        frames.get("Page.screencastFrame")?.({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), sessionId: "frame" });
      }
      return {};
    },
  } as unknown as CdpSocket;
  const run = new AgentBrowserRun(home);
  const notes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    notes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run.recordTab(cdp, "tab");
    await run.endVideoCapture();
    const videos = path.join(home, "videos");
    assert.equal((await readdir(videos)).filter((name) => name.includes(".frames-")).length, 1);
    const encoding = run.encodeVideo();
    const started = Date.now() + scaledMs(5000);
    while (!existsSync(pidFile)) {
      assert.ok(Date.now() < started, "encoder started");
      await wait(20);
    }
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0));
    abandonVideoOnHostStop();
    assert.doesNotThrow(() => process.kill(pid, 0));
    await encoding;
    const savedAt = Date.now() + 5000;
    let saved = new Library(home).listRuns()[0]!;
    while (!saved.video && Date.now() < savedAt) {
      await wait(20);
      saved = new Library(home).listRuns()[0]!;
    }
    assert.equal(saved.video, `${run.id}.mp4`);
    assert.equal(typeof saved.videoStartedAt, "number");
    assert.equal(saved.videoUnavailable, undefined);
    assert.ok((await stat(path.join(videos, `${run.id}.mp4`))).size >= 1000);
    assert.deepEqual((await readdir(videos)).filter((name) => name.includes(".frames-")), []);
    assert.equal(notes.some((line) => line.includes("frames retained")), false);
    assert.equal(notes.some((line) => line.includes("Bao stopped before the video finished")), false);
  } finally {
    process.stderr.write = write;
    abandonVideoOnHostStop();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a later host stop keeps a video the capture limit already saved", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-limit-claim-"));
  const home = path.join(root, "home");
  const encoder = path.join(root, "encoder");
  const previous = process.env.FFMPEG;
  const previousLimit = process.env.BAO_CDP_VIDEO_MAX_BYTES;
  await writeFile(encoder, `#!${process.execPath}
require("node:fs").writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
`, { mode: 0o700 });
  process.env.FFMPEG = encoder;
  process.env.BAO_CDP_VIDEO_MAX_BYTES = "4";
  const frames = new Map<string, (params: Record<string, unknown>) => void>();
  const emit = () => frames.get("Page.screencastFrame")?.({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), sessionId: "frame" });
  const cdp = {
    on(method: string, _session: string, handler: (params: Record<string, unknown>) => void) { frames.set(method, handler); },
    async send(method: string) {
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "Page.startScreencast") emit();
      return {};
    },
  } as unknown as CdpSocket;
  const run = new AgentBrowserRun(home);
  try {
    await run.recordTab(cdp, "tab");
    await wait(200);
    emit();
    const resultFile = path.join(home, "videos", `${run.id}.mp4.result.json`);
    const ready = Date.now() + 5000;
    while (!existsSync(resultFile)) {
      assert.ok(Date.now() < ready, "capture limit finished the encode");
      await wait(20);
    }
    abandonVideoOnHostStop();
    const saved = new Library(home).listRuns()[0]!;
    assert.equal(saved.video, `${run.id}.mp4`);
    assert.equal(saved.videoTruncated, true);
    assert.equal(saved.videoUnavailable, undefined);
    assert.ok((await stat(path.join(home, "videos", `${run.id}.mp4`))).size >= 1000);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    if (previousLimit === undefined) delete process.env.BAO_CDP_VIDEO_MAX_BYTES; else process.env.BAO_CDP_VIDEO_MAX_BYTES = previousLimit;
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed encode warns with the encoder error and the kept frames path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-encode-fail-"));
  const home = path.join(root, "home");
  const encoder = path.join(root, "encoder");
  const previous = process.env.FFMPEG;
  await writeFile(encoder, `#!${process.execPath}
process.exit(1);
`, { mode: 0o700 });
  process.env.FFMPEG = encoder;
  const frames = new Map<string, (params: Record<string, unknown>) => void>();
  const cdp = {
    on(method: string, _session: string, handler: (params: Record<string, unknown>) => void) { frames.set(method, handler); },
    async send(method: string) {
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Target.getTargets") return { targetInfos: [] };
      if (method === "Page.startScreencast") {
        frames.get("Page.screencastFrame")?.({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), sessionId: "frame" });
      }
      return {};
    },
  } as unknown as CdpSocket;
  const notes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    notes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const run = new AgentBrowserRun(home);
  try {
    await run.recordTab(cdp, "tab");
    await run.endVideoCapture();
    await run.encodeVideo();
    const videos = path.join(home, "videos");
    const kept = (await readdir(videos)).filter((name) => name.includes(".frames-"));
    assert.equal(kept.length, 1);
    const saved = new Library(home).listRuns()[0]!;
    assert.equal(saved.video, undefined);
    assert.equal(notes.some((line) => line.includes("tab video encoding") && !line.includes("frames retained")), false);
    assert.equal(notes.some((line) => line.includes("CDP video encoding failed") && line.includes(kept[0]!)), true);
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a later host stop leaves a failed encode's frames and record unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-settled-"));
  const failing = path.join(root, "failing");
  const hanging = path.join(root, "hanging");
  const pidFile = path.join(root, "encoder.pid");
  const previous = process.env.FFMPEG;
  let pid = 0;
  await writeFile(failing, `#!${process.execPath}
process.exit(1);
`, { mode: 0o700 });
  await writeFile(hanging, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => {
  fs.writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
  process.exit(0);
}, 400);
`, { mode: 0o700 });
  const socket = (): CdpSocket => {
    const frames = new Map<string, (params: Record<string, unknown>) => void>();
    return {
      on(method: string, _session: string, handler: (params: Record<string, unknown>) => void) { frames.set(method, handler); },
      async send(method: string) {
        if (method === "Target.attachToTarget") return { sessionId: "page" };
        if (method === "Target.getTargets") return { targetInfos: [] };
        if (method === "Page.startScreencast") {
          frames.get("Page.screencastFrame")?.({ data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), sessionId: "frame" });
        }
        return {};
      },
    } as unknown as CdpSocket;
  };
  const homeA = path.join(root, "a");
  const homeB = path.join(root, "b");
  try {
    process.env.FFMPEG = failing;
    const settled = new AgentBrowserRun(homeA);
    await settled.recordTab(socket(), "tab");
    await settled.endVideoCapture();
    await settled.encodeVideo();
    const kept = (await readdir(path.join(homeA, "videos"))).filter((name) => name.includes(".frames-"));
    assert.equal(kept.length, 1);
    const record = await readFile(path.join(homeA, "runs", `${settled.id}.json`), "utf8");
    const before = JSON.parse(record) as { video?: string; videoUnavailable?: string };
    assert.equal(before.video, undefined);
    assert.equal(before.videoUnavailable, undefined);

    process.env.FFMPEG = hanging;
    const live = new AgentBrowserRun(homeB);
    await live.recordTab(socket(), "tab");
    await live.endVideoCapture();
    const encoding = live.encodeVideo();
    const started = Date.now() + scaledMs(5000);
    while (!existsSync(pidFile)) {
      assert.ok(Date.now() < started, "encoder started");
      await wait(20);
    }
    pid = Number(await readFile(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(pid, 0));
    abandonVideoOnHostStop();
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(await readFile(path.join(homeA, "runs", `${settled.id}.json`), "utf8"), record);
    assert.equal((await readdir(path.join(homeA, "videos"))).includes(kept[0]!), true);
    await encoding;
    const savedAt = Date.now() + 5000;
    let stopped = new Library(homeB).listRuns()[0]!;
    while (!stopped.video && Date.now() < savedAt) {
      await wait(20);
      stopped = new Library(homeB).listRuns()[0]!;
    }
    assert.equal(stopped.video, `${live.id}.mp4`);
    assert.equal(stopped.videoUnavailable, undefined);
    assert.ok((await stat(path.join(homeB, "videos", `${live.id}.mp4`))).size >= 1000);
    assert.deepEqual((await readdir(path.join(homeB, "videos"))).filter((name) => name.includes(".frames-")), []);
  } finally {
    abandonVideoOnHostStop();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
