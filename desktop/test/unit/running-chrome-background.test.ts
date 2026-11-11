import assert from "node:assert/strict";
import test from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { pinTestBrowser } from "../../src/launch";
import { runWorkflow } from "../../src/mcp/catalog";
import type { WorkflowStep } from "../../src/v1/schema";
import { targetFor, testWorkflow } from "../support/workflow";
import { ownerChrome, stripWhen, type OwnerChrome, type Strip } from "../support/owner-chrome";
import { scaledMs } from "../runtime";

pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
// Replay takes page pictures, and Linux Chromium never answers Page.captureScreenshot for a background tab.
const replaySkip = process.platform !== "darwin" && "replay pictures of a background tab hang on Linux Chromium";

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><p id=out>not clicked</p>
<script>let frames=0;(function f(){frames++;requestAnimationFrame(f)})();b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

const target = (id: string, role: string) => targetFor({ surface: "dom", role, id, path: [] });
const FILL: WorkflowStep = { id: "fill", index: 0, action: "type", caption: { text: "Fill name" }, heal: "never", text: { literal: "Ada" }, target: target("q", "textbox"), timeoutMs: 5000 };
const SAVE: WorkflowStep = { id: "save", index: 0, action: "click", caption: { text: "Save" }, heal: "never", target: target("b", "button"),
  check: { kind: "text", match: "clicked, typed: Ada", timeoutMs: 5000 }, timeoutMs: 5000 };
const HOLD: WorkflowStep = { id: "apply", index: 0, action: "handoff", reason: "owner-press", caption: { text: "Confirm before Save" }, target: target("b", "button"),
  check: { kind: "text", match: "never", timeoutMs: 1000 }, timeoutMs: 1000 };

/** The held tab is visible in an open Bao group, and the owner's own tab is still the active one. */
const shown = (chrome: OwnerChrome) => (strip: Strip) => strip.tabs.find((tab) => tab.active)?.id === chrome.ownerTabId
  && strip.tabs.some((tab) => tab.url.endsWith("/task") && strip.groups.some((group) => group.id === tab.groupId && !group.collapsed));

test("agent-browser drives a folded Bao tab in the owner's Chrome while he keeps his own tab", { skip: !binary, timeout: scaledMs(90_000) }, async (t) => {
  const chrome = await ownerChrome(t, { "/task": TASK });
  const proxy = new AgentBrowserProxy({ home: chrome.home, executable: binary, extensionRoute: () => true });
  t.after(() => proxy.end());
  const opened = await proxy.execute("open", [`${chrome.base}/task`], "current");
  assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
  for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]], ["tab", ["new"]]] as const) {
    const [result] = await proxy.execute(command, [...args], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(result!.exitCode, 0, result!.stderr);
  }
  const strip = await stripWhen(chrome, (s) => s.tabs.length === 3);
  const [group] = strip.groups;
  assert.deepEqual(strip.groups, [{ id: group!.id, title: "Bao", color: "grey", collapsed: true }]);
  assert.deepEqual(strip.tabs.map((tab) => [tab.groupId === group!.id, tab.active]), [[true, false], [true, false], [false, true]],
    "the task tab and the agent's own tab new stay folded in the group; the owner's tab stays active");
  // `frames` is the page's own frame counter, a global `let`, not `window.frames`.
  assert.deepEqual(await chrome.inPage(await chrome.targetOf("/task"), `new Promise(resolve => { const start = frames; setTimeout(() => resolve({
    text: out.textContent, visibility: document.visibilityState, painting: frames > start }), 300); })`),
  { text: "clicked, typed: Ada", visibility: "visible", painting: true }, "focus emulation keeps the folded tab live");
  assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");

  assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0);
  const after = await stripWhen(chrome, (s) => s.tabs.length === 1);
  assert.deepEqual(after.tabs.map((tab) => tab.id), [chrome.ownerTabId], "only Bao's tabs close");
  assert.deepEqual(after.groups, []);
  assert.deepEqual(await chrome.ownerEvents(), []);
});

test("run_workflow on the owner's Chrome works in a folded Bao tab, opens the group when it holds for the owner, and closes it", { skip: replaySkip, timeout: scaledMs(90_000) }, async (t) => {
  const chrome = await ownerChrome(t, { "/task": TASK });
  const library = chrome.app.library;
  const workflow = (steps: WorkflowStep[]): string => {
    const id = `replay-${steps.length}`;
    library.save(testWorkflow({ id, name: "Background replay", startUrl: `${chrome.base}/task`, steps }));
    return id;
  };
  const done = await runWorkflow(library, { id: workflow([FILL, SAVE]), browser: "current" });
  assert.equal(done.outcome, "ok", done.reason);
  assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");
  assert.deepEqual((await stripWhen(chrome, (s) => s.tabs.length === 1)).tabs.map((tab) => tab.id), [chrome.ownerTabId], "the run's tab closes with the run");

  const held = await runWorkflow(library, { id: workflow([FILL, SAVE, HOLD]), browser: "current" });
  try {
    assert.equal(held.outcome, "needs_human", held.reason);
    assert.ok(shown(chrome)(await stripWhen(chrome, shown(chrome))), "a held run opens the Bao group and leaves the owner's tab active");
    assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");
  } finally {
    if (held.resume) await runWorkflow(library, { resume: held.resume, cancel: true });
  }
  assert.deepEqual((await stripWhen(chrome, (s) => s.tabs.length === 1)).groups, [], "cancelling the held run closes its tab");
});

test("app Replay on the owner's Chrome works in a folded Bao tab, opens the group when it holds for the owner, and closes it", { skip: replaySkip, timeout: scaledMs(90_000) }, async (t) => {
  const chrome = await ownerChrome(t, { "/task": TASK });
  const url = (route: string) => `http://127.0.0.1:${chrome.app.port}${route}`;
  const replay = (id: string) => fetch(url("/api/replay"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, browser: "current", args: {} }), signal: AbortSignal.timeout(60_000) }).then((response) => response.json() as Promise<{ status: string }>);
  const workflow = (steps: WorkflowStep[]): string => {
    const id = `app-replay-${steps.length}`;
    chrome.app.library.save(testWorkflow({ id, name: "Background app replay", startUrl: `${chrome.base}/task`, steps }));
    return id;
  };
  assert.equal((await replay(workflow([FILL, SAVE]))).status, "passed");
  assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");
  assert.deepEqual((await stripWhen(chrome, (s) => s.tabs.length === 1)).tabs.map((tab) => tab.id), [chrome.ownerTabId], "the run's tab closes with the run");

  const held = replay(workflow([FILL, SAVE, HOLD]));
  try {
    assert.ok(shown(chrome)(await stripWhen(chrome, shown(chrome), 30_000)), "a held app Replay opens the Bao group and leaves the owner's tab active");
    assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");
  } finally {
    const state = await fetch(url("/api/state")).then((response) => response.json() as Promise<{ activeRun?: { id: string } }>);
    if (state.activeRun) await fetch(url("/api/replay/cancel"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: state.activeRun.id }) });
    await held.catch(() => undefined);
  }
});

test("replay on the owner's Chrome starts and finishes while another owner tab never answers, and reaches none of the owner's tabs", { skip: replaySkip, timeout: scaledMs(60_000) }, async (t) => {
  let blocked!: () => void;
  const stuckPage = new Promise<void>((resolve) => { blocked = resolve; });
  const chrome = await ownerChrome(t, {
    "/task": TASK,
    // The stuck page's synchronous request never gets an answer, so its page thread never returns.
    "/stuck": "<!doctype html><title>Stuck</title><script>const hang = new XMLHttpRequest(); hang.open('GET', '/hang', false); hang.send();</script>",
    "/hang": () => blocked(),
  });
  const library = chrome.app.library;
  library.save(testWorkflow({ id: "stuck-neighbor", name: "Replay next to a stuck tab", startUrl: `${chrome.base}/task`, steps: [FILL, SAVE] }));
  // Another site keeps the stuck page out of the task tab's process.
  const stuckUrl = chrome.base.replace("127.0.0.1", "localhost") + "/stuck";
  await chrome.inWorker(`chrome.tabs.create({ url: ${JSON.stringify(stuckUrl)}, active: false }).then(() => undefined)`);
  await stuckPage;
  const stuck = await chrome.targetOf("/stuck");

  const attached: string[] = [];
  chrome.probe.on("Target.targetInfoChanged", undefined, (params) => {
    const info = params.targetInfo as { targetId: string; attached: boolean };
    if (info.attached && [chrome.ownerTargetId, stuck].includes(info.targetId)) attached.push(info.targetId);
  });
  await chrome.probe.send("Target.setDiscoverTargets", { discover: true });
  const started = Date.now();
  const done = await runWorkflow(library, { id: "stuck-neighbor", browser: "current" });
  assert.equal(done.outcome, "ok", done.reason);
  assert.ok(Date.now() - started < 15_000, `replay took ${Date.now() - started} ms`);
  await chrome.probe.send("Target.setDiscoverTargets", { discover: false });
  assert.deepEqual(attached, [], "replay never attached the owner's tabs");
  assert.ok((await chrome.strip()).tabs.some((tab) => tab.url === stuckUrl), "the stuck tab stays open where it was");
  assert.deepEqual(await chrome.ownerEvents(), [], "the owner's tab never left the front");
});
