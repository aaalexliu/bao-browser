import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { INSPECT_URL } from "../../src/cdp-live/ax";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import * as baoProfile from "../../src/engines/bao-profile";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { browserToolResult, pageShotLine } from "../../src/mcp/tool-card";
import { LAUNCH_SERVICES_RESTART, launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { MacOsHelper, type AxHit, type AxNode } from "../../src/proxy/os-macos";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { Library } from "../../src/v1/store";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";
import { trapPort } from "../support/trap-port";
import { LIST_TARGETS } from "../support/fake-agent-browser";

pinTestBrowser();

function axNode(partial: Pick<AxNode, "role"> & Partial<AxNode>): AxNode {
  return {
    subrole: "", title: "", description: "", identifier: "", name: "", value: "",
    actions: [], frame: null, path: [], pid: 7, app: "com.google.Chrome", useful: true,
    ...partial,
  };
}

test("inspect tab close presses that tab's Close button, not the window or another tab", () => {
  const nodes = [
    axNode({ role: "AXButton", subrole: "AXCloseButton", path: [{ role: "AXWindow", name: "Inspect with Chrome Developer Tools" }] }),
    axNode({ role: "AXRadioButton", subrole: "AXTabButton", name: "Owner tab", title: "Owner tab", description: "Owner tab", value: "true" }),
    axNode({ role: "AXButton", name: "Close", title: "Close", description: "Close", path: [{ role: "AXRadioButton", name: "Owner tab" }] }),
    axNode({ role: "AXRadioButton", subrole: "AXTabButton", name: "Inspect with Chrome Developer Tools", title: "Inspect with Chrome Developer Tools", description: "Inspect with Chrome Developer Tools", value: "false" }),
    axNode({ role: "AXButton", name: "Close", title: "Close", description: "Close", path: [{ role: "AXRadioButton", name: "Inspect with Chrome Developer Tools" }] }),
  ];
  const args = currentChrome.inspectTabCloseArgs(nodes, 7);
  assert.ok(args);
  const encoded = args[args.indexOf("--path") + 1] || "";
  assert.match(encoded, /Inspect with Chrome Developer Tools/);
  assert.doesNotMatch(encoded, /Owner tab/);
  assert.equal(args[0], "press");
  assert.equal(args.includes("close-window"), false);
  const second = axNode({
    role: "AXRadioButton", subrole: "AXTabButton",
    name: "Inspect with Chrome Developer Tools", title: "Inspect with Chrome Developer Tools",
    description: "Inspect with Chrome Developer Tools", value: "true",
  });
  assert.equal(currentChrome.inspectTabCloseArgs([...nodes, second], 7), undefined);
});

async function fixture(on = false) {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-current-chrome-")));
  const state = { on, accessibility: true, locked: false, pids: [7], pending: false, connected: false, closed: false,
    checkboxFound: true, checkboxPressed: true,
    helperCalls: [] as string[][], cdpCalls: [] as { method: string; params: Record<string, unknown> }[] };
  let approved!: () => void;
  let rejected: ((error: Error) => void) | undefined;
  let disconnected!: () => void;
  const socket = {
    get isOpen() { return !state.closed; },
    disconnected: new Promise<void>((resolve) => { disconnected = resolve; }),
    close() { state.closed = true; disconnected(); rejected?.(new Error("cdp disconnected")); },
    async send(method: string, params: Record<string, unknown> = {}) {
      state.cdpCalls.push({ method, params });
      if (method === "Browser.getVersion") {
        state.pending = true;
        await new Promise<void>((resolve, reject) => { approved = resolve; rejected = reject; });
      }
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "inspect", url: INSPECT_URL }, { targetId: "owner", url: "https://fixture.invalid/" }] };
      return {};
    },
  } as unknown as CdpSocket;
  const helper = {
    async permissions(prompt: boolean): Promise<AxHit> { assert.equal(prompt, false); return { ok: true, accessibility: state.accessibility }; },
    async screenLocked() { return state.locked; },
    async exec(args: string[]): Promise<AxHit> {
      state.helperCalls.push(args);
      assert.ok(!args[0]!.startsWith("ae-") && !["shot", "windows", "permissions"].includes(args[0]!), "no Automation, Screen Recording, or grant prompt");
      assert.equal(args[args.indexOf("--pid") + 1], "7");
      if (args[0] === "checkbox-read") return { ok: true, found: true, value: state.on ? "1" : "0" };
      if (args[0] === "checkbox-set") {
        if (state.checkboxFound) state.on = true;
        return { ok: true, found: state.checkboxFound, pressed: state.checkboxFound && state.checkboxPressed };
      }
      if (args[0] === "debug-allow") {
        if (args.includes("--press") && state.pending) {
          state.pending = false;
          approved();
          return { ok: true, found: true, pressed: true };
        }
        return { ok: true, found: state.pending, pressed: false };
      }
      return { ok: true };
    },
  };
  const options = { root, axLog: path.join(root, "ax.jsonl") };
  const deps: NonNullable<Parameters<typeof currentChrome.openCurrentChrome>[1]> = {
    helper, findChrome: async () => state.pids, executable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    readPort: async () => ({ port: await trapPort(), browserPath: "/devtools/browser/fixture" }),
    listener: async () => state.on ? 7 : undefined,
    connect: async () => { state.connected = true; return socket; },
  };
  return { root, state, options, deps, socket };
}

test("current Chrome enables debugging with the helper and approves the connection it keeps", async () => {
  const f = await fixture();
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    assert.equal(f.state.on, true);
    assert.equal(f.state.connected, true);
    assert.ok(f.state.helperCalls.some(call => call[0] === "checkbox-set"));
    assert.ok(f.state.helperCalls.some(call => call[0] === "debug-allow" && call.includes("--press")));
    assert.deepEqual(f.state.cdpCalls.filter(call => call.method === "Target.closeTarget"), [{ method: "Target.closeTarget", params: { targetId: "inspect" } }]);
    chrome.detach();
    await chrome.closed;
    assert.equal(chrome.isClosed(), true);
    assert.ok(!f.state.cdpCalls.some(call => call.method === "Browser.close"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("current Chrome leaves an enabled switch and the owner's tabs alone", async () => {
  const f = await fixture(true);
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    assert.ok(f.state.helperCalls.every(call => call[0] === "debug-allow"));
    assert.ok(!f.state.cdpCalls.some(call => call.method === "Target.closeTarget"));
    chrome.detach();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("current Chrome stops without input when Accessibility is absent, the screen is locked, or Chrome is ambiguous", async () => {
  for (const mode of ["accessibility", "locked", "missing", "ambiguous"] as const) {
    const f = await fixture();
    try {
      if (mode === "accessibility") f.state.accessibility = false;
      if (mode === "locked") f.state.locked = true;
      if (mode === "missing") f.state.pids = [];
      if (mode === "ambiguous") f.state.pids = [7, 8];
      await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps));
      assert.deepEqual(f.state.helperCalls, []);
      assert.equal(f.state.connected, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("when the owner's Chrome is not running, Bao starts it plainly and attaches with no owner click", async () => {
  const f = await fixture(true);
  try {
    f.state.pids = [];
    const started: string[] = [];
    const chrome = await currentChrome.openCurrentChrome(f.options, { ...f.deps, startChrome: async (root) => {
      started.push(root);
      setTimeout(() => { f.state.pids = [7]; }, 300);
      return true;
    } });
    assert.deepEqual(started, [f.root]);
    assert.equal(f.state.connected, true);
    assert.ok(f.state.helperCalls.every(call => call[0] === "debug-allow"), "only the Allow press, which the helper does itself");
    chrome.detach();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Bao starts Chrome only for the owner's own Chrome folder", async () => {
  const f = await fixture(true);
  try {
    f.state.pids = [];
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), /Chrome is not open/, "a fixture folder is never started");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a port wait failure closes the inspect tab Bao opened", async () => {
  const f = await fixture();
  f.deps.listener = async () => undefined;
  const exec = f.deps.helper!.exec;
  f.deps.helper!.exec = async (args, timeout) => {
    if (args[0] === "nodes") {
      return {
        ok: true,
        nodes: [
          axNode({ role: "AXRadioButton", subrole: "AXTabButton", name: "Owner tab", title: "Owner tab", description: "Owner tab", value: "true" }),
          axNode({ role: "AXButton", name: "Close", title: "Close", description: "Close", path: [{ role: "AXRadioButton", name: "Owner tab" }] }),
          axNode({ role: "AXRadioButton", subrole: "AXTabButton", name: "Inspect with Chrome Developer Tools", title: "Inspect with Chrome Developer Tools", description: "Inspect with Chrome Developer Tools", value: "false" }),
          axNode({ role: "AXButton", name: "Close", title: "Close", description: "Close", path: [{ role: "AXRadioButton", name: "Inspect with Chrome Developer Tools" }] }),
        ],
      };
    }
    return exec(args, timeout);
  };
  try {
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), /Chrome did not open its debugging port/);
    const presses = f.state.helperCalls.filter((call) => call[0] === "press");
    assert.equal(presses.length, 1);
    assert.match(presses[0]!.join(" "), /Inspect with Chrome Developer Tools/);
    assert.doesNotMatch(presses[0]!.join(" "), /Owner tab/);
    assert.equal(f.state.helperCalls.some((call) => call[0] === "close-window" || call[0] === "cg-key" || call[0]?.startsWith("ae-")), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("current Chrome reports a missing checkbox and audits only actual presses", async () => {
  for (const mode of ["missing", "unchanged", "pressed"] as const) {
    const f = await fixture();
    try {
      f.state.checkboxFound = mode !== "missing";
      f.state.checkboxPressed = mode === "pressed";
      if (mode === "missing") {
        await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), /checkbox was not found/);
        assert.equal(f.state.connected, false);
        await assert.rejects(access(f.options.axLog), /ENOENT/);
      } else {
        const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
        const audit = (await readFile(f.options.axLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { role?: string });
        assert.equal(audit.filter(hit => hit.role === "AXCheckBox").length, mode === "pressed" ? 1 : 0);
        chrome.detach();
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("startup reports a missing checkbox without launching a read after the deadline", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const budgets: (number | undefined)[] = [];
  const exec = f.deps.helper!.exec;
  f.deps.helper!.exec = async (args, timeout) => {
    if (args[0] !== "checkbox-read") return exec(args, timeout);
    budgets.push(timeout);
    const duration = [30_000, 29_650][budgets.length - 1];
    if (duration === undefined) throw new Error("os helper produced no result for checkbox-read");
    t.mock.timers.tick(duration);
    return { ok: true, found: false };
  };
  try {
    const checking = assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), {
      message: "Chrome's remote-debugging checkbox did not appear",
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(250);
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(250);
    await checking;
    assert.deepEqual(budgets, [30_000, 30_000]);
    assert.equal(f.state.connected, false);
    await assert.rejects(access(f.options.axLog), /ENOENT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("startup waits for loading controls through slow helper calls", async (t) => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let reads = 0;
  const spawned: { command: string; args: string[]; detached: boolean }[] = [];
  const writes: Promise<void>[] = [];
  t.mock.method(childProcess, "spawn", (command: string, args: string[], options: { detached?: boolean }) => {
    spawned.push({ command, args, detached: options.detached === true });
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
    if (args[0] === "checkbox-read") reads++;
    const hit = args[0] === "checkbox-set" ? { ok: true, found: true, pressed: true }
      : { ok: true, found: reads > 1, value: "0" };
    writes.push(new Promise<void>((resolve) => {
      setTimeout(() => {
        now += 6000;
        child.stdout.emit("data", Buffer.from(JSON.stringify(hit)));
        child.emit("close", 0);
        resolve();
      }, 100);
    }));
    return child;
  });
  const helper = new MacOsHelper(path.join(f.root, "FixtureHelper.app"));
  const exec = f.deps.helper!.exec;
  f.deps.helper!.exec = async (args, timeout) => {
    if (args[0] !== "checkbox-read" && args[0] !== "checkbox-set") return exec(args, timeout);
    const hit = await helper.exec(args, timeout);
    if (args[0] === "checkbox-set") f.state.on = true;
    return hit;
  };
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    assert.equal(reads, 2);
    assert.ok(spawned.length >= 3);
    for (const call of spawned) {
      assert.equal(call.command, path.join(f.root, "FixtureHelper.app", "Contents", "MacOS", "FixtureHelper"));
      assert.equal(call.detached, true);
      assert.equal(call.args.includes("--result"), false);
    }
    assert.equal(f.state.on, true);
    assert.equal(f.state.connected, true);
    chrome.detach();
  } finally {
    await Promise.all(writes);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed handshake exposes the helper reason in the public error and run record", async (t) => {
  const f = await fixture(true);
  try {
    const exec = f.deps.helper!.exec;
    f.deps.helper!.exec = async (args, timeout) => {
      if (args.includes("--press") && f.state.pending) {
        f.socket.close();
        throw new Error("Allow failed");
      }
      return exec(args, timeout);
    };
    const realOpen = currentChrome.openCurrentChrome;
    t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(f.root, "default-chrome"));
    t.mock.method(currentChrome, "openCurrentChrome", () => realOpen(f.options, f.deps));
    const executable = path.join(f.root, "native");
    await writeFile(executable, `#!${process.execPath}\nprocess.exitCode = 99;\n`, { mode: 0o700 });
    const home = path.join(f.root, "library");
    const proxy = new AgentBrowserProxy({ home, sourceRoot: f.root, executable });
    try {
      await assert.rejects(proxy.execute("open", [], "current"), (error: Error) => {
        assert.match(error.message, /cdp disconnected.*BaoOSHelper: Allow failed/);
        assert.equal((error.cause as Error).message, "cdp disconnected");
        return true;
      });
      const library = new Library(home);
      const runs = library.listRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, "failed");
      const step = library.readRun(runs[0]!.id).steps[0] as unknown as RecordedAgentBrowserCommand;
      assert.match(step.reason!, /cdp disconnected.*BaoOSHelper: Allow failed/);
      assert.equal(step.native.error, step.reason);
    } finally { await proxy.end(); }
    assert.equal(f.state.closed, true);
    assert.ok(!f.state.cdpCalls.some(call => call.method === "Browser.close"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a recovered consent poll does not taint a later connection failure", async () => {
  const f = await fixture(true);
  try {
    let recovered!: () => void;
    const recovery = new Promise<void>(resolve => { recovered = resolve; });
    let polls = 0;
    f.deps.helper!.exec = async () => {
      if (++polls === 1) throw new Error("transient helper error");
      recovered();
      return { ok: true, found: false, pressed: false };
    };
    const failure = new Error("unrelated connection failure");
    f.deps.connect = async () => {
      await recovery;
      throw failure;
    };
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), (error: Error) => {
      assert.equal(error, failure);
      assert.equal(error.message, "unrelated connection failure");
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.ok(polls >= 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const ending of ["close", "finish", "disconnect"] as const) test(`current proxy drives a background task tab and closes only task tabs on ${ending}`, { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-proxy-"));
  const home = path.join(root, "home");
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  await cdp.send("Target.createTarget", { url: "about:blank" });
  const before = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; attached?: boolean }[] }>("Target.getTargets");
  const marker = path.join(root, "native-close-called");
  const stateMarker = path.join(root, "native-state");
  const executable = path.join(root, "native");
  // Like Chrome in approval mode, Bao's shared endpoint has no /json routes and no page sockets: the native agent uses the browser socket.
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
const url = args[args.indexOf('--cdp') + 1];
${LIST_TARGETS}
const navigate = (targetId, to) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
  socket.onerror = () => reject(new Error('CDP connection failed'));
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.id === 1) socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: to }, sessionId: message.result.sessionId }));
    if (message.id === 2) { socket.close(); resolve(); }
  };
});
(async () => {
  fs.writeFileSync(${JSON.stringify(stateMarker)}, process.cwd());
  const bound = JSON.parse(fs.readFileSync('bao.target', 'utf8')).targetId;
  if (command === 'close') fs.writeFileSync(${JSON.stringify(marker)}, 'closed');
  if (command === 'open') await navigate(bound, 'data:text/html,<h1>Task</h1>');
  if (command === 'tab' && args.includes('--json')) {
    const targets = await listTargets(url);
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map(t => ({ targetId: t.id, active: t.id === bound })) } }));
  } else console.log('native output');
})().catch(e => { console.error(e); process.exitCode = 1; });
`, { mode: 0o700 });
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const send = cdp.send.bind(cdp);
  t.mock.method(cdp, "send", (method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
    sent.push({ method, params });
    return send(method, params, sessionId, timeoutMs);
  });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot: path.join(root, "chrome"), executable, keepOpen: () => true });
  try {
    await assert.rejects(proxy.execute("open", [], "other"), /must be copy, bao, or current/);
    await assert.rejects(proxy.execute("snapshot", [], "current"), /only accepted on open/);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 0);
    await assert.rejects(proxy.execute("open", [], "copy"), /first open/);
    assert.deepEqual(sent.filter(call => call.method === "Target.createTarget").map(call => call.params),
      [{ url: "chrome://version", background: true, hidden: true }, { url: "about:blank", background: true }], "a hidden chrome://version tab names the default profile");
    assert.ok(sent.some(call => call.method === "Emulation.setFocusEmulationEnabled" && call.params?.enabled === true));
    const binding = JSON.parse(await readFile(path.join(await readFile(stateMarker, "utf8"), "bao.target"), "utf8")) as { targetId: string };
    const afterOpen = await cdp.send<typeof before>("Target.getTargets");
    const pages = (targets: typeof before) => targets.targetInfos.filter(target => target.type === "page");
    const pageIds = (targets: typeof before) => pages(targets).map(target => target.targetId).sort();
    assert.deepEqual(pageIds(afterOpen), [...pageIds(before), binding.targetId].sort());
    assert.equal(pages(afterOpen).find(target => target.targetId === binding.targetId)?.url, "data:text/html,<h1>Task</h1>");
    assert.ok(pages(afterOpen).every(target => target.attached === (target.targetId === binding.targetId)),
      "only Bao's focus-emulation session stays attached; recording detaches its per-page sessions");
    assert.equal((await proxy.execute("snapshot"))[0]!.exitCode, 0);
    const probe = await connectCdp(endpoint.port, endpoint.browserPath);
    let destroyed!: () => void;
    const taskDestroyed = new Promise<void>(resolve => { destroyed = resolve; });
    probe.on("Target.targetDestroyed", undefined, params => { if (params.targetId === binding.targetId) destroyed(); });
    await probe.send("Target.setDiscoverTargets", { discover: true });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (ending === "finish") await proxy.finishTask({ outcome: "passed", reason: "Task finished." });
      else if (ending === "disconnect") await proxy.end();
      else await proxy.execute("close");
      assert.equal(chrome.isClosed(), false);
      await assert.rejects(access(marker), /ENOENT/);
      // Target.closeTarget acknowledges the request before Chromium destroys the tab.
      await Promise.race([taskDestroyed, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("the task tab did not close")), 1000);
      })]);
      const afterClose = await probe.send<typeof before>("Target.getTargets");
      assert.deepEqual(pageIds(afterClose), pageIds(before), "the task tab closes; every pre-existing owner tab survives");
      for (const owner of pages(before)) assert.equal(pages(afterClose).find(target => target.targetId === owner.targetId)?.url, owner.url);
    } finally { clearTimeout(deadline); probe.close(); }
    const library = new Library(home);
    const runs = library.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "passed");
    const steps = library.readRun(runs[0]!.id).steps as unknown as RecordedAgentBrowserCommand[];
    assert.deepEqual(steps.map(step => step.native.command), ["open", "snapshot", ...(ending === "close" ? ["close"] : [])]);
    assert.deepEqual(steps[0]!.native.results, [
      { stdout: "native output\n", stderr: "", exitCode: 0 },
      { stdout: "native output\n", stderr: "", exitCode: 0 },
    ]);
    for (const step of steps.slice(0, 2)) {
      assert.equal(step.status, "passed");
      // The current route runs only on a Mac, where Chrome captures a background tab. Linux Chromium often
      // never answers Page.captureScreenshot for a hidden tab, so there the step must record the missing picture.
      if (process.platform !== "darwin" && !step.afterShot) {
        assert.match(step.afterShotError ?? "", /^Page screenshot unavailable/);
        continue;
      }
      assert.ok(step.afterShot);
      await access(path.join(home, "shots", "runs", runs[0]!.id, step.afterShot));
    }
  } finally {
    await proxy.end();
    cdp.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function lifecycleFixture(t: TestContext, keepOpen = false) {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-lifecycle-")));
  fakeTaskTab(t);
  const home = path.join(root, "home");
  const executable = path.join(root, "native");
  await writeFile(executable, "", { mode: 0o700 });
  const stateDirs = new Set<string>();
  const state = { closed: false, tabs: 0, commands: [] as string[], trackingFails: false, cleanupFails: false, setupFails: false, activations: [] as unknown[],
    windowState: undefined as string | undefined, windowStates: [] as unknown[], closeTargetFails: false, hold: false, closes: 0, kept: 0, taskGone: false, noActivePage: false,
    activeTarget: "task", captures: [] as string[], failCapture: "", missActive: false, infoReads: 0, failInfoAfter: 0,
    taskUrl: "https://fixture.invalid/", taskTitle: "Task",
    onSnapshot: undefined as ((resume: () => void) => void) | undefined,
    onClose: undefined as (() => Promise<void>) | undefined };
  let disconnected!: () => void;
  const cdp = {
    get isOpen() { return !state.closed; },
    disconnected: new Promise<void>(resolve => { disconnected = resolve; }),
    close() { state.closed = true; disconnected(); },
    async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
      if (method === "Target.createTarget") {
        assert.deepEqual(params, { url: "about:blank", background: true });
        state.tabs++;
        return { targetId: "task" };
      }
      if (method === "Emulation.setFocusEmulationEnabled" && state.setupFails) throw new Error("setup failed");
      if (method === "Target.activateTarget") state.activations.push(params);
      if (method === "Browser.getWindowForTarget" && state.windowState) return { windowId: 4 };
      if (method === "Browser.getWindowBounds" && state.windowState) return { bounds: { windowState: state.windowState } };
      if (method === "Browser.setWindowBounds") state.windowStates.push((params.bounds as { windowState: string }).windowState);
      if (method === "Target.getTargets") {
        if (state.cleanupFails) throw new Error("cleanup failed");
        return { targetInfos: state.taskGone ? [] : [{ targetId: "task", url: "https://fixture.invalid/", title: "Task" }] };
      }
      if (method === "Target.closeTarget") {
        state.closes++;
        if (state.closeTargetFails) throw new Error("target already gone");
      }
      if (method === "Target.getTargetInfo") {
        const id = String(params.targetId || "");
        if (state.missActive && id === state.activeTarget) throw new Error("cdp timeout Target.getTargetInfo");
        if (state.failInfoAfter && id === state.activeTarget && ++state.infoReads > state.failInfoAfter) throw new Error("cdp timeout Target.getTargetInfo");
        if (id === "glic") return { targetInfo: { url: "https://gemini.google.com/glic?hl=en-US", type: "page", title: "Gemini" } };
        if (id === "login") return { targetInfo: { url: "https://fixture.invalid/login", type: "page", title: "Sign in" } };
        if (id === "task") return { targetInfo: { url: state.taskUrl, type: "page", title: state.taskTitle } };
        return { targetInfo: { url: "https://fixture.invalid/other", type: "page", title: "Other" } };
      }
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (method === "Runtime.evaluate") return { result: { value: 1 } };
      if (method === "Target.attachToTarget") return { sessionId: String(params.targetId || "page") };
      if (method === "Page.captureScreenshot") {
        state.captures.push(sessionId || "");
        if (sessionId && sessionId === state.failCapture) throw new Error("side panel did not answer");
        return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=" };
      }
      return {};
    },
  } as unknown as CdpSocket;
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    if (state.closed) throw new Error("reconnect startup reached");
    return { pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root, endpoint: { port: await trapPort(), browserPath: "/browser" },
      cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close() };
  });
  t.mock.method(profileCopy, "openCopiedChromeForProxy", async () => ({ target: { portFile: "unused" },
    closed: cdp.disconnected, isClosed: () => !cdp.isOpen,
    close: async () => { state.closes++; await state.onClose?.(); cdp.close(); }, keepOpen: async () => { state.kept++; } }));
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    const command = args[args.indexOf("--idle-timeout") + 2]!;
    const tracking = state.commands.at(-1) === "tab new" && args.includes("--json");
    state.commands.push(command === "tab" && args.includes("new") ? "tab new" : command);
    stateDirs.add(String(options.cwd));
    void writeFile(path.join(String(options.cwd), "bao.pid"), String(process.pid)).then(() => {
      if (state.trackingFails && tracking) {
        state.trackingFails = false;
        callback(Object.assign(new Error("tracking failed"), { code: 1 }), "", "tracking failed");
      } else if (command === "snapshot" && state.onSnapshot) state.onSnapshot(() => callback(null, "snapshot result", ""));
      else if (command === "get" && args.includes("box")) callback(null, JSON.stringify({ data: { x: 12, y: 24, width: 36, height: 18 } }), "");
      else callback(null, args.includes("--json") ? JSON.stringify({ data: { tabs: state.noActivePage ? [] : [{ active: true, targetId: state.activeTarget }] } }) : "native output", "");
    });
    return new EventEmitter();
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot: root, executable, keepOpen: () => keepOpen, hasHold: () => state.hold });
  t.after(async () => {
    state.cleanupFails = false;
    await proxy.end();
    for (const dir of stateDirs) await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return { proxy, state, cdp, library: new Library(home) };
}

const TASK_TAB_PICTURE = "The active tab could not be pictured, so Bao kept a picture of its task tab.";

async function picturedStep(f: Awaited<ReturnType<typeof lifecycleFixture>>, command = "snapshot") {
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  f.state.captures.length = 0;
  await f.proxy.execute(command);
  const steps = f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[];
  return steps.at(-1)!;
}

test("a side panel keeps the task tab's picture instead of waiting on the panel", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.activeTarget = "glic";
  const step = await picturedStep(f);
  assert.equal(step.afterShotError, undefined);
  assert.ok(step.afterShot);
  assert.equal(step.shotNote, TASK_TAB_PICTURE);
  assert.deepEqual(f.state.captures, ["task"]);
});

test("a capture failure on the active tab keeps the task tab's picture", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.activeTarget = "other";
  f.state.failCapture = "other";
  const step = await picturedStep(f);
  assert.equal(step.afterShotError, undefined);
  assert.ok(step.afterShot);
  assert.equal(step.shotNote, TASK_TAB_PICTURE);
  assert.deepEqual(f.state.captures, ["other", "task"]);
});

const LOGIN_TASK = { taskUrl: "https://fixture.invalid/login", taskTitle: "Sign in" };

function assertPrivatePicture(step: RecordedAgentBrowserCommand, captures: readonly string[]) {
  assert.equal(step.afterShot, undefined);
  assert.equal(step.afterTarget, undefined);
  assert.equal(step.target, undefined);
  assert.match(step.afterShotError ?? "", /owner input is private/);
  assert.equal(captures.includes("task"), false);
  assert.equal(pageShotLine(step), undefined);
}

test("a side panel does not picture a sign-in task tab", async (t) => {
  const f = await lifecycleFixture(t);
  Object.assign(f.state, { activeTarget: "glic", ...LOGIN_TASK });
  const step = await picturedStep(f);
  assertPrivatePicture(step, f.state.captures);
});

test("a capture failure does not fall back to a sign-in task tab", async (t) => {
  const f = await lifecycleFixture(t);
  Object.assign(f.state, { activeTarget: "other", failCapture: "other", ...LOGIN_TASK });
  const step = await picturedStep(f);
  assertPrivatePicture(step, f.state.captures);
  assert.deepEqual(f.state.captures, ["other"]);
});

test("an active target that does not answer is pictured from a safe task tab", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  f.state.activeTarget = "silent";
  f.state.failInfoAfter = 1;
  f.state.captures.length = 0;
  await assert.rejects(f.proxy.execute("snapshot"), /Target.getTargetInfo/);
  const step = (f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.equal(step.native.command, "snapshot");
  assert.ok(step.afterShot);
  assert.equal(step.shotNote, TASK_TAB_PICTURE);
  assert.equal(step.afterShotError, undefined);
  assert.equal(pageShotLine(step), TASK_TAB_PICTURE);
  assert.deepEqual(f.state.captures, ["task"]);
});

test("an active target that does not answer does not picture a sign-in task tab", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  Object.assign(f.state, { activeTarget: "silent", failInfoAfter: 1, captures: [], ...LOGIN_TASK });
  await assert.rejects(f.proxy.execute("snapshot"), /Target.getTargetInfo/);
  const step = (f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assertPrivatePicture(step, f.state.captures);
});

test("a failed active-tab lookup stops the command", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  f.state.missActive = true;
  f.state.activeTarget = "silent";
  const before = f.state.commands.length;
  await assert.rejects(f.proxy.execute("snapshot"), /Target.getTargetInfo/);
  assert.equal(f.state.commands.slice(before).includes("snapshot"), false);
  assert.equal((f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[]).at(-1)!.native.command, "open");
});

test("a failed active-tab lookup stops a copy command", async (t) => {
  const f = await lifecycleFixture(t);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: await trapPort(), browserPath: "/browser" }));
  const socket = await import("../../src/cdp-live/socket");
  t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
  await f.proxy.execute("open", [], "copy");
  f.state.missActive = true;
  f.state.activeTarget = "task";
  const before = f.state.commands.length;
  await assert.rejects(f.proxy.execute("snapshot"), /Target.getTargetInfo/);
  assert.equal(f.state.commands.slice(before).includes("snapshot"), false);
});

test("a task-tab fallback picture does not keep the active tab's box", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.activeTarget = "glic";
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  f.state.captures.length = 0;
  await f.proxy.execute("click", ["@e1"]);
  const step = (f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.equal(step.beforeShot, undefined);
  assert.equal(step.target, undefined);
  assert.equal(step.afterTarget, undefined);
  assert.ok(step.afterShot);
  assert.equal(step.shotNote, TASK_TAB_PICTURE);
});

test("a picture of the active tab keeps the measured box", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", ["https://fixture.invalid/item"], "current");
  f.state.captures.length = 0;
  await f.proxy.execute("click", ["@e1"]);
  const step = (f.library.readRun(f.library.listRuns()[0]!.id).steps as RecordedAgentBrowserCommand[]).at(-1)!;
  assert.ok(step.beforeShot);
  assert.deepEqual(step.target, { rect: { x: 12, y: 24, width: 36, height: 18 }, viewport: { width: 800, height: 600 } });
  assert.equal(step.shotNote, undefined);
});

test("a halted open does not add the owner-privacy picture line", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.activeTarget = "login";
  const results = await f.proxy.execute("open", ["https://fixture.invalid/login"], "current");
  const run = f.library.readRun(f.library.listRuns()[0]!.id);
  const step = (run.steps as RecordedAgentBrowserCommand[]).at(-1)!;
  const reply = browserToolResult("open", results, { runId: run.id, step, steps: run.steps as RecordedAgentBrowserCommand[] });
  assert.equal(step.native.command, "open");
  assert.equal(step.afterShot, undefined);
  assert.equal(step.afterShotError, "Owner input is private; no page screenshot or snapshot was taken.");
  assert.equal(pageShotLine(step), undefined);
  assert.equal(reply.content.some((item) => /owner input is private/i.test(item.text) || item.text.startsWith("Page screenshot unavailable")), false);
  assert.deepEqual(f.state.captures, []);
});

for (const keepOpen of [false, true]) test(`idle backstop releases an owned session with keep-open=${keepOpen}`, async (t) => {
  const f = await lifecycleFixture(t, keepOpen);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: await trapPort(), browserPath: "/browser" }));
  const socket = await import("../../src/cdp-live/socket");
  t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
  await f.proxy.execute("open", [], "copy");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await f.proxy.execute("snapshot");
  t.mock.timers.tick(599_999);
  assert.equal(f.proxy.hasSession(), true);
  t.mock.timers.tick(1);
  while (f.proxy.hasSession()) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.state.closes, keepOpen ? 0 : 1);
  assert.equal(f.state.kept, keepOpen ? 1 : 0);
  assert.equal(f.library.listRuns()[0]!.status, "failed");
  assert.match(f.library.listRuns()[0]!.envelope!.reason!, /never finished the task, so Bao ended the session/);
});

for (const reset of ["finish", "close"] as const) test(`current idle expiry preserves browser choice until explicit ${reset}`, async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await f.proxy.execute("snapshot");
  t.mock.timers.tick(599_999);
  await f.proxy.execute("snapshot");
  t.mock.timers.tick(599_999);
  assert.equal(f.proxy.hasSession(), true);
  f.state.hold = true;
  t.mock.timers.tick(1_200_000);
  assert.equal(f.proxy.hasSession(), true);
  f.state.hold = false;
  t.mock.timers.tick(600_000);
  while (f.proxy.hasSession()) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.state.closes, 0);
  assert.equal(f.state.closed, true);
  assert.equal(f.library.listRuns()[0]!.status, "failed");
  await assert.rejects(f.proxy.execute("snapshot"), /owner's Chrome session ended/);
  await assert.rejects(f.proxy.execute("open"), /owner's Chrome session ended/);
  if (reset === "finish") await f.proxy.finishTask({ outcome: "failed", reason: "Task expired" });
  else await f.proxy.execute("close");
  await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
});

for (const missing of ["task", "active-page"] as const) test(`closing the waiting current ${missing} releases the session for reconnect`, async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  if (missing === "task") {
    await f.proxy.execute("wait_for_owner", ["1"]);
    f.state.taskGone = true;
  } else f.state.noActivePage = true;
  const [result] = await f.proxy.execute("wait_for_owner", ["60000"]);
  const receipt = JSON.parse(result!.stdout) as { outcome: string };
  assert.equal(receipt.outcome, "closed");
  assert.equal(f.proxy.hasSession(), false);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.closes, missing === "task" ? 0 : 1);
  assert.equal(f.library.listRuns()[0]!.envelope?.reason, "session_closed");
  await assert.rejects(f.proxy.execute("open"), /owner's Chrome session ended/);
  await assert.rejects(f.proxy.execute("open", [], "current"), /reconnect startup reached/);
});

for (const keepOpen of [false, true]) test(`a copied session whose waiting tab closed still expires with keep-open=${keepOpen}`, async (t) => {
  const f = await lifecycleFixture(t, keepOpen);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: await trapPort(), browserPath: "/browser" }));
  const socket = await import("../../src/cdp-live/socket");
  t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
  await f.proxy.execute("open", [], "copy");
  await f.proxy.execute("wait_for_owner", ["50"]);
  assert.deepEqual(f.state.activations, [{ targetId: "task" }], "the owner's handoff brings Bao's window forward");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  f.state.taskGone = true;
  const [result] = await f.proxy.execute("wait_for_owner", ["60000"]);
  const receipt = JSON.parse(result!.stdout) as { outcome: string };
  assert.equal(receipt.outcome, "closed");
  assert.equal(f.proxy.hasSession(), true);
  t.mock.timers.tick(599_999);
  assert.equal(f.state.closed, false);
  t.mock.timers.tick(1);
  while (f.proxy.hasSession()) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.state.closes, keepOpen ? 0 : 1);
  assert.equal(f.state.kept, keepOpen ? 1 : 0);
  assert.equal(f.library.listRuns()[0]!.envelope?.reason, "session_closed");
});

for (const [windowState, raise] of [["normal", ["minimized", "normal"]], ["minimized", ["normal"]], ["maximized", ["minimized", "normal", "maximized"]], ["fullscreen", []]] as const) {
  test(`a Mac copy's handoff brings a ${windowState} window back on top only when it can, and says so only then`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    t.after(() => { Object.defineProperty(process, "platform", platform); });
    const f = await lifecycleFixture(t);
    const endpoint = await import("../../src/cdp-live/endpoint");
    t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: await trapPort(), browserPath: "/browser" }));
    const socket = await import("../../src/cdp-live/socket");
    t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
    f.state.windowState = windowState;
    await f.proxy.execute("open", [], "copy");
    const [result] = await f.proxy.execute("wait_for_owner", ["50"]);
    assert.deepEqual(f.state.windowStates, raise, "a window from the Dock lands on top; a zoomed one returns zoomed; a full-screen Space stays put");
    const { instruction } = JSON.parse(result!.stdout) as { instruction: string };
    assert.equal(instruction.includes("Bao brought this window to the front"), raise.length > 0);
  });
}

test("finish_task during async window cleanup applies the same session's checked outcome", async (t) => {
  const f = await lifecycleFixture(t);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: await trapPort(), browserPath: "/browser" }));
  const socket = await import("../../src/cdp-live/socket");
  t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
  await f.proxy.execute("open", [], "copy");
  const runId = f.proxy.activeRunId!;
  let release!: () => void;
  let started!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { started = resolve; });
  const cleanupHeld = new Promise<void>(resolve => { release = resolve; });
  f.state.onClose = () => { started(); return cleanupHeld; };
  try {
    f.cdp.close();
    await cleanupStarted;
    assert.equal(f.proxy.hasSession(), true);
    assert.equal(f.library.readRun(runId).status, "passed");
    assert.equal(f.library.readRun(runId).envelope, undefined);
    const finishing = f.proxy.finishTask({ outcome: "failed", reason: "Checked result was unavailable" });
    release();
    assert.equal(await finishing, runId);
    assert.equal(f.library.readRun(runId).status, "failed");
    assert.equal(f.library.readRun(runId).envelope?.reason, "Checked result was unavailable");
    assert.equal(f.proxy.hasSession(), false);
    assert.equal(f.state.closes, 1, "finish joins existing cleanup rather than starting another path");
  } finally { release(); }
});

test("idle backstop never interrupts an active agent command", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await f.proxy.execute("snapshot");
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  f.state.onSnapshot = (resume) => { release = resume; started(); };
  const command = f.proxy.execute("snapshot");
  await pending;
  t.mock.timers.tick(1_800_000);
  assert.equal(f.proxy.hasSession(), true);
  assert.equal(f.state.closed, false);
  release();
  assert.equal((await command)[0]!.stdout, "snapshot result");
  t.mock.timers.reset();
});

test("disconnect during an owner wait closes task tabs before detaching", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  // A 1 ms wait can expire before the first poll reaches the banner, so give that poll room to run.
  await f.proxy.execute("wait_for_owner", ["200"]);
  assert.deepEqual(f.state.activations, [{ targetId: "task" }], "the owner wait brings the background task tab forward");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.timers.tick(1_800_000);
  assert.equal(f.proxy.hasSession(), true, "an owner handoff never expires");
  t.mock.timers.reset();
  const waiting = f.proxy.execute("wait_for_owner", ["60000"]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const ending = f.proxy.end();
  await waiting;
  await ending;
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.closed, true);
  assert.equal(f.library.listRuns()[0]!.envelope?.reason, "session_closed");
});

for (const ending of ["finish", "close"] as const) test(`cleanup failure on ${ending} releases ownership without rewriting the run`, async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  f.state.cleanupFails = true;
  await assert.rejects(ending === "finish" ? f.proxy.finishTask({ outcome: "passed", reason: "Checked result" }) : f.proxy.execute("close"), /cleanup failed/);
  assert.equal(f.proxy.hasSession(), false);
  const run = f.library.listRuns()[0]!;
  assert.equal(run.status, "passed");
  if (ending === "finish") assert.equal(run.envelope?.reason, "Checked result");
  await f.proxy.finishTask({ outcome: "passed", reason: "No session" });
  await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
});

test("finish_task after a lost current session clears the browser-choice restriction", async (t) => {
  const f = await lifecycleFixture(t);
  await f.proxy.execute("open", [], "current");
  f.cdp.close();
  while (f.proxy.hasSession()) await new Promise<void>(resolve => setImmediate(resolve));
  await f.proxy.finishTask({ outcome: "passed", reason: "Task ended" });
  await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
});

test("failed task-tab setup closes its tab and detaches before any native command", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.setupFails = true;
  await assert.rejects(f.proxy.execute("open", [], "current"), /setup failed/);
  assert.equal(f.state.tabs, 1);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.closed, true);
  assert.deepEqual(f.state.commands, []);
  assert.equal(f.proxy.hasSession(), false);
});

test("failed tracking of an agent-opened tab forwards commands without repeating setup and tolerates a vanished target", async (t) => {
  const f = await lifecycleFixture(t);
  assert.equal((await f.proxy.execute("open", [], "current"))[0]!.exitCode, 0);
  await f.proxy.execute("snapshot");
  assert.ok(f.state.commands.includes("open"));
  f.state.trackingFails = true;
  assert.equal((await f.proxy.execute("tab", ["new"]))[0]!.exitCode, 0);
  assert.equal(f.state.tabs, 1);
  f.state.closeTargetFails = true;
  await f.proxy.finishTask({ outcome: "passed", reason: "Checked result" });
  assert.equal(f.state.closes, 1);
  assert.equal(f.proxy.hasSession(), false);
  assert.equal(f.library.listRuns()[0]!.status, "passed");
});

test("unexpected current disconnect requires a browser choice, unlike fresh or explicitly closed sessions", async (t) => {
  const root = await chromeProfiles(await mkdtemp(path.join(tmpdir(), "bao-current-ended-")));
  fakeTaskTab(t);
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}\nconsole.error('tab setup failed'); process.exitCode = 1;\n`, { mode: 0o700 });
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  let copies = 0;
  let lasting = 0;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(root, "default-chrome"));
  t.mock.method(profileCopy, "openCopiedChromeForProxy", async () => { copies++; throw new Error("copy startup reached"); });
  t.mock.method(baoProfile, "openBaoChromeForProxy", async () => { lasting++; throw new Error("Bao startup reached"); });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const f = await fixture(true);
    fixtures.push(f);
    return { pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root, endpoint: { port: await trapPort(), browserPath: "/devtools/browser/fixture" },
      cdp: f.socket, closed: f.socket.disconnected, isClosed: () => !f.socket.isOpen,
      detach: () => f.socket.close() };
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: root, executable });
  const fresh = new AgentBrowserProxy({ home: path.join(root, "fresh"), sourceRoot: root, executable });
  try {
    await assert.rejects(fresh.execute("open", [], "bao"), /Bao startup reached/);
    assert.equal(lasting, 1);
    assert.equal(copies, 0);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    fixtures[0]!.socket.close();
    await assert.rejects(proxy.execute("snapshot"), /owner's Chrome session ended.*browser=current.*browser=bao/);
    await assert.rejects(proxy.execute("open"), /owner's Chrome session ended/);
    assert.equal(copies, 0);
    assert.equal(lasting, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    assert.equal(fixtures.length, 2);
    fixtures[1]!.socket.close();
    await assert.rejects(proxy.execute("open", [], "copy"), /copy startup reached/);
    assert.equal(copies, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    await proxy.execute("close");
    assert.equal((await proxy.execute("open"))[0]!.exitCode, 1, "after an explicit close, an open with no browser takes the default, running Chrome");
    assert.equal(fixtures.length, 4);
    assert.equal(lasting, 1);
    assert.equal(copies, 1);
  } finally {
    await proxy.end();
    await fresh.end();
    for (const f of fixtures) {
      f.socket.close();
      await rm(f.root, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

/** The profile folder of the tab's own browser context, read from chrome://version in that tab. */
async function tabProfile(cdp: CdpSocket, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.navigate", { url: "chrome://version" }, sessionId);
    for (let tries = 0; tries < 100; tries++) {
      const { result } = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate",
        { expression: "document.getElementById('profile_path')?.textContent || ''", returnByValue: true }, sessionId);
      if (result.value) return result.value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("chrome://version never named the profile");
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); }
}

// Chrome hands a second launch's command line to the running browser only when that browser has a window, so this needs a headed Mac Chrome.
test("Bao's task tab opens in a window of the chosen Chrome profile and never in another one", {
  skip: process.env.BAO_LANE === "live" || process.env.BAO_LIVE_TESTS === "1"
    ? process.platform !== "darwin" && "a headed test Chrome is Mac-only here"
    : "a headed browser belongs in the live lane",
  timeout: 90_000,
}, async (t) => {
  const root = await chromeProfiles(await realpath(await mkdtemp(path.join(tmpdir(), "bao-task-profile-"))),
    { Default: { name: "Alex", user_name: "alex@example.test" }, "Profile 1": { name: "Work", user_name: "alex@work.test" } });
  const owner = await launchOwnedChromeEndpoint({ userDataDir: root, headless: false, args: ["--profile-directory=Default"] });
  const endpoint = await readDevToolsActivePort(owner.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  t.after(async () => { cdp.close(); await owner.close(); await rm(root, { recursive: true, force: true }); });
  const chrome = { cdp, root, executable: pinTestBrowser() };

  await assert.rejects(currentChrome.openTaskTab({ ...chrome, executable: "/usr/bin/true" }, "Profile 1"),
    { message: `Bao could not open a tab in Chrome profile "Profile 1" of ${root}, so it stopped. It did not use another profile.` });
  const { targetInfos } = await cdp.send<{ targetInfos: { type: string; url: string }[] }>("Target.getTargets");
  assert.ok(!targetInfos.some(target => target.type === "page" && target.url.startsWith("about:blank")), "no tab opened in the default profile instead");

  const home = await currentChrome.openTaskTab(chrome, "Default");
  assert.equal(home.background, true, "the profile used last takes a background tab");
  assert.equal(await tabProfile(cdp, home.targetId), path.join(root, "Default"));

  const work = await currentChrome.openTaskTab(chrome, "Profile 1");
  assert.equal(work.background, false, "another profile's tab comes from Chrome's own command line");
  assert.equal(await tabProfile(cdp, work.targetId), path.join(root, "Profile 1"));
});

test("a refused Chrome folder stops Running Chrome before the helper touches Chrome", async () => {
  const f = await fixture();
  const { chmod } = await import("node:fs/promises");
  await chmod(f.root, 0o000);
  try {
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps),
      (error: Error) => error.name === "ChromeFolderDenied" && error.message.startsWith(`macOS did not let Bao read Google Chrome's folder (EACCES on ${f.root}).`));
    assert.deepEqual(f.state.helperCalls, []);
    assert.equal(f.state.on, false, "remote debugging stays off");
  } finally { await chmod(f.root, 0o700); await rm(f.root, { recursive: true, force: true }); }
});

test("a refused DevToolsActivePort read is reported as refused, not as a closed debugging port", async () => {
  const f = await fixture(true);
  const file = path.join(f.root, "DevToolsActivePort");
  try {
    await assert.rejects(currentChrome.openCurrentChrome(f.options, { ...f.deps,
      readPort: async () => { throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: "EPERM", path: file }); } }),
    (error: Error) => error.message.startsWith(`macOS did not let Bao read Google Chrome's folder (EPERM on ${file}).`) && !/debugging port/.test(error.message));
    assert.deepEqual(f.state.helperCalls, [], "Bao does not open chrome://inspect when it cannot read the port file");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("Bao starts the owner's closed Chrome in the background as a new instance, and only on his own Chrome folder", async () => {
  const runs: { file: string; args: string[]; home?: string }[] = [];
  const run = async (file: string, args: string[], env: NodeJS.ProcessEnv) => { runs.push({ file, args, home: env.HOME }); };
  const ready = async () => {};
  const owner = path.join(tmpdir(), "owner-chrome");
  assert.equal(await currentChrome.startOwnerChrome(owner, owner, run, ready), true);
  // open(1): -n opens a new instance even when one runs, -g keeps it in the background, -b names the app by bundle id.
  assert.deepEqual(runs, [{ file: "/usr/bin/open", args: ["-n", "-g", "-b", "com.google.Chrome"], home: userInfo().homedir }]);
  assert.equal(await currentChrome.startOwnerChrome(path.join(tmpdir(), "bao-profile"), owner, run, ready), false, "a Bao-owned folder never starts Chrome");
  assert.equal(runs.length, 1);
  await assert.rejects(currentChrome.startOwnerChrome(owner, owner, async () => { throw new Error("exit 1"); }, ready), { message: "Bao could not start Google Chrome: exit 1" });
});

test("a stalled LaunchServices probe does not open the owner's Chrome", async () => {
  const runs: string[] = [];
  const owner = path.join(tmpdir(), "owner-chrome");
  const stalled = "Unable to block on application (GetProcessPID() returned 18446744073709551016)\n";
  let probed: string[] | undefined;
  await assert.rejects(currentChrome.startOwnerChrome(owner, owner, async () => { runs.push("open"); }, async () => {
    await currentChrome.assertLaunchServicesReady(async (args) => { probed = args; return { stderr: stalled }; });
  }), { message: LAUNCH_SERVICES_RESTART });
  assert.deepEqual(runs, [], "Chrome is not opened");
  assert.ok(probed?.includes("-W"), "the probe waits, so a stall is visible");
  assert.ok(probed?.includes("screen-locked"));
  assert.equal(probed?.includes("-b"), false, "the probe is not Chrome");
});

test("an open probe that already wrote its result is not a LaunchServices stall", async () => {
  const runs: string[] = [];
  const owner = path.join(tmpdir(), "owner-chrome");
  const stalled = "Unable to block on application (GetProcessPID() returned 18446744073709551016)\n";
  assert.equal(await currentChrome.startOwnerChrome(owner, owner, async () => { runs.push("open"); }, async () => {
    await currentChrome.assertLaunchServicesReady(async (args) => {
      const token = args[args.indexOf("--result") + 1];
      if (!token) throw new Error("probe did not pass --result");
      await writeFile(token, "{}\n");
      return { stderr: stalled };
    });
  }), true);
  assert.deepEqual(runs, ["open"], "Chrome still starts when the helper ran");
});
