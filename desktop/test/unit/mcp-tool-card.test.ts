import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { browserToolResult, type BrowserToolCard } from "../../src/mcp/tool-card";
import { callViewerTool } from "../../src/mcp/viewer-tools";
import { getRun } from "../../src/mcp/catalog";
import { inspectRunView, listRunViews } from "../../src/mcp/run-view";
import { Library } from "../../src/v1/store";
import { viewerHtml } from "../../src/mcp/viewer";
import { testChromium } from "../../src/test-browser";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";

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
    assert.deepEqual(reply.structuredContent.results, native);
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
    await f.recording.complete(f.step, native, f.home, async () => Buffer.concat([png, Buffer.alloc(600 * 1024)]));
    const reply = browserToolResult("click", native, f.evidence);
    assert.doesNotMatch(JSON.stringify(reply), /base64|mimeType/);
    assert.ok(JSON.stringify(reply).length < 2000);
    const read = (phase: string) => callViewerTool(library, "open_browser_picture", { run_id: f.recording.id, step_id: f.step.id, phase });
    const before = read("before");
    assert.ok("baoPictures" in before._meta);
    if ("baoPictures" in before._meta) {
      assert.equal(before._meta.baoPictures.pictures.length, 1);
      assert.deepEqual(Buffer.from(before._meta.baoPictures.pictures[0]!.data, "base64"), png);
      assert.doesNotMatch(JSON.stringify(before.content), new RegExp(png.toString("base64")));
    }
    const after = read("after");
    if ("baoPictures" in after._meta) assert.deepEqual(after._meta.baoPictures.pictures, []);
    assert.throws(() => read("previous"), /Invalid picture phase/);
    assert.throws(() => callViewerTool(library, "open_browser_picture", { run_id: f.recording.id, step_id: "missing", phase: "before" }));
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
    assert.deepEqual(reply.structuredContent.results, failure);
    assert.equal(reply.content[1]?.text, "Target moved");
    assert.equal(reply._meta.baoToolCard.status, "failed");
    const picture = reply._meta.baoToolCard.picture;
    if (picture.kind === "captured") { assert.equal(picture.phase, "after"); assert.equal(picture.target, undefined); }
  } finally { await f.close(); }
});

test("missing pictures never replace the native command result", async () => {
  const f = await recorded();
  try {
    await f.recording.complete(f.step, native, f.home, async () => { throw new Error("no picture"); });
    const reply = browserToolResult("click", native, f.evidence);
    assert.equal(reply.isError, false);
    assert.deepEqual(reply.structuredContent.results, native);
    assert.equal(reply._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("owner waits and close keep live run identity without borrowing a picture", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => png);
    for (const command of ["wait_for_owner", "close"]) {
      const results = command === "close" ? [] : [{ stdout: '{"outcome":"waiting","instruction":"Keep waiting"}', stderr: "", exitCode: 0 }];
      const reply = browserToolResult(command, results, undefined, f.recording.id);
      assert.equal(reply._meta.baoToolCard.picture.kind, "unavailable");
      assert.equal(reply.structuredContent.run_id, f.recording.id);
      assert.deepEqual(reply.structuredContent.results, results);
    }
    const other = browserToolResult("open", [], { ...f.evidence, runId: "different-session", step: { ...f.step, beforeShot: undefined, afterShot: undefined } }, undefined, "startup failed");
    assert.equal(other._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("live proxy keeps run identity across validation and owner-wall returns and clips both screenshot axes", { timeout: 30000 }, async (t) => {
  pinTestBrowser();
  const home = await mkdtemp(path.join(tmpdir(), "bao-card-proxy-"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(home, "profile"), childHome: path.join(home, "user"), headless: true });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const observer = await testChromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
  const page = observer.contexts()[0]!.pages()[0]!;
  await page.setContent('<title>Fixture</title><style>html{background:#000}body{margin:0;width:2400px;height:2400px}::-webkit-scrollbar{width:24px;height:32px}button{position:absolute;left:800px;top:800px;width:40px;height:20px;background:#ff0000;border:0;padding:0}</style><button aria-label="Target"></button>');
  await page.evaluate(() => window.scrollTo(600, 600));
  t.mock.method(profiles, "openCopiedChromeForProxy", async () => ({
    target: { kind: "bao" as const, portFile: chrome.portFile }, closed: chrome.closed,
    bytes: 0, copyMs: 0, isClosed: chrome.isClosed, keepOpen: async () => {}, close: chrome.close,
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
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  try {
    await proxy.execute("open", ["about:blank"], true);
    const runId = proxy.activeRunId;
    assert.ok(runId);
    const results = await proxy.execute("click", ["@e1"], true);
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
      return { width: image.width, height: image.height, center: Array.from(context.getImageData(220 * devicePixelRatio, 210 * devicePixelRatio, 1, 1).data) };
    }, bytes.toString("base64"));
    assert.equal(image.width, viewport.width * viewport.dpr);
    assert.equal(image.height, viewport.height * viewport.dpr);
    assert.ok(image.center[0]! > 240 && image.center[1]! < 20 && image.center[2]! < 20, "the scrolled target is in the marked picture position");
    assert.equal(browserToolResult("click", results, evidence, proxy.activeRunId)._meta.baoToolCard.picture.kind, "captured");
    await assert.rejects(proxy.execute("snapshot", ["--cdp", "forbidden"]));
    assert.equal(proxy.lastCommand, undefined);
    assert.equal(browserToolResult("snapshot", [], proxy.lastCommand, proxy.activeRunId, "validation failed").structuredContent.run_id, runId);
    await page.evaluate(() => { document.title = "Sign in"; });
    const halted = await proxy.execute("snapshot", [], true);
    assert.equal(JSON.parse(halted[0]!.stdout).outcome, "halted");
    const card = browserToolResult("snapshot", halted, proxy.lastCommand, proxy.activeRunId);
    assert.equal(card.structuredContent.run_id, runId);
    assert.equal(card._meta.baoToolCard.picture.kind, "unavailable");
  } finally {
    await proxy.close(); await observer.close(); await chrome.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("capture receipts preserve recording, owner handoff, and finished outcomes without a workflow", async () => {
  const f = await recorded("snapshot");
  try {
    const library = new Library(f.home);
    await f.recording.complete(f.step, native, f.home, async () => png);
    const read = () => getRun(library, f.recording.id);
    assert.equal(read().outcome, "recording");
    assert.equal(read().status, "recording");
    assert.equal(read().link, undefined);
    assert.deepEqual(read().stops, []);
    const view = inspectRunView(library, { run_id: f.recording.id });
    assert.equal(view.run.status, "recording");
    assert.equal(view.workflow, null);
    assert.equal(view.detailsHidden, undefined);
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
    assert.equal(outcome.link, undefined);
  } finally { await failed.close(); }
});

test("the host resource renders an annotated card, keeps it on a failed run read, and opens the exact run", async (t) => {
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 800 } });
  await page.addInitScript(() => {
    window.addEventListener("message", (event) => {
      const msg = event.data as { jsonrpc?: string; method?: string; id?: number; params?: { name?: string; arguments?: unknown } };
      if (event.source !== window || msg.id === undefined || !msg.method) return;
      event.stopImmediatePropagation();
      if (msg.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: msg.id, result: { hostCapabilities: { serverTools: {} }, hostContext: { theme: "light" } } }, "*");
      if (msg.method === "tools/call") document.body.dataset.request = JSON.stringify(msg);
    });
  });
  await page.goto(`data:text/html;base64,${Buffer.from(viewerHtml()).toString("base64")}`);
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const card: BrowserToolCard = { command: "click", status: "complete", caption: "Clicked the requested element.", runId: "run-exact", stepId: "command-5", picture: { kind: "captured", phase: "before", target } };
  const deliver = async (data: unknown) => page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { source: window, data: message })), data);
  await deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card }, structuredContent: { results: native } } });
  await page.getByText("Loading page picture", { exact: true }).waitFor();
  await page.waitForFunction(() => Boolean(document.body.dataset.request));
  const pictureRequest = JSON.parse(await page.locator("body").getAttribute("data-request") || "null") as { id: number; params: { name: string; arguments: unknown } };
  assert.equal(pictureRequest.params.name, "open_browser_picture");
  assert.deepEqual(pictureRequest.params.arguments, { run_id: "run-exact", step_id: "command-5", phase: "before" });
  await deliver({ jsonrpc: "2.0", id: pictureRequest.id, result: { _meta: { baoPictures: { runId: "run-exact", stepId: "command-5", pictures: [{ phase: "before", mimeType: "image/png", data: png.toString("base64") }] } } } });
  await page.getByText("Clicked here", { exact: true }).waitFor();
  await page.evaluate(() => { delete document.body.dataset.request; });
  assert.equal(await page.locator(".browser-mark").evaluate((node) => (node as HTMLElement).style.left), "20%");
  assert.equal(await page.getByText(/ref=e280/).count(), 0);
  assert.match(await page.locator("img").getAttribute("alt") || "", /Before click/);
  await page.getByRole("button", { name: "View run", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.body.dataset.request));
  const request = JSON.parse(await page.locator("body").getAttribute("data-request") || "null") as { id: number; params: { name: string; arguments: { run_id: string } } };
  assert.equal(request.params.name, "inspect_run"); assert.equal(request.params.arguments.run_id, "run-exact");
  await deliver({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ text: "Run read failed" }] } });
  await page.getByRole("alert").filter({ hasText: "Run read failed" }).waitFor();
  await page.getByText("Try View run again.", { exact: false }).waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 1);
  await deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.evaluate(() => { delete document.body.dataset.request; });
  await page.getByRole("button", { name: "View run", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.body.dataset.request));
  const next = JSON.parse(await page.locator("body").getAttribute("data-request") || "null") as { id: number };
  await deliver({ jsonrpc: "2.0", id: next.id, result: { _meta: { baoViewer: { view: "receipt", run: { id: "run-exact", name: "Exact browser session", status: "recording", stepCount: 1, at: 1, modelCalls: null }, steps: [], workflow: null, handoff: null, stepOffset: 0, nextStepOffset: null } } } });
  await page.getByRole("heading", { name: "Exact browser session" }).waitFor();
  assert.equal(await page.locator(".browser-mark").count(), 0);
  await page.evaluate(() => { delete document.body.dataset.request; });
  await deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card } } });
  await page.waitForFunction(() => Boolean(document.body.dataset.request));
  const unavailable = JSON.parse(await page.locator("body").getAttribute("data-request") || "null") as { id: number };
  await deliver({ jsonrpc: "2.0", id: unavailable.id, result: { _meta: { baoPictures: { runId: "run-exact", stepId: "command-5", pictures: [] } } } });
  await page.getByText("Page picture unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator("img").count(), 0);
});
