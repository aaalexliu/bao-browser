import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import * as cdpVideo from "../../src/engines/cdp-video";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { ffmpegBin } from "../../src/v1/replay-video";
import { chromeProfiles } from "../support/chrome-profiles";

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

for (const end of ["tab closes", "CDP disconnects"] as const) test(`tab video follows the agent target and survives when ${end}`, { skip: !ffmpeg, timeout: 30_000 }, async () => {
  const f = await fixture();
  const run = new AgentBrowserRun(path.join(f.root, "home"));
  try {
    const open = async (url: string) => {
      const { targetId } = await f.cdp.send<{ targetId: string }>("Target.createTarget", { url });
      const deadline = Date.now() + 5000;
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
    await run.stopVideo();
    await run.stopVideo();
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
  } finally { await run.stopVideo(); await f.close(); }
});

test("unavailable tab recording does not fail commands or their receipt", { timeout: 30_000 }, async (t) => {
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
    await run.stopVideo();
    run.finish();
    const receipt = new Library(home).listRuns()[0]!;
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.video, undefined);
    assert.ok(Object.hasOwn(receipt.steps[0]!, "afterShot"));
    assert.equal(starts, 1);
  } finally { await f.close(); }
});

test("Running Chrome records the background task without changing the owner tab, and saves video on finish, close and disconnect", { skip: !binary || !ffmpeg, timeout: 90_000 }, async (t) => {
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
    const ownerReady = Date.now() + 5000;
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
        const deadline = Date.now() + 2000;
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
