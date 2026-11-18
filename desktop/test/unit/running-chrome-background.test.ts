import assert from "node:assert/strict";
import test from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { pinTestBrowser } from "../../src/launch";
import { ownerChrome, stripWhen } from "../support/owner-chrome";
import { scaledMs } from "../runtime";

pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><p id=out>not clicked</p>
<script>let frames=0;(function f(){frames++;requestAnimationFrame(f)})();b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

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
