import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { navigateWorkflowBrowser, openWorkflowBrowser, ownerPrompts } from "../../src/engines/workflow-browser";
import { EXTENSION_NOT_LINKED } from "../../src/extension/cdp-relay";
import { openRunningChrome, RUNNING_CHROME_NEEDS_APP } from "../../src/extension/running-chrome";
import { pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { ownerChrome, stripWhen, type Strip } from "../support/owner-chrome";

pinTestBrowser();

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b onclick="document.title='Saved '+q.value">Save</button>
<a id=more href="/popup" target=_blank>More</a>`;
const PAGES = { "/task": TASK, "/popup": "<!doctype html><title>Popup</title><h1>Popup</h1>" };

type Targets = { targetInfos: { targetId: string; url: string }[] };

async function evaluate<T>(cdp: CdpSocket, targetId: string, expression: string, userGesture = false): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result } = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId);
    return result.value;
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
}

const active = (strip: Strip) => strip.tabs.find((tab) => tab.active);
const group = (strip: Strip) => strip.groups[0];

test("Bao's tabs open in the background in one collapsed Bao group, and only they are in reach", { timeout: 60_000 }, async (t) => {
  const chrome = await ownerChrome(t, PAGES);
  const before = await chrome.strip();
  assert.deepEqual(before.groups, []);
  assert.equal(active(before)?.id, chrome.ownerTabId);
  const running = await openRunningChrome({ home: chrome.home });
  t.after(() => running.detach());
  const { cdp } = running;
  assert.deepEqual((await cdp.send<Targets>("Target.getTargets")).targetInfos, [], "the owner's tabs are not in Bao's lease");
  await assert.rejects(cdp.send("Target.attachToTarget", { targetId: chrome.ownerTargetId, flatten: true }), /No target/);
  await assert.rejects(cdp.send("Browser.close"), /does not support Browser.close/);

  const task = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${chrome.base}/task` });
  const blank = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  // A new background tab answers page commands at once.
  const { sessionId: fresh } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: blank.targetId, flatten: true });
  for (const method of ["Page.enable", "Runtime.enable", "Page.getFrameTree"]) await cdp.send(method, {}, fresh, 3000);
  await cdp.send("Target.detachFromTarget", { sessionId: fresh });
  let strip = await stripWhen(chrome, (s) => s.tabs.some((tab) => tab.url.endsWith("/task")));
  const bao = group(strip)!;
  assert.deepEqual(strip.groups, [{ id: bao.id, title: "Bao", color: "grey", collapsed: true }]);
  assert.deepEqual(strip.tabs.map((tab) => [tab.groupId === bao.id, tab.active]), [[true, false], [true, false], [false, true]],
    "the group sits first and the owner's tab stays active");
  const taskTab = strip.tabs.find((tab) => tab.url.endsWith("/task"))!.id;
  const blankTab = strip.tabs.find((tab) => tab.groupId === bao.id && tab.id !== taskTab)!.id;

  assert.deepEqual(await evaluate(cdp, task.targetId, "({ title: document.title, visibility: document.visibilityState })"),
    { title: "Task", visibility: "visible" }, "focus emulation keeps the folded tab live");
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: task.targetId, flatten: true });
  await cdp.send("Page.bringToFront", {}, sessionId);
  await cdp.send("Target.activateTarget", { targetId: task.targetId });
  assert.equal(active(await chrome.strip())?.id, chrome.ownerTabId, "a client cannot take the owner's active tab");
  assert.deepEqual(await chrome.ownerEvents(), [], "the owner's page never went hidden or lost focus while Bao worked");

  // A handoff opens the group so the owner can see the tab. His tab stays active; he clicks the Bao tab when ready.
  await cdp.send("Bao.showTab", { targetId: task.targetId });
  strip = await stripWhen(chrome, (s) => group(s)?.collapsed === false);
  assert.equal(group(strip)?.collapsed, false);
  assert.equal(active(strip)?.id, chrome.ownerTabId, "a handoff never switches the owner's tab");
  assert.deepEqual(await chrome.ownerEvents(), [], "a handoff never hides or blurs the owner's page");
  await chrome.ownerClicks(taskTab);
  await chrome.ownerClicks(chrome.ownerTabId);
  strip = await stripWhen(chrome, (s) => active(s)?.id === chrome.ownerTabId);
  assert.equal(group(strip)?.collapsed, false, "the handoff holds the group open");
  await cdp.send("Bao.settleTab", { targetId: task.targetId });
  assert.equal(group(await stripWhen(chrome, (s) => group(s)?.collapsed === true))?.collapsed, true);

  // The owner peeks at a Bao tab: Chrome opens the group, and leaving the tab folds it again.
  await chrome.ownerClicks(blankTab);
  assert.equal(group(await stripWhen(chrome, (s) => group(s)?.collapsed === false))?.collapsed, false);
  await chrome.ownerClicks(chrome.ownerTabId);
  assert.equal(group(await stripWhen(chrome, (s) => group(s)?.collapsed === true))?.collapsed, true);

  // A link a Bao tab opens joins the group and the lease, and the owner keeps his tab.
  await evaluate(cdp, task.targetId, "document.getElementById('more').click()", true);
  strip = await stripWhen(chrome, (s) => s.tabs.some((tab) => tab.url.endsWith("/popup") && tab.groupId === bao.id) && active(s)?.id === chrome.ownerTabId
    && group(s)?.collapsed === true);
  assert.equal(active(strip)?.id, chrome.ownerTabId);
  assert.equal(group(strip)?.collapsed, true);
  const leased = async () => (await cdp.send<Targets>("Target.getTargets")).targetInfos.map((target) => target.url).sort();
  for (let tries = 0; tries < 50 && !(await leased()).some((url) => url.endsWith("/popup")); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await leased(), ["about:blank", `${chrome.base}/popup`, `${chrome.base}/task`]);

  // A tab the owner moves out of the group is his: it leaves the lease and stays open.
  await chrome.inWorker(`chrome.tabs.ungroup(${blankTab}).then(() => undefined)`);
  for (let tries = 0; tries < 50 && (await leased()).includes("about:blank"); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await leased(), [`${chrome.base}/popup`, `${chrome.base}/task`]);

  await cdp.send("Bao.closeTabs");
  strip = await stripWhen(chrome, (s) => s.tabs.length === 2);
  assert.deepEqual(strip.groups, [], "the group goes with Bao's last tab");
  assert.deepEqual(strip.tabs.map((tab) => tab.id).sort(), [chrome.ownerTabId, blankTab].sort(), "only Bao's own tabs close");
  assert.equal(active(strip)?.id, chrome.ownerTabId);
});

test("a lease whose connections all close hands its open tabs to the owner", { timeout: 60_000 }, async (t) => {
  const chrome = await ownerChrome(t, PAGES);
  const running = await openRunningChrome({ home: chrome.home });
  await running.cdp.send("Target.createTarget", { url: `${chrome.base}/task` });
  await stripWhen(chrome, (s) => s.groups.length === 1);
  running.detach();
  const strip = await stripWhen(chrome, (s) => s.groups.length === 0);
  assert.deepEqual(strip.groups, []);
  assert.equal(strip.tabs.length, 2, "the tab stays open, out of the group");
  assert.equal(active(strip)?.id, chrome.ownerTabId);
});

test("Running Chrome explains a missing app or extension", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-running-chrome-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(openRunningChrome({ home: root }), { message: RUNNING_CHROME_NEEDS_APP });
  const app = await startApp({ home: root, extensionHost: true, extensionConfigHome: path.join(root, "native-host") });
  t.after(() => app.close());
  await assert.rejects(openRunningChrome({ home: root }), { message: EXTENSION_NOT_LINKED });
});

for (const ending of ["close", "finish", "disconnect"] as const) test(`the agent route drives a grouped background task tab and closes only Bao's tabs on ${ending}`, { timeout: 60_000 }, async (t) => {
  const chrome = await ownerChrome(t, PAGES);
  const root = await mkdtemp(path.join(tmpdir(), "bao-running-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "native");
  // A stand-in for agent-browser that speaks CDP to the lease endpoint Bao gives it.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
const bound = JSON.parse(fs.readFileSync('bao.target', 'utf8')).targetId;
(async () => {
  const socket = new WebSocket(args[args.indexOf('--cdp') + 1]);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let next = 1;
  socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message.result); };
  const call = (method, params = {}, sessionId) => new Promise(resolve => {
    const id = next++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  if (command === 'open') {
    const { sessionId } = await call('Target.attachToTarget', { targetId: bound, flatten: true });
    await call('Page.navigate', { url: args.at(-1) }, sessionId);
    console.log('native output');
  } else if (command === 'tab' && args.includes('--json')) {
    const { targetInfos } = await call('Target.getTargets');
    console.log(JSON.stringify({ data: { tabs: targetInfos.map(target => ({ targetId: target.targetId, active: target.targetId === bound })) } }));
  } else console.log('native output');
  socket.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 });
  const home = chrome.home;
  const proxy = new AgentBrowserProxy({ home, sourceRoot: root, executable });
  t.after(() => proxy.end());
  assert.equal((await proxy.execute("open", [`${chrome.base}/task`], "current"))[0]!.exitCode, 0);
  let strip = await stripWhen(chrome, (s) => s.tabs.some((tab) => tab.url.endsWith("/task")));
  const task = strip.tabs.find((tab) => tab.url.endsWith("/task"))!;
  assert.deepEqual(strip.groups.map((item) => [item.title, item.collapsed]), [["Bao", true]]);
  assert.equal(task.groupId, group(strip)!.id);
  assert.deepEqual(strip.tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.id), [task.id], "the group holds only the page Bao works on, no blank tab");
  assert.equal(active(strip)?.id, chrome.ownerTabId, "the owner keeps his tab while the agent opens its page");
  assert.equal((await proxy.execute("snapshot"))[0]!.exitCode, 0);

  // A handoff opens the group so the owner can see the task tab, and leaves his own tab active.
  await proxy.execute("wait_for_owner", ["200"]);
  strip = await stripWhen(chrome, (s) => group(s)?.collapsed === false);
  assert.equal(group(strip)?.collapsed, false);
  assert.equal(active(strip)?.id, chrome.ownerTabId, "a handoff never switches the owner's tab");

  if (ending === "finish") await proxy.finishTask({ outcome: "passed", reason: "Task finished." });
  else if (ending === "disconnect") await proxy.end();
  else await proxy.execute("close");
  strip = await stripWhen(chrome, (s) => s.tabs.length === 1);
  assert.deepEqual(strip.tabs.map((tab) => tab.id), [chrome.ownerTabId], "only the task tab closes");
  assert.deepEqual(strip.groups, []);

  const library = new Library(home);
  const [run] = library.listRuns();
  const steps = library.readRun(run!.id).steps as unknown as RecordedAgentBrowserCommand[];
  assert.deepEqual(steps.slice(0, 2).map((step) => step.native.command), ["open", "snapshot"]);
  for (const step of steps.slice(0, 2)) {
    assert.equal(step.status, "passed");
    // Linux Chromium often never answers Page.captureScreenshot for a hidden tab, so there the step records the missing picture.
    if (process.platform !== "darwin" && !step.afterShot) {
      assert.equal(step.afterShotError, "Page screenshot unavailable.");
      continue;
    }
    assert.ok(step.afterShot);
    await access(path.join(home, "shots", "runs", run!.id, step.afterShot));
  }
});

test("a workflow on Running Chrome runs in a grouped background tab, opens the group for a handoff, and closes it", { timeout: 60_000 }, async (t) => {
  const chrome = await ownerChrome(t, PAGES);
  const session = await openWorkflowBrowser({ browser: "current", home: chrome.home, site: `${chrome.base}/task` });
  t.after(() => session.close());
  assert.equal(session.kind, "current");
  await navigateWorkflowBrowser(session, `${chrome.base}/task`);
  await session.page.fill("#q", "Ada");
  await session.page.click("#b");
  assert.equal(await session.page.title(), "Saved Ada");
  let strip = await chrome.strip();
  const task = strip.tabs.find((tab) => tab.url.endsWith("/task"))!;
  assert.deepEqual(strip.groups.map((item) => [item.title, item.collapsed]), [["Bao", true]]);
  assert.equal(task.groupId, group(strip)!.id);
  assert.deepEqual(strip.tabs.filter((tab) => tab.groupId !== -1).map((tab) => tab.id), [task.id], "the group holds only the page Bao works on, no blank tab");
  assert.equal(active(strip)?.id, chrome.ownerTabId);

  const prompts = ownerPrompts(session)!;
  prompts.showAsk!({ kind: "confirm", workflowId: "wf", workflowName: "Save", stepId: "save", stepIndex: 1, stepCount: 1, label: "Save",
    site: "127.0.0.1", windowName: "Task", instruction: "Press Save.", startedAt: 1, deadline: null, timeoutMs: 1000, runId: "run" });
  strip = await stripWhen(chrome, (s) => group(s)?.collapsed === false);
  assert.equal(group(strip)?.collapsed, false);
  assert.equal(active(strip)?.id, chrome.ownerTabId, "a handoff never switches the owner's tab");
  prompts.clearConfirm!("run");
  assert.equal(group(await stripWhen(chrome, (s) => group(s)?.collapsed === true))?.collapsed, true);

  // The owner's own request to see the run brings its tab to the front.
  await session.bringToFront();
  assert.equal(active(await stripWhen(chrome, (s) => active(s)?.id === task.id))?.id, task.id);

  await session.close();
  strip = await stripWhen(chrome, (s) => s.tabs.length === 1);
  assert.deepEqual(strip.tabs.map((tab) => tab.id), [chrome.ownerTabId], "the run's tab closes with the run");
});
