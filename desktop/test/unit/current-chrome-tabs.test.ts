// The owner's Chrome lists its own surfaces next to tabs: the Gemini in Chrome panel (glic) and side panels. A real tab on
// that panel's URL is still a tab. A fake Chrome endpoint exposes them next to Bao's task tab and the owner's tab, and a fake
// native daemon behaves like agent-browser over --cdp: should_track_target lists page and webview targets and skips
// chrome://, chrome-extension://, and devtools://, and without --pin-tab it can make a new target current on its own.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { pinTestBrowser } from "../../src/launch";
import { stepSentence } from "../../src/mcp/tool-card";
import { Library } from "../../src/v1/store";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";

pinTestBrowser();

const MAPS = "https://www.google.com/maps";
const GLIC = "https://gemini.google.com/glic?hl=en-US";

interface Target { targetId: string; type: string; url: string; title: string; openerId?: string; inWindow: boolean }

async function fixture(t: TestContext) {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-current-tabs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  fakeTaskTab(t);
  const targets: Target[] = [
    { targetId: "owner", type: "page", url: MAPS, title: "Google Maps", inWindow: true },
    { targetId: "glic-tab", type: "page", url: GLIC, title: "Gemini", inWindow: true },
    { targetId: "glic", type: "webview", url: GLIC, title: "Google Gemini", inWindow: false },
    { targetId: "reader", type: "page", url: "chrome-untrusted://read-anything-side-panel.top-chrome/", title: "Reading mode", inWindow: false },
    { targetId: "search", type: "page", url: "https://www.google.com/search?q=pizza", title: "Search side panel", inWindow: false },
  ];
  const daemon = { active: "", pinned: false, holdClosedInChrome: false, tabIds: new Map<string, string>(), commands: [] as { command: string; args: string[]; on: string }[],
    /** Runs before a command, like the native daemon adopting a target it discovered. */
    before: undefined as (() => void) | undefined,
    /** Runs when a click lands, like a link that opens a new tab. */
    clicked: undefined as (() => void) | undefined,
    windowCheck: undefined as ((targetId: string) => void) | undefined };
  // agent-browser's should_track_target lists page and webview targets, and skips chrome://, chrome-extension://, and devtools://.
  // It numbers them in the order it sees them. Before each command it takes in the targets Chrome reported since; without --pin-tab
  // it makes each new one current. A pinned daemon whose bound tab is gone marks no tab active (tab_gone).
  const internal = /^(?:chrome-extension|chrome|devtools):/u;
  const tracked = () => targets.filter(target => ["page", "webview"].includes(target.type) && !internal.test(target.url));
  const drain = () => {
    const attached = daemon.tabIds.size > 0;
    for (const target of tracked()) {
      if (daemon.tabIds.has(target.targetId)) continue;
      daemon.tabIds.set(target.targetId, `t${daemon.tabIds.size + 1}`);
      if (attached && !daemon.pinned) daemon.active = target.targetId;
    }
  };
  const listed = () => tracked().map(target => ({ tabId: daemon.tabIds.get(target.targetId)!, targetId: target.targetId, label: null, title: target.title,
    url: target.url, type: target.type, active: target.targetId === daemon.active }));
  const closed: string[] = [];
  const cdp = {
    isOpen: true,
    disconnected: new Promise<void>(() => undefined),
    close() { cdp.isOpen = false; },
    async send(method: string, params: Record<string, unknown> = {}) {
      const target = targets.find(item => item.targetId === params.targetId);
      if (method === "Target.createTarget") {
        targets.unshift({ targetId: "task", type: "page", url: "about:blank", title: "about:blank", inWindow: true });
        return { targetId: "task" };
      }
      if (method === "Target.getTargets") return { targetInfos: targets.map(({ inWindow: _inWindow, ...info }) => info) };
      if (method === "Target.getTargetInfo") return { targetInfo: target };
      if (method === "Browser.getWindowForTarget") {
        daemon.windowCheck?.(String(params.targetId));
        if (!target?.inWindow) throw new Error("Browser window not found");
        return { windowId: 1 };
      }
      if (method === "Target.closeTarget") closed.push(String(params.targetId));
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
      return {};
    },
    sendUntilProgress(this: { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> }, method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      return this.send(method, params, sessionId);
    },
  } as unknown as CdpSocket & { isOpen: boolean };
  // Bao's workflow recorder opens its own connection to the endpoint. A local port that drops every connection keeps it off any
  // real Chrome, such as one on the default debugging port 9222.
  const endpoint = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => endpoint.close(() => resolve())));
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root,
    endpoint: { port: (endpoint.address() as AddressInfo).port, browserPath: "/devtools/browser/fake" }, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close() }));
  t.mock.method(childProcess, "execFile", (_file: string, argv: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    const at = argv.indexOf("--idle-timeout") + 2;
    const [command, ...args] = argv.slice(at) as [string, ...string[]];
    if (argv.includes("--pin-tab")) daemon.pinned = true;
    if (!daemon.active) daemon.active = "task";
    drain();
    daemon.before?.();
    daemon.before = undefined;
    daemon.commands.push({ command, args, on: daemon.active });
    const tabs = listed();
    const reply = (stdout: string, code = 0) => void writeFile(path.join(String(options.cwd), "bao.pid"), String(process.pid))
      .then(() => callback(code ? Object.assign(new Error(stdout), { code }) : null, code ? "" : stdout, code ? stdout : ""));
    if (command === "tab" && args.includes("--json")) reply(JSON.stringify({ success: true, data: { tabs } }));
    else if (command === "tab" && (!args[0] || args[0] === "list")) reply(tabs.map(tab => `${tab.active ? "→" : " "} [${tab.tabId}] ${tab.title} - ${tab.url}`).join("\n") + "\n");
    else if (command === "tab" && args[0] === "close") {
      const tab = tabs.find(item => item.tabId === args[1]);
      if (!tab) { reply(`✗ Tab ${args[1]} not found`, 1); return new EventEmitter(); }
      if (!daemon.holdClosedInChrome) {
        const index = targets.findIndex(item => item.targetId === tab.targetId);
        if (index >= 0) targets.splice(index, 1);
      }
      daemon.tabIds.delete(tab.targetId);
      if (daemon.active === tab.targetId) daemon.active = daemon.pinned ? "" : tracked()[0]?.targetId ?? "";
      reply("✓ Closed\n");
    } else if (command === "tab" && args[0] !== "new") {
      const tab = tabs.find(item => item.tabId === args[0]);
      if (!tab) { reply(`✗ Tab ${args[0]} not found`, 1); return new EventEmitter(); }
      daemon.active = tab.targetId;
      reply(`✓ ${tab.title}\n  ${tab.url}\n`);
    } else if (command === "open") {
      const page = targets.find(item => item.targetId === daemon.active)!;
      page.url = args[0]!;
      page.title = "Google Maps";
      reply(`✓ ${page.title}\n  ${page.url}\n`);
    } else {
      if (command === "click") daemon.clicked?.();
      reply(`✓ Done on ${daemon.active}\n`);
    }
    return new EventEmitter();
  });
  const executable = path.join(root, "native");
  await writeFile(executable, "", { mode: 0o700 });
  const home = path.join(root, "home");
  const proxy = new AgentBrowserProxy({ home, sourceRoot: root, executable });
  t.after(() => proxy.end());
  return { proxy, targets, daemon, closed, home };
}

test("Chrome's Gemini panel and side panels stay out of the agent's tab list, and Bao's task tab says so", async (t) => {
  const f = await fixture(t);
  const opened = await f.proxy.execute("open", [MAPS], "current");
  assert.equal(f.daemon.pinned, true, "the native daemon stays on its bound tab");
  assert.equal(opened[1]!.stdout, `→ [t1] (Bao task tab) Google Maps - ${MAPS}\n  [t2] Google Maps - ${MAPS}\n  [t3] Gemini - ${GLIC}\n`,
    "Bao's task tab and the owner's tabs are told apart; the Gemini panel and both side panels are gone; a real tab on the panel URL stays");
  assert.equal((await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, opened[1]!.stdout);
  const json = JSON.parse((await f.proxy.execute("tab", ["list", "--json"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout) as { data: { tabs: { tabId: string; baoTaskTab?: boolean }[] } };
  assert.deepEqual(json.data.tabs.map(tab => [tab.tabId, tab.baoTaskTab ?? false]), [["t1", true], ["t2", false], ["t3", false]]);
});

test("when the native daemon makes the Gemini panel current mid-session, the next click and snapshot still land in the task tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  f.daemon.before = () => { f.daemon.active = "glic"; };
  const [click] = await f.proxy.execute("click", ["@e56"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(click!.stdout, "✓ Done on task\n");
  assert.deepEqual(f.daemon.commands.filter(entry => entry.command === "click").map(entry => entry.on), ["task"]);
  assert.ok(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t1" && entry.on === "glic"), "Bao switched the daemon back to its task tab");
  f.daemon.before = () => { f.daemon.active = "search"; };
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
  assert.ok(f.daemon.commands.filter(entry => entry.command !== "tab").every(entry => entry.on === "task"), "no page command ran on a panel");
});

test("the agent cannot switch to or close Chrome's own panels, but can switch to the owner's tabs and stays there", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId);
  for (const args of [["t4"], ["close", "t4"], ["t6"]]) {
    const [result] = await f.proxy.execute("tab", args, undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.equal(result!.exitCode, 1);
    assert.match(result!.stderr, /is not a tab in a Chrome window, such as the Gemini panel or a side panel\. Stay in Bao's task tab\./);
  }
  assert.ok(!f.daemon.commands.some(entry => entry.command === "tab" && ["t4", "t6"].includes(entry.args.at(-1)!)), "the refused calls never reached the daemon");
  assert.equal((await f.proxy.execute("tab", ["t3"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0, "a real tab on the Gemini panel URL is still a tab");
  assert.equal(f.daemon.active, "glic-tab");
  assert.equal((await f.proxy.execute("tab", ["t2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "owner", "an explicit switch is not undone");
  assert.equal((await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, `  [t1] (Bao task tab) Google Maps - ${MAPS}\n→ [t2] Google Maps - ${MAPS}\n  [t3] Gemini - ${GLIC}\n`);
});

test("a tab Bao's task tab opens becomes the agent's tab, once", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", openerId: "task", inWindow: true });
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "popup", "the agent follows the tab its click opened");
  assert.equal((await f.proxy.execute("tab", ["t1"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "task", "going back to the task tab is not undone by the earlier popup");
  f.targets.push({ targetId: "owner-new", type: "page", url: "https://example.com/", title: "Owner's new tab", inWindow: true });
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "task", "a tab the owner opens never takes the agent");
});

test("a popup the agent follows from its task tab is a Bao task tab, and finish_task closes it", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", openerId: "task", inWindow: true });
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.equal(listed, `  [t1] (Bao task tab) Google Maps - ${MAPS}\n  [t2] Google Maps - ${MAPS}\n  [t3] Gemini - ${GLIC}\n→ [t7] (Bao task tab) Ceres - https://www.google.com/maps/place/Ceres\n`);
  f.daemon.clicked = () => f.targets.push({ targetId: "popup2", type: "page", url: "https://www.google.com/maps/place/Vesta", title: "Vesta", openerId: "popup", inWindow: true });
  await f.proxy.execute("click", ["@e3"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.match((await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, /→ \[t8\] \(Bao task tab\) Vesta - https:\/\/www\.google\.com\/maps\/place\/Vesta\n/);
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.deepEqual([...f.closed].sort(), ["popup", "popup2", "task"], "Bao closes the followed popups and the task tab, not the owner's tabs");
});

test("a popup opened from an owner tab the agent switched to stays open and unmarked", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  assert.equal((await f.proxy.execute("tab", ["t2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://example.com/from-owner", title: "From owner", openerId: "owner", inWindow: true });
  await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId);
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(listed, /\[t7\] From owner - https:\/\/example\.com\/from-owner/);
  assert.doesNotMatch(listed, /\[t7\] \(Bao task tab\)/);
  assert.equal(f.daemon.commands.at(-1)!.on, "popup", "the agent still follows a popup its current tab opened");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.deepEqual(f.closed, ["task"], "Bao does not close a popup the owner's tab opened");
});

test("a popup check that hits the ceiling leaves the popup fresh, and the next call adopts it", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stalled = false;
  f.daemon.windowCheck = (targetId) => {
    if (targetId !== "popup" || stalled) return;
    stalled = true;
    t.mock.timers.tick(30_000);
    throw new Error("cdp aborted Browser.getWindowForTarget");
  };
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://accounts.example/sign-in", title: "Sign in", openerId: "task", inWindow: true });
  await assert.rejects(f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId), /cdp aborted Browser.getWindowForTarget/);
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "popup", "the next check adopts the popup the aborted check did not mark seen");
});

test("a tab the agent's click opens with --new-tab becomes the agent's tab, and finish_task closes it with the task tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => {
    f.targets.push({ targetId: "opened", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", inWindow: true });
    f.daemon.active = "opened";
  };
  assert.equal((await f.proxy.execute("click", ["@e5", "--new-tab"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on opened\n", "the agent stays in the tab it just opened");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.deepEqual([...f.closed].sort(), ["opened", "task"], "Bao closes both tabs it opened and none of the owner's");
});

function dropTab(f: { targets: Target[]; daemon: { active: string; tabIds: Map<string, string> } }, targetId: string) {
  const index = f.targets.findIndex(item => item.targetId === targetId);
  if (index >= 0) f.targets.splice(index, 1);
  f.daemon.tabIds.delete(targetId);
  if (f.daemon.active === targetId) f.daemon.active = "";
}

test("when the owner closes Bao's last task tab, the session ends and a new open must name a browser", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  dropTab(f, "task");
  const [ended] = await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(ended!.exitCode, 0);
  const receipt = JSON.parse(ended!.stdout) as { outcome: string };
  assert.equal(receipt.outcome, "closed");
  assert.match(ended!.stdout, /Bao's task tab was closed/);
  assert.match(ended!.stdout, /browser=current/);
  assert.equal(f.proxy.hasSession(), false);
  const missed = (new Library(f.home).listRuns()[0]!.steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.equal(missed.native.command, "snapshot");
  assert.equal(missed.status, "failed");
  assert.equal(missed.reason, "Bao's task tab was closed");
  assert.equal(missed.summary?.text, "Bao's task tab was closed. This session cannot continue.");
  assert.deepEqual(f.closed, [], "the owner's tabs stay open");
  assert.ok(f.targets.some(item => item.targetId === "owner"));
  await assert.rejects(f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, f.proxy.activeRunId), /Bao's task tab was closed/);
  await assert.rejects(f.proxy.execute("open", [MAPS], undefined, false, undefined, {}, f.proxy.activeRunId), /Bao's task tab was closed/);
  const closed = await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(stepSentence("close", closed, undefined, undefined, { current: f.proxy.currentChrome }), "Closed Bao's task tab in your Chrome.");
  assert.equal((await f.proxy.execute("open", [MAPS], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0, "an explicit close clears the ended session, so the next open takes the default");
});

test("the agent's close of its last task tab reports that the tab was closed, not a command failure", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  const [ended] = await f.proxy.execute("tab", ["close", "t1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(ended!.exitCode, 0);
  assert.match(ended!.stdout, /Bao's task tab was closed/);
  const closedStep = (new Library(f.home).listRuns()[0]!.steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.equal(closedStep.native.command, "tab");
  assert.equal(closedStep.status, "passed");
  assert.equal(closedStep.summary?.text, "Bao's task tab was closed. This session cannot continue.");
  assert.equal(f.proxy.hasSession(), false);
  assert.ok(!f.targets.some(item => item.targetId === "task"), "the close itself removed the task tab");
  assert.ok(f.targets.some(item => item.targetId === "owner"));
  assert.deepEqual(f.closed, []);
  await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId), /Bao's task tab was closed/);
});

test("the agent's close of its last task tab ends the session while Chrome still lists that tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.holdClosedInChrome = true;
  const [ended] = await f.proxy.execute("tab", ["close", "t1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(ended!.exitCode, 0);
  const receipt = JSON.parse(ended!.stdout) as { outcome: string };
  assert.equal(receipt.outcome, "closed");
  assert.match(ended!.stdout, /Bao's task tab was closed/);
  assert.equal(f.proxy.hasSession(), false);
  assert.ok(f.targets.some(item => item.targetId === "task"), "Chrome has not destroyed the closed tab yet");
  assert.equal(f.closed.includes("task"), false);
  const closedStep = (new Library(f.home).listRuns()[0]!.steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.equal(closedStep.status, "passed");
  assert.equal(closedStep.summary?.text, "Bao's task tab was closed. This session cannot continue.");
});

test("closing a tab the agent opened does not end the session while Bao's task tab remains", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => {
    f.targets.push({ targetId: "opened", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", inWindow: true });
    f.daemon.active = "opened";
  };
  assert.equal((await f.proxy.execute("click", ["@e5", "--new-tab"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  const [closed] = await f.proxy.execute("tab", ["close", "t7"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(closed!.exitCode, 0);
  assert.doesNotMatch(closed!.stdout, /task tab was closed/);
  assert.equal(f.proxy.hasSession(), true);
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
});

test("an owner tab the agent switched to stays the session when the task tab closes", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  assert.equal((await f.proxy.execute("tab", ["t2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  dropTab(f, "task");
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on owner\n");
  assert.equal(f.proxy.hasSession(), true);
});
