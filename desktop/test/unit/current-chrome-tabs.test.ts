// The owner's Chrome lists its own surfaces next to tabs: the Gemini in Chrome panel (glic) and side panels. A real tab on
// that panel's URL is still a tab. A fake Chrome endpoint exposes them next to Bao's task tab and the owner's tab, and a fake
// native daemon behaves like agent-browser over --cdp: should_track_target lists page and webview targets and skips
// chrome://, chrome-extension://, and devtools://, and without --pin-tab it can make a new target current on its own.

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import * as socket from "../../src/cdp-live/socket";
import type { CdpMessage, CdpRoute, CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as bao from "../../src/engines/bao-profile";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { pinTestBrowser } from "../../src/launch";
import { stepSentence } from "../../src/mcp/tool-card";
import { Library } from "../../src/v1/store";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";

pinTestBrowser();

const MAPS = "https://www.google.com/maps";
const GLIC = "https://gemini.google.com/glic?hl=en-US";

interface Target { targetId: string; type: string; url: string; title: string; openerId?: string; inWindow: boolean; label?: string }

function withoutJson(args: string[]): string[] {
  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
      if (args[i + 1] === "true" || args[i + 1] === "false") i += 1;
      continue;
    }
    cleaned.push(args[i]!);
  }
  return cleaned;
}

function canonicalTabId(ref: string | undefined): string | undefined {
  const digits = /^\s*[tT](0*[1-9]\d*)\s*$/u.exec(ref ?? "")?.[1];
  if (!digits) return undefined;
  const id = Number(digits);
  return id > 0 && id <= 0xffff_ffff ? `t${id}` : undefined;
}

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
  const daemon = { active: "", pinned: false, cdp: "", holdClosedInChrome: false, tabIds: new Map<string, string>(), commands: [] as { command: string; args: string[]; on: string }[],
    /** Runs before every command, so a test can place a tab on one list and not the next. */
    observe: undefined as ((command: string, args: string[]) => void) | undefined,
    /** Runs before a command, like the native daemon adopting a target it discovered. Cleared after one command. */
    before: undefined as ((command: string, args: string[]) => void) | undefined,
    /** Runs when a click lands, like a link that opens a new tab. */
    clicked: undefined as (() => void) | undefined,
    /** Runs when a press lands, like a key that opens a new tab. */
    pressed: undefined as (() => void) | undefined,
    windowCheck: undefined as ((targetId: string) => void) | undefined,
    /** Runs as a command's reply is sent, after that list was built and before the next command. */
    after: undefined as ((command: string, args: string[]) => void) | undefined,
    /** Exit code of the next command that has no tab-specific reply. */
    exit: 0,
    /** Targets Chrome lists that this daemon has not numbered yet. */
    untracked: new Set<string>() };
  // agent-browser's should_track_target lists page and webview targets, and skips chrome://, chrome-extension://, and devtools://.
  // It numbers them in the order it sees them. Before each command it takes in the targets Chrome reported since; without --pin-tab
  // it makes each new one current. A pinned daemon whose bound tab is gone marks no tab active (tab_gone).
  const internal = /^(?:chrome-extension|chrome|devtools):/u;
  const tracked = () => targets.filter(target => ["page", "webview"].includes(target.type) && !internal.test(target.url));
  const drain = () => {
    const attached = daemon.tabIds.size > 0;
    for (const target of tracked()) {
      if (daemon.untracked.has(target.targetId) || daemon.tabIds.has(target.targetId)) continue;
      daemon.tabIds.set(target.targetId, `t${daemon.tabIds.size + 1}`);
      if (attached && !daemon.pinned) daemon.active = target.targetId;
    }
  };
  const listed = () => tracked().filter(target => !daemon.untracked.has(target.targetId)).map(target => ({ tabId: daemon.tabIds.get(target.targetId)!, targetId: target.targetId, label: target.label ?? null, title: target.title,
    url: target.url, type: target.type, active: target.targetId === daemon.active }));
  const closed: string[] = [];
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const listeners: { method: string; handler: (params: Record<string, unknown>) => void }[] = [];
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners.filter(item => item.method === method)) listener.handler(params); };
  const cdp = {
    isOpen: true,
    disconnected: new Promise<void>(() => undefined),
    close() { cdp.isOpen = false; },
    async send(method: string, params: Record<string, unknown> = {}) {
      sent.push({ method, params });
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
    if (!argv.includes("--pin-tab")) {
      const stdout = command === "tab" && args.includes("--json")
        ? JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", targetId: "bao-page", title: "Example", url: "https://example.com/", active: true }] } })
        : "\u2713 Done\n";
      void writeFile(path.join(String(options.cwd), "bao.pid"), String(process.pid)).then(() => callback(null, stdout, ""));
      return new EventEmitter();
    }
    const cdpAt = argv.indexOf("--cdp");
    if (cdpAt >= 0) daemon.cdp = argv[cdpAt + 1] ?? "";
    if (argv.includes("--pin-tab")) daemon.pinned = true;
    if (!daemon.active) daemon.active = "task";
    // A target that appears as the command starts is on this command's tab list, as Chrome would report it.
    daemon.observe?.(command, args);
    daemon.before?.(command, args);
    daemon.before = undefined;
    drain();
    daemon.commands.push({ command, args, on: daemon.active });
    const tabs = listed();
    const reply = (stdout: string, code = 0) => {
      daemon.after?.(command, args);
      return void writeFile(path.join(String(options.cwd), "bao.pid"), String(process.pid))
        .then(() => callback(code ? Object.assign(new Error(stdout), { code }) : null, code ? "" : stdout, code ? stdout : ""));
    };
    const tabArgs = command === "tab" ? withoutJson(args) : args;
    const named = (ref: string | undefined) => tabs.find(item => item.tabId === ref || item.tabId === canonicalTabId(ref) || item.label === ref?.trim() || (ref !== undefined && item.targetId.toLowerCase() === ref.trim().toLowerCase()));
    const listing = command === "tab" && tabArgs[0] !== "close" && tabArgs[0] !== "new" && (!tabArgs[0] || tabArgs[0] === "list");
    if (command === "tab" && listing && args.includes("--json")) reply(JSON.stringify({ success: true, data: { tabs } }));
    else if (command === "tab" && (!args[0] || args[0] === "list")) reply(tabs.map(tab => `${tab.active ? "→" : " "} [${tab.tabId}] ${tab.title} - ${tab.url}`).join("\n") + "\n");
    else if (command === "tab" && tabArgs[0] === "close") {
      const tab = named(tabArgs[1]);
      if (!tab) { reply(`✗ Tab ${args[1]} not found`, 1); return new EventEmitter(); }
      if (!daemon.holdClosedInChrome) {
        const index = targets.findIndex(item => item.targetId === tab.targetId);
        if (index >= 0) targets.splice(index, 1);
      }
      daemon.tabIds.delete(tab.targetId);
      if (daemon.active === tab.targetId) daemon.active = daemon.pinned ? "" : tracked()[0]?.targetId ?? "";
      reply("✓ Closed\n");
    } else if (command === "tab" && tabArgs[0] !== "new") {
      const tab = named(tabArgs[0]);
      if (!tab) { reply(`✗ Tab ${args[0]} not found`, 1); return new EventEmitter(); }
      daemon.active = tab.targetId;
      reply(`✓ ${tab.title}\n  ${tab.url}\n`);
    } else if (command === "open") {
      const page = targets.find(item => item.targetId === daemon.active)!;
      page.url = args[0]!;
      page.title = "Google Maps";
      reply(`✓ ${page.title}\n  ${page.url}\n`);
    } else if (command === "tab" && args[0] === "new") {
      targets.push({ targetId: "opened", type: "page", url: "about:blank", title: "New Tab", inWindow: true });
      daemon.active = "opened";
      reply("✓ New tab\n");
    } else {
      if (command === "click") daemon.clicked?.();
      if (command === "press") daemon.pressed?.();
      const code = daemon.exit;
      daemon.exit = 0;
      reply(`✓ Done on ${daemon.active}\n`, code);
    }
    return new EventEmitter();
  });
  const executable = path.join(root, "native");
  await writeFile(executable, "", { mode: 0o700 });
  const home = path.join(root, "home");
  const proxy = new AgentBrowserProxy({ home, sourceRoot: root, executable });
  t.after(() => proxy.end());
  // Without events the tab video stops at once. A test that needs Chrome's events turns them on after open.
  const listen = () => Object.assign(cdp, { on(method: string, _sessionId: string | undefined, handler: (params: Record<string, unknown>) => void) {
    const listener = { method, handler };
    listeners.push(listener);
    return () => { listeners.splice(listeners.indexOf(listener), 1); };
  } });
  return { proxy, targets, daemon, closed, sent, home, emit, listeners, listen };
}

test("Chrome's Gemini panel and side panels stay out of the agent's tab list, and Bao's task tab says so", async (t) => {
  const f = await fixture(t);
  const opened = await f.proxy.execute("open", [MAPS], "current");
  assert.equal(f.daemon.pinned, true, "the native daemon stays on its bound tab");
  assert.match(f.daemon.cdp, /\?background=1$/, "only the native daemon's connection stays behind");
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
  assert.equal(f.sent.filter(call => call.method === "Page.bringToFront" || call.method === "Target.activateTarget").length, 0,
    "the return does not ask Chrome to raise the task tab; the daemon's Page.bringToFront is answered on the shared connection");
  f.daemon.before = () => { f.daemon.active = "search"; };
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
  assert.ok(f.daemon.commands.filter(entry => entry.command !== "tab").every(entry => entry.on === "task"), "no page command ran on a panel");
});

test("the agent cannot switch to or close Chrome's own panels, or a tab the owner opened", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId);
  for (const args of [["t4"], ["close", "t4"], ["t6"]]) {
    const [result] = await f.proxy.execute("tab", args, undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.equal(result!.exitCode, 1);
    assert.match(result!.stderr, /is not a tab in a Chrome window, such as the Gemini panel or a side panel\. Stay in Bao's task tab\./);
  }
  const [owner] = await f.proxy.execute("tab", ["t2"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(owner!.exitCode, 1);
  assert.match(owner!.stderr, /is a tab the owner opened/);
  assert.match(owner!.stderr, /open that page's URL in your task tab \(it shares his sign-ins\): https:\/\/www\.google\.com\/maps/);
  const [closed] = await f.proxy.execute("tab", ["close", "t2"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(closed!.exitCode, 1);
  assert.match(closed!.stderr, /open that page's URL in your task tab/);
  const [panelTab] = await f.proxy.execute("tab", ["t3"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(panelTab!.exitCode, 1, "a real tab the owner opened is refused even on the Gemini panel URL");
  assert.match(panelTab!.stderr, /open that page's URL in your task tab/);
  assert.ok(!f.daemon.commands.some(entry => entry.command === "tab" && ["t2", "t3", "t4", "t6"].includes(entry.args.at(-1)!)), "the refused calls never reached the daemon");
  assert.equal(f.daemon.active, "task");
  await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "task");
});

test("a tab command the pinned CLI would accept cannot close or switch to a tab the owner opened", async (t) => {
  const f = await fixture(t);
  const owner = f.targets.find(item => item.targetId === "owner")!;
  owner.targetId = "4A0B7C4E1F2D3A4B5C6D7E8F90A1B2C3";
  owner.label = "docs";
  await f.proxy.execute("open", [MAPS], "current");
  const acted = () => f.daemon.commands.filter(entry => entry.command === "tab" && entry.args.some(arg => arg === "close" || arg === "t2" || /^[tT]0*2$/u.test(arg) || /4a0b/iu.test(arg) || arg === "docs"));
  for (const args of [["--json", "close", "t2"], ["--debug", "close", "t2"], ["close", "T2"], ["close", "t02"], ["close", "  t2  "], ["T2"], ["4A0B7C4E1F2D3A4B5C6D7E8F90A1B2C3"], ["4a0b7c4e1f2d3a4b5c6d7e8f90a1b2c3"], ["docs"]]) {
    const before = acted().length;
    const [refused] = await f.proxy.execute("tab", args, undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.equal(refused!.exitCode, 1, args.join(" "));
    assert.match(refused!.stderr, /is a tab the owner opened/, args.join(" "));
    assert.equal(acted().length, before, args.join(" "));
  }
  assert.ok(f.targets.some(item => item.label === "docs"), "the owner tab stays open");
  const [panel] = await f.proxy.execute("tab", ["--json", "t4"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(panel!.exitCode, 1);
  assert.match(panel!.stderr, /is not a tab in a Chrome window, such as the Gemini panel or a side panel\. Stay in Bao's task tab\./);
  const [task] = await f.proxy.execute("tab", ["T1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(task!.exitCode, 0);
  assert.equal(f.daemon.active, "task");
  assert.ok(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t1" && !entry.args.includes("T1")), "Bao forwards the canonical tab id");
});

test("a popup that appears after the tab read and before the native command stays the owner's", async (t) => {
  const f = await fixture(t);
  let firstTabSawGap: boolean | undefined;
  f.daemon.after = (command, args) => {
    if (command !== "tab" || !args.includes("--json") || f.targets.some(item => item.targetId === "gap")) return;
    f.daemon.after = undefined;
    f.targets.push({ targetId: "gap", type: "page", url: "https://example.com/gap", title: "Gap popup", openerId: "task", inWindow: true });
  };
  f.daemon.observe = (command) => {
    if (command !== "tab" || firstTabSawGap !== undefined) return;
    firstTabSawGap = f.targets.some(item => item.targetId === "gap");
  };
  await f.proxy.execute("open", [MAPS], "current");
  assert.equal(firstTabSawGap, false, "the popup was not on the tab read that preceded the native command");
  assert.ok(f.targets.some(item => item.targetId === "gap"));
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(listed, /Gap popup/);
  assert.doesNotMatch(listed, /\(Bao task tab\) Gap popup/);
  assert.equal(f.daemon.active, "task");
  assert.equal(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "gap"), false);
  assert.ok(await f.proxy.finishTask({ outcome: "failed", reason: "fixture" }, f.proxy.activeRunId));
  assert.equal(f.closed.includes("gap"), false);
  assert.ok(f.closed.includes("task"));
});

test("a popup Chrome lists before the daemon does stays pending, and the next snapshot follows it", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => {
    f.targets.push({ targetId: "late", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", openerId: "task", inWindow: true });
    f.daemon.untracked.add("late");
  };
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "\u2713 Done on task\n");
  assert.equal(f.daemon.active, "task");
  assert.equal(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "late"), false, "Bao does not follow a popup that has no native tab id yet");
  f.daemon.untracked.delete("late");
  await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(f.daemon.commands.at(-1)!.on, "late", "the next snapshot lands on the popup once it has a native tab id");
  assert.equal(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t2"), false, "Bao does not switch to the owner tab to follow the popup");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.ok(f.closed.includes("late"));
  assert.equal(f.closed.includes("owner"), false);
});

test("a popup that disappears before it has a native tab id is not followed", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => {
    f.targets.push({ targetId: "gone", type: "page", url: "https://accounts.example/gone", title: "Gone", openerId: "task", inWindow: true });
    f.daemon.untracked.add("gone");
  };
  await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId);
  const index = f.targets.findIndex(item => item.targetId === "gone");
  f.targets.splice(index, 1);
  f.daemon.untracked.delete("gone");
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "\u2713 Done on task\n");
  assert.equal(f.daemon.active, "task");
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
  assert.ok(f.sent.filter(call => call.method === "Emulation.setFocusEmulationEnabled" && call.params.enabled === true).length >= 3,
    "the task tab and each followed popup get focus emulation so a background popup can take clicks");
  assert.equal(f.sent.filter(call => call.method === "Page.bringToFront" || call.method === "Target.activateTarget").length, 0,
    "following a popup does not ask Chrome to raise it");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.deepEqual([...f.closed].sort(), ["popup", "popup2", "task"], "Bao closes the followed popups and the task tab, not the owner's tabs");
});

test("a download on the owner's Chrome points Chrome's downloads at the run only for that click, also when the click fails", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.listen();
  const behavior = () => f.sent.filter(call => call.method === "Browser.setDownloadBehavior").map(call => call.params.behavior);
  f.daemon.clicked = () => {
    const folder = String(f.sent.filter(call => call.method === "Browser.setDownloadBehavior").at(-1)!.params.downloadPath);
    void writeFile(path.join(folder, "guid-1"), "statement").then(() => {
      f.emit("Browser.downloadWillBegin", { guid: "guid-1", url: "https://example.com/statement.pdf", suggestedFilename: "statement.pdf" });
      f.emit("Browser.downloadProgress", { guid: "guid-1", state: "completed" });
    });
  };
  const listening = f.listeners.length;
  const [saved] = await f.proxy.execute("download", ["@e2", "statement.pdf"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(saved!.exitCode, 0, saved!.stderr);
  const file = path.join(f.home, "downloads", f.proxy.activeRunId!, "statement.pdf");
  assert.equal(saved!.stdout, `\u2713 Download saved to ${file}\n`);
  assert.equal(await readFile(file, "utf8"), "statement");
  assert.deepEqual(behavior(), ["allowAndName", "default"], "Bao's own connection gives Chrome its download settings back after the click");
  assert.deepEqual(f.daemon.commands.filter(item => item.command === "click").map(item => item.args), [["@e2"]], "the native CLI only clicks");
  assert.equal(f.listeners.length, listening, "the download leaves no listener on the owner's connection");
  f.daemon.clicked = undefined;
  f.daemon.exit = 1;
  assert.equal((await f.proxy.execute("download", ["@e3", "other.pdf"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 1);
  assert.deepEqual(behavior(), ["allowAndName", "default", "allowAndName", "default"], "a failed click resets too");
  assert.equal((await f.proxy.execute("click", ["@e4"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(behavior().length, 4, "a click is not a download");
});

test("a sign-in popup opened while moving to Running Chrome is followed, and finish closes it", async (t) => {
  const f = await fixture(t);
  const portFile = path.join(f.home, "DevToolsActivePort");
  await mkdir(f.home, { recursive: true });
  await writeFile(portFile, "9222\n/devtools/browser/bao\n");
  t.mock.method(bao, "openBaoChromeForProxy", async () => ({
    target: { kind: "bao" as const, portFile }, targetId: "bao-page", closed: new Promise<void>(() => undefined),
    isClosed: () => false, close: async () => undefined, keepOpen: async () => undefined,
    importLogin: async () => ({ origin: "https://example.com", found: 0, cookies: 0, storage: 0 }),
  }));
  t.mock.method(socket, "connectCdp", async () => ({
    async send() { return { targetInfo: { url: "https://example.com/", title: "Example" }, sessionId: "copy", result: { value: undefined } }; },
    sendUntilProgress(this: { send: () => Promise<unknown> }) { return this.send(); },
    close() {}, on() { return this; },
  }) as unknown as CdpSocket);
  await f.proxy.execute("open", ["https://example.com/"], "bao");
  f.daemon.before = (command) => {
    if (command === "open") f.targets.push({ targetId: "signin", type: "page", url: "https://accounts.google.com/o/oauth2/v2/auth", title: "Choose an account", openerId: "task", inWindow: true });
  };
  const [moved] = await f.proxy.execute("open", ["https://www.google.com/maps"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(moved!.exitCode, 0);
  assert.equal(f.daemon.active, "signin", "the agent follows the popup the move's open created");
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(listed, /→ \[[^\]]+\] \(Bao task tab\) Choose an account/);
  assert.match(listed, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.match(listed, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.ok(f.closed.includes("signin"), "finish closes the popup the move opened");
  assert.ok(f.closed.includes("task"));
  assert.equal(f.closed.includes("owner"), false);
});

test("a popup opened by the popup a command opened is followed, and finish closes both", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => {
    f.targets.push({ targetId: "popup-a", type: "page", url: "https://example.com/a", title: "Nested A", openerId: "task", inWindow: true });
    f.targets.push({ targetId: "popup-b", type: "page", url: "https://example.com/b", title: "Nested B", openerId: "popup-a", inWindow: true });
  };
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(f.daemon.active, "popup-b", "Bao follows the popup the new tab opened");
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(listed, /\(Bao task tab\) Nested A/);
  const child = /\[([^\]]+)\] \(Bao task tab\) Nested B/.exec(listed)?.[1];
  assert.ok(child);
  assert.equal((await f.proxy.execute("tab", ["t1"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  const [back] = await f.proxy.execute("tab", [child!], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(back!.exitCode, 0);
  assert.doesNotMatch(back!.stderr, /owner opened/);
  assert.equal(f.daemon.active, "popup-b");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.ok(f.closed.includes("popup-a"));
  assert.ok(f.closed.includes("popup-b"));
  assert.equal(f.closed.includes("owner"), false);
});

test("an owner target=_blank from the task tab during a wait is not adopted and not closed", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  const task = f.targets.find(item => item.targetId === "task")!;
  task.url = "https://example.com/login";
  task.title = "Sign in";
  f.daemon.before = () => {
    f.targets.push({ targetId: "forgot", type: "page", url: "https://example.com/forgot", title: "Forgot password", openerId: "task", inWindow: true });
  };
  const [waited] = await f.proxy.execute("wait_for_owner", ["1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(waited!.exitCode, 0);
  assert.match(waited!.stdout, /waiting/);
  assert.equal(f.daemon.active, "task", "the owner's popup does not become the agent's tab");
  assert.ok(!f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t7"), "Bao does not switch to the owner's popup");
  assert.ok(await f.proxy.finishTask({ outcome: "failed", reason: "fixture" }, f.proxy.activeRunId));
  assert.equal(f.closed.includes("forgot"), false, "finish does not close a tab the owner opened");
  assert.ok(f.closed.includes("task"));
});

test("an owner target=_blank during workflow capture is not adopted and not closed", async (t) => {
  const f = await fixture(t);
  let listedAt = -1;
  f.daemon.observe = (command, args) => {
    if (command !== "tab" || !args.includes("--json") || f.daemon.commands.some(entry => entry.command === "open")) return;
    listedAt = f.daemon.commands.length;
    f.daemon.observe = undefined;
    f.targets.push({ targetId: "owner-new", type: "page", url: "https://example.com/owner-tab", title: "Owner tab", openerId: "task", inWindow: true });
  };
  const opened = await f.proxy.execute("open", [MAPS], "current");
  const openAt = f.daemon.commands.findIndex(entry => entry.command === "open");
  assert.ok(listedAt >= 0 && listedAt < openAt, "the owner's tab appeared on the tab list before the open ran");
  assert.equal(f.daemon.commands[openAt]!.on, "task", "the open stayed on Bao's task tab");
  const listed = opened.find(result => result.stdout.includes("["))!.stdout;
  assert.match(listed, /Owner tab/);
  assert.doesNotMatch(listed, /\(Bao task tab\) Owner tab/);
  await assertOwnerKeeps(f, listed);
});

test("an owner target=_blank during wall handling is not adopted and not closed", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  placeAfterCommand(f, "click", 0);
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on task\n");
  assert.equal(f.daemon.commands.filter(entry => entry.command === "click").at(-1)!.on, "task");
  await assertOwnerKeeps(f);
});

test("an owner target=_blank during wall handling after a press is not adopted and not closed", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  placeAfterCommand(f, "press", 0);
  assert.equal((await f.proxy.execute("press", ["Enter"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(f.daemon.commands.filter(entry => entry.command === "press").at(-1)!.on, "task");
  await assertOwnerKeeps(f);
});

test("a popup a press opens from the task tab becomes the agent's tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.pressed = () => f.targets.push({ targetId: "keyed", type: "page", url: "https://example.com/keyed", title: "Keyed", openerId: "task", inWindow: true });
  assert.equal((await f.proxy.execute("press", ["Enter"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.match((await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, /\(Bao task tab\) Keyed/);
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on keyed\n");
  assert.ok(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "keyed"), "the press popup gets focus emulation");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.deepEqual([...f.closed].sort(), ["keyed", "task"]);
});

test("a popup that appears during the tab read after tab new is not adopted and not closed", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.observe = (command, args) => {
    if (command !== "tab" || !args.includes("--json") || !f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "new")) return;
    if (f.targets.some(item => item.targetId === "late")) return;
    f.targets.push({ targetId: "late", type: "page", url: "https://example.com/late", title: "Late owner", openerId: "opened", inWindow: true });
  };
  assert.equal((await f.proxy.execute("tab", ["new"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(f.daemon.active, "opened", "a popup that appears during the post-command tab read does not become the agent's tab");
  const listed = (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(listed, /Late owner/);
  assert.doesNotMatch(listed, /\(Bao task tab\) Late owner/);
  assert.equal(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t8"), false, "Bao does not switch to the popup");
  assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "fixture" }, f.proxy.activeRunId));
  assert.equal(f.closed.includes("late"), false, "finish does not close a tab that appeared after the native command returned");
  assert.ok(f.closed.includes("opened"));
  assert.ok(f.closed.includes("task"));
});

test("tab new --json and tab t1 --json keep --json in the argv sent to the daemon", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  const [created] = await f.proxy.execute("tab", ["new", "--json", "--label", "docs", "--not-a-flag"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(created!.exitCode, 0);
  const opened = f.daemon.commands.find(entry => entry.command === "tab" && entry.args[0] === "new");
  assert.ok(opened?.args.includes("--json"), "tab new --json still requests JSON");
  assert.ok(opened?.args.includes("--label") && opened.args.includes("docs"), "tab new keeps --label");
  assert.equal(opened?.args.includes("--not-a-flag"), false, "tab new does not forward a flag the CLI does not accept");
  const [back] = await f.proxy.execute("tab", ["t1", "--json", "--quiet"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(back!.exitCode, 0);
  assert.equal(f.daemon.active, "task");
  const switched = f.daemon.commands.find(entry => entry.command === "tab" && entry.args[0] === "t1" && entry.args.includes("--json"));
  assert.ok(switched, "tab t1 --json still requests JSON");
  assert.ok(switched!.args.includes("--quiet"), "tab t1 keeps another flag the CLI accepts");
  const [madeUp] = await f.proxy.execute("tab", ["t1", "--json", "--made-up"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(madeUp!.exitCode, 0);
  const again = f.daemon.commands.filter(entry => entry.command === "tab" && entry.args[0] === "t1").at(-1)!;
  assert.ok(again.args.includes("--json"));
  assert.equal(again.args.includes("--made-up"), false);
});

test("tab --restore t1 switches to t1 and is not a list", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://example.com/popup", title: "Popup", openerId: "task", inWindow: true });
  assert.equal((await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(f.daemon.active, "popup");
  const [switched] = await f.proxy.execute("tab", ["--restore", "t1"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(switched!.exitCode, 0);
  assert.equal(f.daemon.active, "task", "--restore after tab does not consume the tab reference");
  const sent = f.daemon.commands.find(entry => entry.command === "tab" && entry.args[0] === "t1" && entry.args.includes("--restore"));
  assert.ok(sent, "Bao forwards the switch to t1");
  assert.equal(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "list" && entry.args.includes("--restore")), false, "Bao does not forward a list");
});

test("tab new gets focus emulation, and an owner tab does not", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  assert.equal((await f.proxy.execute("tab", ["new"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  assert.ok(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "opened"), "the new tab gets focus emulation");
  assert.equal(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "owner"), false, "an owner tab does not get focus emulation");
  assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "✓ Done on opened\n");
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
  assert.ok(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "opened"), "the new tab gets focus emulation");
  assert.equal(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "owner"), false, "an owner tab does not get focus emulation");
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

test("tab close with an empty reference is refused, and a close with no reference still closes the task tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  const [empty] = await f.proxy.execute("tab", ["close", ""], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(empty!.exitCode, 1);
  assert.match(empty!.stderr, /Empty tab reference/);
  assert.equal(f.daemon.active, "task");
  assert.ok(f.targets.some(item => item.targetId === "task"));
  assert.equal(f.daemon.commands.some(entry => entry.command === "tab" && entry.args.includes("close")), false, "the empty close never reached the daemon");
  const [closed] = await f.proxy.execute("tab", ["close"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(closed!.exitCode, 0);
  assert.match(closed!.stdout, /Bao's task tab was closed/);
  assert.ok(!f.targets.some(item => item.targetId === "task"));
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

test("tab onto an owner tab is refused, and that tab does not keep the session when the task tab closes", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  const [refused] = await f.proxy.execute("tab", ["t2"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(refused!.exitCode, 1);
  assert.match(refused!.stderr, /open that page's URL in your task tab \(it shares his sign-ins\)/);
  assert.equal(f.daemon.active, "task");
  dropTab(f, "task");
  const [ended] = await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.match(ended!.stdout, /Bao's task tab was closed/);
  assert.equal(f.proxy.hasSession(), false);
  assert.ok(f.targets.some(item => item.targetId === "owner"));
});

test("the native daemon's shared connection cannot raise Chrome or open a tab in front", async () => {
  const client = await sharedClient("?background=1");
  try {
    await client.ask(1, "Page.bringToFront", {}, "page-1");
    await client.ask(2, "Target.activateTarget", { targetId: "owner" });
    await client.ask(3, "Target.createTarget", { url: "https://example.com/" });
    assert.deepEqual(client.replies.get(1)?.result, {}, "Page.bringToFront is answered locally");
    assert.deepEqual(client.replies.get(2)?.result, {}, "Target.activateTarget is answered locally");
    assert.equal(client.written.some(message => message.method === "Page.bringToFront" || message.method === "Target.activateTarget"), false,
      "the daemon's return or followed popup does not deliver a raise to Chrome");
    const created = client.written.find(message => message.method === "Target.createTarget");
    assert.equal(created?.params?.background, true, "a tab the daemon opens stays in the background");
    assert.equal(created?.sessionId, "browser-session");
  } finally {
    client.close();
  }
});

test("a handoff client of the shared connection is forwarded, so it can raise the task tab", async () => {
  const client = await sharedClient("");
  try {
    await client.ask(1, "Page.bringToFront", {}, "page-1");
    await client.ask(2, "Target.activateTarget", { targetId: "task" });
    await client.ask(3, "Target.createTarget", { url: "https://example.com/" });
    assert.deepEqual(client.replies.get(2)?.result, { targetId: "created" }, "Target.activateTarget is not answered locally");
    const raised = client.written.find(message => message.method === "Target.activateTarget");
    assert.equal(raised?.params?.targetId, "task", "a handoff's Target.activateTarget is written to Chrome");
    assert.equal(raised?.sessionId, "browser-session");
    assert.equal(client.written.some(message => message.method === "Page.bringToFront"), true, "Page.bringToFront is forwarded");
    const created = client.written.find(message => message.method === "Target.createTarget");
    assert.equal(created?.params?.background, undefined, "an unmarked client does not force a background tab");
    assert.equal(created?.params?.url, "https://example.com/");
  } finally {
    client.close();
  }
});

function placeAfterCommand(f: Awaited<ReturnType<typeof fixture>>, command: string, listsAfter: number): void {
  f.daemon.observe = (ran, args) => {
    if (ran !== "tab" || !args.includes("--json")) return;
    const at = f.daemon.commands.findIndex(entry => entry.command === command);
    if (at < 0) return;
    const lists = f.daemon.commands.slice(at + 1).filter(entry => entry.command === "tab" && entry.args.includes("--json")).length;
    if (lists !== listsAfter) return;
    f.daemon.observe = undefined;
    f.targets.push({ targetId: "owner-new", type: "page", url: "https://example.com/owner-tab", title: "Owner tab", openerId: "task", inWindow: true });
  };
}

async function assertOwnerKeeps(f: Awaited<ReturnType<typeof fixture>>, listed?: string): Promise<void> {
  const shown = listed ?? (await f.proxy.execute("tab", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout;
  assert.match(shown, /Owner tab/);
  assert.doesNotMatch(shown, /\(Bao task tab\) Owner tab/);
  const id = /\[([^\]]+)\] Owner tab/.exec(shown)?.[1];
  assert.ok(id);
  const [refused] = await f.proxy.execute("tab", [id!], undefined, false, undefined, {}, f.proxy.activeRunId);
  assert.equal(refused!.exitCode, 1);
  assert.equal(f.daemon.active, "task");
  assert.equal(f.sent.some(call => call.method === "Target.attachToTarget" && call.params.targetId === "owner-new"), false, "an owner tab does not get focus emulation");
  assert.ok(await f.proxy.finishTask({ outcome: "failed", reason: "fixture" }, f.proxy.activeRunId));
  assert.equal(f.closed.includes("owner-new"), false, "finish does not close a tab the owner opened");
  assert.ok(f.closed.includes("task"));
}

async function sharedClient(query: string) {
  const written: CdpMessage[] = [];
  const cdp = {
    isOpen: true,
    disconnected: new Promise<void>(() => undefined),
    async send(method: string) {
      if (method === "Target.attachToBrowserTarget") return { sessionId: "browser-session" };
      return {};
    },
    sendUntilProgress(method: string) { return this.send(method); },
    write(message: CdpMessage, route: CdpRoute) {
      written.push(message);
      if (typeof message.id === "number") route(JSON.stringify({ id: message.id, result: { targetId: "created" } }), { id: message.id, result: { targetId: "created" } });
    },
    route() {},
  };
  const shared = await shareConnection(cdp as unknown as CdpSocket);
  const client = new WebSocket(`ws://127.0.0.1:${shared.endpoint.port}${shared.endpoint.browserPath}${query}`);
  const replies = new Map<number, { result?: Record<string, unknown> }>();
  const waiting = new Map<number, () => void>();
  client.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> };
    if (typeof message.id !== "number") return;
    replies.set(message.id, message);
    waiting.get(message.id)?.();
  };
  await new Promise<void>((resolve, reject) => { client.onopen = () => resolve(); client.onerror = () => reject(new Error("shared endpoint did not accept the client")); });
  return {
    written,
    replies,
    ask(id: number, method: string, params: Record<string, unknown>, sessionId?: string) {
      const done = new Promise<void>((resolve) => waiting.set(id, resolve));
      client.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
      return done;
    },
    close() {
      client.close();
      shared.close();
    },
  };
}
