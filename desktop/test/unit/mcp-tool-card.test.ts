import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { browserToolResult, type BrowserToolCard } from "../../src/mcp/tool-card";
import { viewerHtml } from "../../src/mcp/viewer";
import { testChromium } from "../../src/test-browser";
import { pinTestBrowser } from "../../src/launch";

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
    const reply = await browserToolResult(f.home, "click", native, f.evidence);
    assert.deepEqual(reply.structuredContent.results, native);
    assert.equal(reply.structuredContent.run_id, f.recording.id);
    assert.equal(reply.structuredContent.step_id, f.step.id);
    assert.doesNotMatch(JSON.stringify(reply.content), /ref=e280|button|stdout/);
    assert.doesNotMatch(JSON.stringify(reply.structuredContent), /base64|mimeType/);
    const picture = reply._meta.baoToolCard.picture;
    assert.equal(picture.kind, "captured");
    if (picture.kind === "captured") { assert.equal(picture.phase, "before"); assert.deepEqual(picture.target, target); }
    assert.match(reply.content[0]!.text, /Clicked/);
    assert.doesNotMatch(reply.content[0]!.text, /added|verified|cart shows/i);
  } finally { await f.close(); }
});

test("capture pictures need no workflow and do not inherit the replay viewer's 512 KiB limit", async () => {
  const f = await recorded("snapshot");
  try {
    const large = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
    await f.recording.complete(f.step, native, f.home, async () => large);
    const reply = await browserToolResult(f.home, "snapshot", native, f.evidence);
    const picture = reply._meta.baoToolCard.picture;
    assert.equal(picture.kind, "captured");
    if (picture.kind === "captured") assert.deepEqual(Buffer.from(picture.data, "base64"), large);
  } finally { await f.close(); }
});

test("failed commands do not show a successful target annotation and preserve native errors", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    const failure = [{ stdout: "", stderr: "Target moved", exitCode: 1 }];
    await f.recording.complete(f.step, failure, f.home, async () => png);
    const reply = await browserToolResult(f.home, "click", failure, f.evidence);
    assert.equal(reply.isError, true);
    assert.deepEqual(reply.structuredContent.results, failure);
    assert.equal(reply._meta.baoToolCard.status, "failed");
    const picture = reply._meta.baoToolCard.picture;
    if (picture.kind === "captured") { assert.equal(picture.phase, "after"); assert.equal(picture.target, undefined); }
  } finally { await f.close(); }
});

test("missing pictures never replace the native command result", async () => {
  const f = await recorded();
  try {
    await f.recording.complete(f.step, native, f.home, async () => { throw new Error("no picture"); });
    const reply = await browserToolResult(f.home, "click", native, f.evidence);
    assert.equal(reply.isError, false);
    assert.deepEqual(reply.structuredContent.results, native);
    assert.equal(reply._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
});

test("owner waits and close use a clearly previous picture without carrying the old target", async () => {
  const f = await recorded();
  try {
    await f.recording.actionPicture(f.step, png, target);
    await f.recording.complete(f.step, native, f.home, async () => png);
    const previous = (await browserToolResult(f.home, "click", native, f.evidence))._meta.baoToolCard;
    for (const command of ["wait_for_owner", "close"]) {
      const results = command === "close" ? [] : [{ stdout: '{"outcome":"waiting","instruction":"Keep waiting"}', stderr: "", exitCode: 0 }];
      const reply = await browserToolResult(f.home, command, results, undefined, previous);
      const picture = reply._meta.baoToolCard.picture;
      assert.equal(picture.kind, "captured");
      if (picture.kind === "captured") { assert.equal(picture.phase, "previous"); assert.equal(picture.target, undefined); }
      assert.equal(reply.structuredContent.run_id, f.recording.id);
      assert.deepEqual(reply.structuredContent.results, results);
    }
    const other = await browserToolResult(f.home, "open", [], { ...f.evidence, runId: "different-session", step: { ...f.step, beforeShot: undefined, afterShot: undefined } }, previous, "startup failed");
    assert.equal(other._meta.baoToolCard.picture.kind, "unavailable");
  } finally { await f.close(); }
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
  const card: BrowserToolCard = { command: "click", status: "complete", caption: "Clicked the requested element.", runId: "run-exact", stepId: "command-5", picture: { kind: "captured", phase: "before", mimeType: "image/png", data: png.toString("base64"), target } };
  const deliver = async (data: unknown) => page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { source: window, data: message })), data);
  await deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card }, structuredContent: { results: native } } });
  await page.getByText("Clicked here", { exact: true }).waitFor();
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
});
