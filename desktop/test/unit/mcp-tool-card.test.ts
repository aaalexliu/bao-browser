import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { browserToolResult, finishToolContent, type BrowserToolCard } from "../../src/mcp/tool-card";
import { callViewerTool } from "../../src/mcp/viewer-tools";
import { getRun } from "../../src/mcp/catalog";
import { BROWSER_PICTURE_BYTES, finishCardFor, inspectRunView, listRunViews } from "../../src/mcp/run-view";
import { Library } from "../../src/v1/store";
import { viewerHtml } from "../../src/mcp/viewer";
import { testChromium } from "../../src/test-browser";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";
import { consolePane, runConsoleLines, type RunSummary } from "../../src/app/views";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=", "base64");
const native = [{ stdout: '- button "Add blueberries" [ref=e280]\n', stderr: "", exitCode: 0 }];
const target = { rect: { x: 20, y: 60, width: 40, height: 20 }, viewport: { width: 100, height: 100 } };

async function recorded(command = "click") {
  const home = await mkdtemp(path.join(tmpdir(), "bao-tool-card-"));
  const recording = new AgentBrowserRun(home);
  const step = recording.begin(command, ["@e280"]);
  return { home, recording, step, evidence: { runId: recording.id, step }, close: () => rm(home, { recursive: true, force: true }) };
}

test("browser card keeps exact native refs for the model and the target frame for the person", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => png);
    const reply = browserToolResult("click", native, f.evidence);
    assert.deepEqual(reply.structuredContent, { command: "click", status: "complete", run_id: f.recording.id, step_id: f.step.id });
    assert.deepEqual(JSON.parse(reply.content.at(-1)!.text), { run_id: f.recording.id, step_id: f.step.id });
    assert.equal(reply.structuredContent.run_id, f.recording.id);
    assert.equal(reply.structuredContent.step_id, f.step.id);
    assert.equal(reply.content[1]?.text, native[0]!.stdout);
    assert.doesNotMatch(JSON.stringify(reply), /base64|mimeType/);
    assert.doesNotMatch(JSON.stringify(reply.structuredContent), /base64|mimeType/);
    const picture = reply._meta.baoToolCard.picture;
    assert.equal(picture.kind, "captured");
    if (picture.kind === "captured") { assert.equal(picture.phase, "before"); assert.deepEqual(picture.target, target); }
    assert.match(reply.content[0]!.text, /Clicked/);
    assert.doesNotMatch(reply.content[0]!.text, /added|verified|cart shows/i);
  } finally { await f.close(); }
});

test("capture cards fetch only their own frame through the bounded app reader", async () => {
  const f = await recorded();
  try {
    const library = new Library(f.home);
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]));
    const reply = browserToolResult("click", native, f.evidence);
    assert.doesNotMatch(JSON.stringify(reply), /base64|mimeType/);
    assert.ok(JSON.stringify(reply).length < 2000);
    const read = (phase: string) => callViewerTool(library, "open_browser_picture", { run_id: f.recording.id, step_id: f.step.id, phase });
    const before = read("before");
    assert.ok(before._meta.baoPictures);
    assert.equal(before._meta.baoPictures.pictures.length, 1);
    assert.deepEqual(Buffer.from(before._meta.baoPictures.pictures[0]!.data, "base64"), png);
    assert.doesNotMatch(JSON.stringify(before.content), new RegExp(png.toString("base64")));
    const after = read("after");
    assert.ok(after._meta.baoPictures);
    assert.deepEqual(after._meta.baoPictures.pictures, []);
    assert.throws(() => read("previous"), /Invalid picture phase/);
    const missing = callViewerTool(library, "open_browser_picture", { run_id: f.recording.id, step_id: "missing", phase: "before" });
    assert.ok(missing._meta.baoPictures);
    assert.deepEqual(missing._meta.baoPictures.pictures, []);
  } finally { await f.close(); }
});

test("failed commands do not show a successful target annotation and preserve native errors", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    const failure = [{ stdout: "", stderr: "Target moved", exitCode: 1 }];
    await f.recording.complete(f.step, failure, f.home, async () => png);
    const reply = browserToolResult("click", failure, f.evidence);
    assert.equal(reply.isError, true);
    assert.equal(Object.hasOwn(reply.structuredContent, "results"), false);
    assert.equal(reply.content[1]?.text, "Target moved");
    assert.equal(reply._meta.baoToolCard.status, "failed");
    const picture = reply._meta.baoToolCard.picture;
    if (picture.kind === "captured") { assert.equal(picture.phase, "after"); assert.equal(picture.target, undefined); }
  } finally { await f.close(); }
});

test("desktop Console projects native capture output without duplicating storage", async () => {
  const f = await recorded("snapshot");
  try {
    await f.recording.complete(f.step, native, f.home, async () => png);
    const click = f.recording.begin("click", ["@e280"]);
    await f.recording.complete(click, [{ stdout: "Click attempted", stderr: "Target moved", exitCode: 1 }], f.home, async () => png);
    const stored = new Library(f.home).readRun(f.recording.id);
    assert.equal(Object.hasOwn(stored, "console"), false);
    const run = stored as unknown as RunSummary;
    const lines = runConsoleLines(run);
    assert.deepEqual(lines, [
      { stepId: f.step.id, type: "stdout", text: native[0]!.stdout, ts: f.step.endedAt },
      { stepId: click.id, type: "stdout", text: "Click attempted", ts: click.endedAt },
      { stepId: click.id, type: "stderr", text: "Target moved", ts: click.endedAt },
    ]);
    const selected = consolePane(lines, click.id);
    assert.match(selected, /Click attempted/);
    assert.match(selected, /stderr/);
    assert.match(selected, /Target moved/);
    assert.doesNotMatch(selected, /Add blueberries|No console lines were captured/);
    const first = consolePane(lines, f.step.id);
    assert.match(first, /Add blueberries/);
    assert.doesNotMatch(first, /Target moved/);
    assert.match(consolePane(lines), /Target moved/);
    const oldLines = [{ stepId: "old", type: "info", text: "Existing page console" }];
    assert.equal(runConsoleLines({ ...run, kind: "replay", console: oldLines }), oldLines);
    assert.equal(runConsoleLines({ ...run, pageEngine: "old", console: oldLines }), oldLines);
    assert.deepEqual(runConsoleLines({ ...run, console: oldLines }), lines);
  } finally { await f.close(); }
});

test("missing pictures never replace the native command result", async () => {
  const f = await recorded();
  try {
    await f.recording.complete(f.step, native, f.home, async () => { throw new Error("no picture"); });
    const reply = browserToolResult("click", native, f.evidence);
    assert.equal(reply.isError, false);
    assert.equal(reply.content[1]?.text, native[0]!.stdout);
    assert.equal(reply._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("owner waits and calls without picture evidence keep run identity without borrowing another run's picture", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => png);
    for (const command of ["wait_for_owner", "close"]) {
      const results = command === "close" ? [] : [{ stdout: '{"outcome":"waiting","instruction":"Keep waiting"}', stderr: "", exitCode: 0 }];
      const reply = browserToolResult(command, results, undefined, f.recording.id);
      assert.equal(reply._meta.baoToolCard.picture.kind, "unavailable");
      assert.equal(reply.structuredContent.run_id, f.recording.id);
      assert.deepEqual(JSON.parse(reply.content.at(-1)!.text), { run_id: f.recording.id, step_id: null });
      if (results.length) assert.equal(reply.content[1]?.text, results[0]!.stdout);
    }
    const other = browserToolResult("open", [], { ...f.evidence, runId: "different-session", step: { ...f.step, beforeShot: undefined, afterShot: undefined } }, undefined, "startup failed");
    assert.equal(other._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("close cards keep the last same-run picture and the closing command's identity", async () => {
  const f = await recorded("open");
  try {
    const readLastPicture = () => f.recording.lastPicture;
    assert.equal(readLastPicture(), undefined);
    await f.recording.complete(f.step, native, f.home, async () => png);
    const latest = f.recording.begin("snapshot", []);
    await f.recording.complete(latest, native, f.home, async () => png);
    const close = f.recording.begin("close", []);
    await f.recording.complete(close, [], f.home, async () => { throw new Error("closed"); });
    f.recording.finish();
    const lastPicture = readLastPicture();
    assert.ok(lastPicture);
    assert.deepEqual(lastPicture, { stepId: latest.id, phase: "after" });
    const result = browserToolResult("close", [], { runId: f.recording.id, step: close, lastPicture });
    assert.deepEqual(result.structuredContent, { command: "close", status: "complete", run_id: f.recording.id, step_id: close.id });
    assert.deepEqual(result._meta.baoToolCard.picture, { kind: "captured", stepId: latest.id, phase: "after" });
    const pictures = callViewerTool(new Library(f.home), "open_browser_picture", { run_id: f.recording.id, step_id: lastPicture.stepId, phase: lastPicture.phase });
    assert.ok(pictures._meta.baoPictures);
    assert.deepEqual(Buffer.from(pictures._meta.baoPictures.pictures[0]!.data, "base64"), png);
    assert.doesNotMatch(JSON.stringify(result), /base64|mimeType/);
    const other = new AgentBrowserRun(f.home);
    const otherClose = other.begin("close", []);
    await other.complete(otherClose, [], f.home, async () => { throw new Error("no page"); });
    assert.equal(browserToolResult("close", [], { runId: other.id, step: otherClose, lastPicture: other.lastPicture })._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("close ignores native screenshot copies when the automatic page capture fails", async () => {
  const f = await recorded("open");
  try {
    await f.recording.complete(f.step, native, f.home, async () => png);
    const screenshot = f.recording.begin("screenshot", []);
    await writeFile(path.join(f.home, "page.png"), png);
    await f.recording.complete(screenshot, [{ stdout: "Screenshot saved to page.png", stderr: "", exitCode: 0 }], f.home, async () => { throw new Error("capture failed"); });
    assert.equal(screenshot.native.screenshots.length, 1);
    const close = f.recording.begin("close", []);
    await f.recording.complete(close, [], f.home, async () => { throw new Error("closed"); });
    const result = browserToolResult("close", [], { runId: f.recording.id, step: close, lastPicture: f.recording.lastPicture });
    assert.deepEqual(result._meta.baoToolCard.picture, { kind: "captured", stepId: f.step.id, phase: "after" });
    assert.throws(() => callViewerTool(new Library(f.home), "open_browser_picture", { run_id: f.recording.id, step_id: screenshot.id, phase: "requested" }), /Invalid picture phase/);
  } finally { await f.close(); }
});

test("close can use an earlier step picture when later captures fail without carrying its target mark", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => { throw new Error("capture failed"); });
    const latest = f.recording.begin("snapshot", []);
    await f.recording.complete(latest, native, f.home, async () => { throw new Error("capture failed"); });
    const close = f.recording.begin("close", []);
    await f.recording.complete(close, [], f.home, async () => { throw new Error("closed"); });
    const result = browserToolResult("close", [], { runId: f.recording.id, step: close, lastPicture: f.recording.lastPicture });
    assert.deepEqual(result._meta.baoToolCard.picture, { kind: "captured", stepId: f.step.id, phase: "before" });
  } finally { await f.close(); }
});

test("live proxy keeps run identity across validation and owner-wall returns and clips both screenshot axes", { timeout: 30000 }, async (t) => {
  pinTestBrowser();
  const home = await mkdtemp(path.join(tmpdir(), "bao-card-proxy-"));
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let observer: Awaited<ReturnType<typeof testChromium.connectOverCDP>> | undefined;
  let proxy: AgentBrowserProxy | undefined;
  t.after(async () => {
    try { await proxy?.close(); }
    finally {
      try { await observer?.close(); }
      finally {
        try { await chrome?.close(); }
        finally { await rm(home, { recursive: true, force: true }); }
      }
    }
  });
  chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(home, "profile"), childHome: path.join(home, "user"), headless: true, args: ["--force-device-scale-factor=2"] });
  const { portFile, closed, isClosed, close } = chrome;
  const endpoint = await readDevToolsActivePort(portFile);
  observer = await testChromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
  const page = observer.contexts()[0]!.pages()[0]!;
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1200, deviceScaleFactor: 2, mobile: false });
  await page.setContent('<!doctype html><title>Fixture</title><style>html{background:#000}body{margin:0;width:4000px;height:4000px}::-webkit-scrollbar{width:24px;height:32px}canvas{position:absolute;left:0;top:0}button{position:absolute;left:800px;top:800px;width:40px;height:20px;background:#ff0000;border:0;padding:0}</style><canvas width="2800" height="2200"></canvas><button aria-label="Target"></button>');
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(canvas.width, canvas.height);
    let seed = 12345;
    for (let i = 0; i < image.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        image.data[i + channel] = seed & 255;
      }
      image.data[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    window.scrollTo(600, 600);
  });
  t.mock.method(profiles, "openCopiedChromeForProxy", async () => ({
    target: { kind: "bao" as const, portFile }, closed,
    bytes: 0, copyMs: 0, isClosed, keepOpen: async () => {}, close,
  }));
  const executable = path.join(home, "native");
  await writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2), command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
(async()=>{
 if(command==='tab') {
  const tabs=(await (await fetch('http://'+endpoint.host+'/json/list')).json()).filter(t=>t.type==='page');
  console.log(JSON.stringify({data:{tabs:tabs.map((t,i)=>({targetId:t.id,url:t.url,title:t.title,active:i===0}))}}));
 } else if(command==='get') console.log(JSON.stringify({data:{x:200,y:200,width:40,height:20}}));
 else console.log(command+' native output');
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });
  const sourceRoot = path.join(home, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  await proxy.execute("open", ["about:blank"], "copy", true);
  const runId = proxy.activeRunId;
  assert.ok(runId);
  const results = await proxy.execute("click", ["@e1"], undefined, true);
  const evidence = proxy.lastCommand!;
  assert.deepEqual(evidence.step.target?.rect, { x: 200, y: 200, width: 40, height: 20 });
  const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, innerWidth, innerHeight, dpr: devicePixelRatio }));
  assert.ok(viewport.width < viewport.innerWidth);
  assert.ok(viewport.height < viewport.innerHeight);
  assert.deepEqual(evidence.step.target?.viewport, { width: viewport.width, height: viewport.height });
  const bytes = await readFile(path.join(home, "shots", "runs", runId, evidence.step.beforeShot!));
  const image = await page.evaluate(async (data) => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${data}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, center: Array.from(context.getImageData(220, 210, 1, 1).data) };
  }, bytes.toString("base64"));
  assert.equal(viewport.dpr, 2);
  assert.equal(image.width, viewport.width);
  assert.equal(image.height, viewport.height);
  const library = new Library(home);
  let largest = 0;
  for (const phase of ["before", "after"]) {
    const reply = callViewerTool(library, "open_browser_picture", { run_id: runId, step_id: evidence.step.id, phase });
    assert.ok(reply._meta.baoPictures);
    assert.equal(reply._meta.baoPictures.pictures.length, 1);
    const picture = reply._meta.baoPictures.pictures[0]!;
    const captured: Buffer = await readFile(path.join(home, "shots", "runs", runId, phase === "before" ? evidence.step.beforeShot! : evidence.step.afterShot!));
    assert.deepEqual(Buffer.from(picture.data, "base64"), captured);
    largest = Math.max(largest, captured.length);
  }
  assert.ok(largest > 512 * 1024, "the photo-heavy fixture exceeds the old reader budget");
  assert.ok(BROWSER_PICTURE_BYTES > largest);
  assert.equal(BROWSER_PICTURE_BYTES, 2 * 1024 * 1024);
  assert.ok(image.center[0]! > 240 && image.center[1]! < 20 && image.center[2]! < 20, "the scrolled target is in the marked picture position");
  assert.equal(browserToolResult("click", results, evidence, proxy.activeRunId)._meta.baoToolCard.picture.kind, "captured");
  await page.evaluate(() => { document.querySelector("canvas")!.remove(); });
  await proxy.execute("click", ["@e1"], undefined, true);
  const plain = proxy.lastCommand!;
  const sharp: Buffer = await readFile(path.join(home, "shots", "runs", runId, plain.step.beforeShot!));
  const size = await page.evaluate(async (data) => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${data}`; await image.decode();
    return { width: image.width, height: image.height };
  }, sharp.toString("base64"));
  assert.deepEqual(size, { width: viewport.width * 2, height: viewport.height * 2 }, "a plain page keeps its device pixels on a 2x screen");
  assert.deepEqual(plain.step.target?.viewport, { width: viewport.width, height: viewport.height }, "boxes stay in CSS pixels");
  await assert.rejects(proxy.execute("snapshot", ["--cdp", "forbidden"]));
  assert.equal(proxy.lastCommand, undefined);
  assert.equal(browserToolResult("snapshot", [], proxy.lastCommand, proxy.activeRunId, "validation failed").structuredContent.run_id, runId);
  await page.evaluate(() => { document.title = "Sign in"; });
  const halted = await proxy.execute("snapshot", [], undefined, true);
  const handoff = JSON.parse(halted[0]!.stdout) as { outcome: string };
  assert.equal(handoff.outcome, "halted");
  const card = browserToolResult("snapshot", halted, proxy.lastCommand, proxy.activeRunId);
  assert.equal(card.structuredContent.run_id, runId);
  assert.equal(card._meta.baoToolCard.picture.kind, "unavailable");
});

test("capture receipts preserve recording, owner handoff, and finished outcomes without a workflow", async () => {
  const f = await recorded("snapshot");
  try {
    const library = new Library(f.home);
    await f.recording.complete(f.step, native, f.home, async () => png);
    const read = () => getRun(library, f.recording.id);
    assert.equal(read().outcome, "recording");
    assert.equal(read().status, "recording");
    assert.equal(read().link, `bao://receipt/${f.recording.id}`);
    assert.deepEqual(read().stops, []);
    const view = inspectRunView(library, { run_id: f.recording.id });
    assert.equal(view.run.status, "recording");
    assert.equal(view.workflow, null);
    assert.equal(view.steps[0]?.picturesAllowed, true);
    assert.equal(listRunViews(library, {}).runs[0]?.status, "recording");
    f.recording.ownerWaiting(true);
    assert.equal(read().outcome, "needs_human");
    const waiting = inspectRunView(library, { run_id: f.recording.id });
    assert.equal(waiting.reason, "owner_signin");
    assert.match(waiting.handoff?.ask || "", /waiting for you/);
    f.recording.ownerWaiting(false);
    f.recording.finish();
    assert.equal(read().outcome, "ok");
    assert.equal(inspectRunView(library, { run_id: f.recording.id }).run.status, "passed");
  } finally { await f.close(); }
  const failed = await recorded();
  try {
    await failed.recording.complete(failed.step, [], failed.home, async () => png, new Error("Native command failed"));
    failed.recording.finish();
    const outcome = getRun(new Library(failed.home), failed.recording.id);
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, "Native command failed");
    assert.equal(outcome.link, `bao://receipt/${failed.recording.id}`);
  } finally { await failed.close(); }
});

test("oversized replay records fail the size check before JSON parsing in both receipt readers", async () => {
  const f = await recorded("snapshot");
  try {
    const library = new Library(f.home);
    const replay = { ...library.readRun(f.recording.id), kind: "replay" };
    const json = Buffer.from(JSON.stringify(replay));
    const padded = Buffer.concat([json, Buffer.alloc(2 * 1024 * 1024 + 1 - json.length)]);
    await writeFile(path.join(f.home, "runs", `${f.recording.id}.json`), padded);
    assert.throws(() => inspectRunView(library, { run_id: f.recording.id }), /too large/);
    assert.throws(() => callViewerTool(library, "open_step_pictures", { run_id: f.recording.id, step_id: f.step.id }), /too large/);
  } finally { await f.close(); }
});

test("large captures retain native output once and keep exact-run inspection and card pictures usable", async () => {
  const f = await recorded("snapshot");
  try {
    const library = new Library(f.home);
    const stdout = '- button "Large page" [ref=e900]\n' + "page content ".repeat(250000);
    const results = [{ stdout, stderr: "native diagnostic", exitCode: 0 }];
    await f.recording.complete(f.step, results, f.home, async () => png);
    const file = path.join(f.home, "runs", `${f.recording.id}.json`);
    assert.ok((await readFile(file)).length > 2 * 1024 * 1024);
    const saved = library.readRun(f.recording.id);
    const step = saved.steps[0] as unknown as { native: { results: typeof results } };
    assert.deepEqual(step.native.results, results);
    assert.equal(Object.hasOwn(saved, "console"), false);
    const view = inspectRunView(library, { run_id: f.recording.id });
    assert.equal(view.run.id, f.recording.id);
    assert.equal(view.run.status, "recording");
    assert.equal(view.steps[0]?.picturesAllowed, true);
    assert.ok(JSON.stringify(view).length < 4000);
    assert.equal(getRun(library, f.recording.id).outcome, "recording");
    const receiptPictures = callViewerTool(library, "open_step_pictures", { run_id: f.recording.id, step_id: f.step.id });
    assert.ok(receiptPictures._meta.baoPictures);
    assert.equal(receiptPictures._meta.baoPictures.pictures.length, 1);
    await rm(file);
    const direct = callViewerTool(library, "open_browser_picture", { run_id: f.recording.id, step_id: f.step.id, phase: "after" });
    assert.ok(direct._meta.baoPictures);
    assert.deepEqual(Buffer.from(direct._meta.baoPictures.pictures[0]!.data, "base64"), png);
  } finally { await f.close(); }
});

test("recording captures do not present recovered failures as current stops", async () => {
  const f = await recorded();
  try {
    const library = new Library(f.home);
    await f.recording.complete(f.step, [{ stdout: "", stderr: "Target moved", exitCode: 1 }], f.home, async () => png);
    const recovered = f.recording.begin("snapshot", []);
    await f.recording.complete(recovered, native, f.home, async () => png);
    const outcome = getRun(library, f.recording.id);
    assert.equal(outcome.outcome, "recording");
    assert.equal(outcome.reason, undefined);
    assert.equal(outcome.step, undefined);
    assert.equal(outcome.ask, undefined);
    assert.deepEqual(outcome.stops, []);
    const view = inspectRunView(library, { run_id: f.recording.id });
    assert.equal(view.run.status, "recording");
    assert.equal(view.reason, undefined);
    assert.equal(view.handoff, null);
    assert.equal(view.steps[0]?.reason, "Native agent-browser command failed.");
    f.recording.ownerWaiting(true);
    assert.equal(getRun(library, f.recording.id).reason, "owner_signin");
    assert.equal(inspectRunView(library, { run_id: f.recording.id }).reason, "owner_signin");
    f.recording.ownerWaiting(false);
    assert.equal(getRun(library, f.recording.id).ask, undefined);
    assert.equal(inspectRunView(library, { run_id: f.recording.id }).reason, undefined);
    f.recording.finish();
    assert.equal(getRun(library, f.recording.id).outcome, "failed");
    assert.equal(inspectRunView(library, { run_id: f.recording.id }).reason, "Native agent-browser command failed.");
  } finally { await f.close(); }
});


type HostRequest = { id: number; params: { name: string; arguments: Record<string, unknown> } };

async function mountViewer(page: Page, hostContext: object): Promise<void> {
  await page.addInitScript((context) => {
    const host = window as unknown as { baoRequests: unknown[] };
    host.baoRequests = [];
    window.addEventListener("message", (event) => {
      const msg = event.data as { method?: string; id?: number };
      if (event.source !== window || msg.id === undefined || !msg.method) return;
      event.stopImmediatePropagation();
      if (msg.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: msg.id, result: { hostCapabilities: { serverTools: {} }, hostContext: context } }, "*");
      if (msg.method === "tools/call") host.baoRequests.push(msg);
    });
  }, hostContext);
  await page.goto(`data:text/html;base64,${Buffer.from(viewerHtml()).toString("base64")}`);
  await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
}

async function hostRequests(page: Page, count: number): Promise<HostRequest[]> {
  await page.waitForFunction((size) => (window as unknown as { baoRequests: unknown[] }).baoRequests.length >= size, count);
  return page.evaluate(() => (window as unknown as { baoRequests: HostRequest[] }).baoRequests);
}

async function hostDeliver(page: Page, data: unknown): Promise<void> {
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { source: window, data: message })), data);
}

test("the host resource renders a step card from result metadata, keeps it on a failed run read, and opens the exact run", async (t) => {
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 800 } });
  await mountViewer(page, { theme: "light" });
  const card: BrowserToolCard = { command: "click", status: "complete", style: "frame", caption: 'Clicked "Add blueberries" (button).',
    parts: ["Clicked ", { cite: "Add blueberries" }, " (button)"], mark: "Clicked", runId: "run-exact", stepId: "command-5", picture: { kind: "captured", phase: "before", target } };
  const picture = { main: { mimeType: "image/png", data: png.toString("base64") } };
  await hostDeliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card }, structuredContent: { command: "click", status: "complete", run_id: "run-exact", step_id: "command-5" } } });
  await page.getByText("Loading page picture", { exact: true }).waitFor();
  const first = (await hostRequests(page, 1))[0]!;
  assert.equal(first.params.name, "open_browser_card");
  assert.deepEqual(first.params.arguments, { run_id: "run-exact", step_id: "command-5" });
  await hostDeliver(page, { jsonrpc: "2.0", id: first.id, result: { _meta: { baoToolCard: card, baoCardPictures: picture } } });
  await page.locator("figcaption").getByText("Clicked", { exact: true }).waitFor();
  assert.equal(await page.locator(".browser-mark").evaluate((node) => (node as HTMLElement).style.left), "20%");
  assert.equal(await page.locator(".browser-mark").textContent(), "", "no label sits on the page picture");
  assert.equal(await page.locator("figcaption").textContent(), "Clicked · Before click");
  assert.equal(await page.locator(".browser-caption q.cite").textContent(), "Add blueberries");
  assert.equal(await page.getByText(/ref=e280/).count(), 0);
  assert.match(await page.locator("img").getAttribute("alt") || "", /Before click/);
  assert.equal(await page.locator("header .muted").textContent(), "Step 5 · click");

  await page.getByRole("button", { name: "View run", exact: true }).click();
  const inspect = (await hostRequests(page, 2))[1]!;
  assert.equal(inspect.params.name, "inspect_run"); assert.equal(inspect.params.arguments.run_id, "run-exact");
  await hostDeliver(page, { jsonrpc: "2.0", id: inspect.id, result: { isError: true, content: [{ text: "Run read failed" }] } });
  await page.getByRole("alert").filter({ hasText: "Run read failed" }).waitFor();
  await page.getByText("Try View run again.", { exact: false }).waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 1);
  await hostDeliver(page, { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.getByRole("button", { name: "View run", exact: true }).click();
  const next = (await hostRequests(page, 3))[2]!;
  await hostDeliver(page, { jsonrpc: "2.0", id: next.id, result: { _meta: { baoViewer: { view: "receipt", run: { id: "run-exact", name: "Exact browser session", status: "recording", stepCount: 1, at: 1, modelCalls: null }, steps: [], workflow: null, handoff: null, stepOffset: 0, nextStepOffset: null } } } });
  await page.getByRole("heading", { name: "Exact browser session" }).waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 0);

  await hostDeliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card } } });
  const unavailable = (await hostRequests(page, 4))[3]!;
  await hostDeliver(page, { jsonrpc: "2.0", id: unavailable.id, result: { _meta: { baoToolCard: card, baoCardPictures: {} } } });
  await page.getByText("Page picture unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator("img").count(), 0);

  const closedCard: BrowserToolCard = { command: "close", status: "complete", style: "frame", caption: "Closed the Bao browser window.", parts: ["Closed the Bao browser window"],
    runId: "run-exact", stepId: "command-6", picture: { kind: "captured", stepId: "command-5", phase: "before" } };
  await hostDeliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: closedCard } } });
  const closed = (await hostRequests(page, 5))[4]!;
  assert.deepEqual(closed.params.arguments, { run_id: "run-exact", step_id: "command-6" });
  await hostDeliver(page, { jsonrpc: "2.0", id: closed.id, result: { _meta: { baoToolCard: closedCard, baoCardPictures: picture } } });
  await page.getByAltText("Last recorded page: Closed the Bao browser window.").waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 0);
  assert.equal(await page.getByRole("button", { name: "View run", exact: true }).count(), 1);
  assert.equal(await page.getByText("Page picture unavailable", { exact: true }).count(), 0);
});

test("a host that forwards only content and isError still draws each step's card, never run history", async (t) => {
  // Claude Desktop sends an MCP App only content and isError, so every Bao step used to fall back to Run history.
  const f = await recorded("snapshot");
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(async () => { await browser.close(); await f.close(); });
  const library = new Library(f.home);
  const cart = { url: "https://shop.example/cart", title: "Cart" };
  await f.recording.complete(f.step, native, f.home, async () => png, undefined, false, { page: cart });
  const click = f.recording.begin("click", ["@e280"]);
  await f.recording.actionPicture(click, png, target);
  const clicked = [{ stdout: "✓ Done\n", stderr: "", exitCode: 0 }];
  await f.recording.complete(click, clicked, f.home, async () => png, undefined, false, { page: cart });
  const missed = f.recording.begin("click", ["@e9"]);
  const unknown = [{ stdout: "", stderr: "✗ Unknown ref: e9\n", exitCode: 1 }];
  await f.recording.complete(missed, unknown, f.home, async () => png, undefined, false, { page: cart });
  const wait = f.recording.begin("wait_for_owner", ["60000"]);
  const waiting = [{ stdout: JSON.stringify({ outcome: "waiting", instruction: "Keep waiting" }), stderr: "", exitCode: 0 }];
  await f.recording.complete(wait, waiting, f.home, async () => png, undefined, true, { owner: { url: "https://shop.example/signin", title: "Sign in to Shop" } });
  f.recording.finish({ outcome: "passed", reason: "Added blueberries to the cart.", done: ["Added blueberries"] });
  const steps = f.recording.steps;
  const results = [
    browserToolResult("click", clicked, { runId: f.recording.id, step: click, steps }),
    browserToolResult("click", unknown, { runId: f.recording.id, step: missed, steps }),
    browserToolResult("wait_for_owner", waiting, { runId: f.recording.id, step: wait, steps }),
  ];
  assert.equal(results[0]!.content[0]!.text, 'Clicked "Add blueberries" (button).');
  assert.equal(results[1]!.content[0]!.text, "Could not click the element.");
  assert.deepEqual(results[1]!.content.slice(1, -1).map((block) => block.text), ["✗ Unknown ref: e9\n"], "the native error appears once, after the sentence");
  assert.match(results[2]!.content[0]!.text, /^Your turn: sign in to shop\.example in Bao's Chrome window\. The page is "Sign in to Shop"/);

  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
  await mountViewer(page, { theme: "light" });
  const answer = async (index: number) => {
    const request = (await hostRequests(page, index + 1))[index]!;
    assert.equal(request.params.name, "open_browser_card");
    await hostDeliver(page, { jsonrpc: "2.0", id: request.id, result: callViewerTool(library, request.params.name, request.params.arguments) });
  };
  const forward = (result: { content: unknown; isError: boolean }) => hostDeliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: result.content, isError: result.isError } });

  await forward(results[0]!);
  assert.equal(await page.locator(".browser-caption").textContent(), 'Clicked "Add blueberries" (button).');
  await answer(0);
  await page.locator("figcaption").getByText("Clicked", { exact: true }).waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 1);
  assert.equal(await page.locator(".browser-caption q.cite").textContent(), "Add blueberries");
  assert.equal(await page.locator("header .muted").textContent(), `Step 2 · click`);

  await forward(results[1]!);
  await answer(1);
  await page.getByText("Last seen", { exact: true }).waitFor();
  await page.getByText("Now", { exact: true }).waitFor();
  assert.equal(await page.locator(".browser-error").textContent(), "✗ Unknown ref: e9");
  assert.equal(await page.locator(".browser-mark").count(), 0, "no last-seen box without a measured target");
  assert.equal(await page.locator(".browser-status").textContent(), "Failed");

  await forward(results[2]!);
  await answer(2);
  await page.locator(".browser-wait").getByText("Sign in to Shop", { exact: true }).waitFor();
  assert.equal(await page.locator(".browser-status").textContent(), "Waiting for you");
  assert.equal(await page.locator("img").count(), 0);

  const card = finishCardFor(library, f.recording.id);
  await forward({ content: finishToolContent(card, { run_id: f.recording.id, status: "passed" }, true), isError: false });
  await answer(3);
  await page.locator(".browser-done").getByText("Added blueberries", { exact: true }).waitFor();
  assert.equal(await page.locator(".browser-status").textContent(), "Passed");

  await page.waitForTimeout(700);
  const names = (await hostRequests(page, 4)).map((request) => request.params.name);
  assert.deepEqual(names, ["open_browser_card", "open_browser_card", "open_browser_card", "open_browser_card"]);
  assert.equal(await page.getByRole("heading", { name: "Run history" }).count(), 0);
});
