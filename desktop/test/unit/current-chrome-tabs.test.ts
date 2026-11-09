// The owner's Chrome lists its own surfaces next to tabs: the Gemini in Chrome panel (glic), side panels, and Chrome pages.
// A fake Chrome endpoint exposes them next to Bao's task tab and the owner's tab, and a fake native daemon behaves like
// agent-browser over --cdp: it lists page and webview targets and can make one current on its own.

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
import { pinTestBrowser } from "../../src/launch";
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
    { targetId: "glic", type: "webview", url: GLIC, title: "Google Gemini", inWindow: false },
    { targetId: "reader", type: "page", url: "chrome-untrusted://read-anything-side-panel.top-chrome/", title: "Reading mode", inWindow: false },
    { targetId: "search", type: "page", url: "https://www.google.com/search?q=pizza", title: "Search side panel", inWindow: false },
  ];
  const daemon = { active: "", pinned: false, tabIds: new Map<string, string>(), commands: [] as { command: string; args: string[]; on: string }[],
    /** Runs before a command, like the native daemon adopting a target it discovered. */
    before: undefined as (() => void) | undefined,
    /** Runs when a click lands, like a link that opens a new tab. */
    clicked: undefined as (() => void) | undefined };
  // agent-browser tracks page and webview targets except chrome:// pages, and numbers them in the order it sees them. Before each
  // command it takes in the targets Chrome reported since; without --pin-tab it makes each new one current.
  const tracked = () => targets.filter(target => ["page", "webview"].includes(target.type) && !target.url.startsWith("chrome://"));
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
        if (!target?.inWindow) throw new Error("Browser window not found");
        return { windowId: 1 };
      }
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
      return {};
    },
  } as unknown as CdpSocket & { isOpen: boolean };
  // Bao's workflow recorder opens its own connection to the endpoint. A local port that drops every connection keeps it off any
  // real Chrome, such as one on the default debugging port 9222.
  const endpoint = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => endpoint.close(() => resolve())));
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root,
    endpoint: { port: (endpoint.address() as AddressInfo).port, browserPath: "/devtools/browser/fake" }, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
    withConsent: <T>(operation: () => Promise<T>) => operation() }));
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
    else if (command === "tab" && args[0] !== "new" && args[0] !== "close") {
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
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: root, executable });
  t.after(() => proxy.end());
  return { proxy, targets, daemon };
}

test("Chrome's Gemini panel and side panels stay out of the agent's tab list, and Bao's task tab says so", async (t) => {
  const f = await fixture(t);
  const opened = await f.proxy.execute("open", [MAPS], "current");
  assert.equal(f.daemon.pinned, true, "the native daemon stays on its bound tab");
  assert.equal(opened[1]!.stdout, `→ [t1] (Bao task tab) Google Maps - ${MAPS}\n  [t2] Google Maps - ${MAPS}\n`,
    "Bao's task tab and the owner's tab on the same page are told apart; the Gemini panel and both side panels are gone");
  assert.equal((await f.proxy.execute("tab", []))[0]!.stdout, opened[1]!.stdout);
  const json = JSON.parse((await f.proxy.execute("tab", ["list", "--json"]))[0]!.stdout) as { data: { tabs: { tabId: string; baoTaskTab?: boolean }[] } };
  assert.deepEqual(json.data.tabs.map(tab => [tab.tabId, tab.baoTaskTab ?? false]), [["t1", true], ["t2", false]]);
});

test("when the native daemon makes the Gemini panel current mid-session, the next click and snapshot still land in the task tab", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  await f.proxy.execute("snapshot", ["-i"]);
  f.daemon.before = () => { f.daemon.active = "glic"; };
  const [click] = await f.proxy.execute("click", ["@e56"]);
  assert.equal(click!.stdout, "✓ Done on task\n");
  assert.deepEqual(f.daemon.commands.filter(entry => entry.command === "click").map(entry => entry.on), ["task"]);
  assert.ok(f.daemon.commands.some(entry => entry.command === "tab" && entry.args[0] === "t1" && entry.on === "glic"), "Bao switched the daemon back to its task tab");
  f.daemon.before = () => { f.daemon.active = "search"; };
  assert.equal((await f.proxy.execute("snapshot", ["-i"]))[0]!.stdout, "✓ Done on task\n");
  assert.ok(f.daemon.commands.filter(entry => entry.command !== "tab").every(entry => entry.on === "task"), "no page command ran on a panel");
});

test("the agent cannot switch to or close Chrome's own panels, but can switch to the owner's tab and stays there", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  await f.proxy.execute("tab", []);
  for (const args of [["t3"], ["close", "t3"], ["t5"]]) {
    const [result] = await f.proxy.execute("tab", args);
    assert.equal(result!.exitCode, 1);
    assert.match(result!.stderr, /is part of Chrome itself, such as the Gemini panel or a side panel, not a tab\. Stay in Bao's task tab\./);
  }
  assert.ok(!f.daemon.commands.some(entry => entry.command === "tab" && ["t3", "t5"].includes(entry.args.at(-1)!)), "the refused calls never reached the daemon");
  assert.equal((await f.proxy.execute("tab", ["t2"]))[0]!.exitCode, 0);
  await f.proxy.execute("click", ["@e1"]);
  assert.equal(f.daemon.commands.at(-1)!.on, "owner", "an explicit switch is not undone");
  assert.equal((await f.proxy.execute("tab", []))[0]!.stdout, `  [t1] (Bao task tab) Google Maps - ${MAPS}\n→ [t2] Google Maps - ${MAPS}\n`);
});

test("a tab Bao's task tab opens becomes the agent's tab, once", async (t) => {
  const f = await fixture(t);
  await f.proxy.execute("open", [MAPS], "current");
  f.daemon.clicked = () => f.targets.push({ targetId: "popup", type: "page", url: "https://www.google.com/maps/place/Ceres", title: "Ceres", openerId: "task", inWindow: true });
  assert.equal((await f.proxy.execute("click", ["@e2"]))[0]!.stdout, "✓ Done on task\n");
  await f.proxy.execute("snapshot", ["-i"]);
  assert.equal(f.daemon.commands.at(-1)!.on, "popup", "the agent follows the tab its click opened");
  assert.equal((await f.proxy.execute("tab", ["t1"]))[0]!.exitCode, 0);
  await f.proxy.execute("snapshot", ["-i"]);
  assert.equal(f.daemon.commands.at(-1)!.on, "task", "going back to the task tab is not undone by the earlier popup");
  f.targets.push({ targetId: "owner-new", type: "page", url: "https://example.com/", title: "Owner's new tab", inWindow: true });
  await f.proxy.execute("snapshot", ["-i"]);
  assert.equal(f.daemon.commands.at(-1)!.on, "task", "a tab the owner opens never takes the agent");
});
