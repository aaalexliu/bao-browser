import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { INSPECT_URL } from "../../src/cdp-live/ax";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { MacOsHelper, type AxHit } from "../../src/proxy/os-macos";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { Library } from "../../src/v1/store";

pinTestBrowser();

async function fixture(on = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-chrome-"));
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
  const options = { root, defaultRoot: root, axLog: path.join(root, "ax.jsonl") };
  const deps: NonNullable<Parameters<typeof currentChrome.openCurrentChrome>[1]> = {
    helper, findChrome: async () => state.pids,
    readPort: async () => ({ port: 9222, browserPath: "/devtools/browser/fixture" }),
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
    const output = await chrome.withConsent(async () => "native output");
    assert.equal(output, "native output");
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

test("current Chrome approves native connection prompts already present when polling starts", async () => {
  const f = await fixture(true);
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    f.state.pending = true;
    assert.equal(await chrome.withConsent(async () => "reconnected"), "reconnected");
    assert.equal(f.state.pending, false);
    chrome.detach();
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
        const audit = (await readFile(f.options.axLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.equal(audit.filter(hit => hit.role === "AXCheckBox").length, mode === "pressed" ? 1 : 0);
        chrome.detach();
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("native commands outlive the consent polling deadline", async (t) => {
  const f = await fixture(true);
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return abort.signal;
    });
    const oldDeadline = AbortSignal.timeout(25_000);
    const pending = chrome.withConsent(async (signal) => {
      await new Promise(resolve => setTimeout(resolve, 26_000));
      signal.throwIfAborted();
      return "slow native output";
    });
    await Promise.resolve();
    t.mock.timers.tick(26_000);
    assert.equal(oldDeadline.aborted, true);
    assert.equal(await pending, "slow native output");
    chrome.detach();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("consent poll errors preserve effects and native results on either side of completion", async () => {
  for (const settlesFirst of [true, false]) {
    const f = await fixture(true);
    try {
      const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
      let rejectPoll!: (error: Error) => void;
      let finish!: () => void;
      let effects = 0;
      f.deps.helper!.exec = async () => new Promise<AxHit>((_resolve, reject) => { rejectPoll = reject; });
      const result = { stdout: "submitted", stderr: "native warning", exitCode: 0 };
      const pending = chrome.withConsent(async (signal) => {
        effects++;
        await new Promise<void>(resolve => { finish = resolve; });
        signal.throwIfAborted();
        return result;
      });
      if (settlesFirst) { finish(); await Promise.resolve(); await Promise.resolve(); }
      rejectPoll(new Error("helper poll failed"));
      await Promise.resolve();
      if (!settlesFirst) finish();
      assert.deepEqual(await pending, result);
      assert.equal(effects, 1);
      chrome.detach();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("startup waits for loading controls and delayed LaunchServices result files", async (t) => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let reads = 0;
  const writes: Promise<void>[] = [];
  t.mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
    const child = new EventEmitter();
    const result = args[args.indexOf("--result") + 1]!;
    const command = args[args.indexOf("--args") + 1];
    if (command === "checkbox-read") reads++;
    const hit = command === "checkbox-set" ? { ok: true, found: true, pressed: true }
      : { ok: true, found: reads > 1, value: "0" };
    writes.push(new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        now += 6000;
        writeFile(result, JSON.stringify(hit)).then(resolve, reject);
      }, 100);
    }));
    queueMicrotask(() => child.emit("close", 0));
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
    assert.equal(f.state.on, true);
    assert.equal(f.state.connected, true);
    chrome.detach();
  } finally {
    await Promise.all(writes);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a failed handshake closes the pending CDP connection without closing Chrome", async () => {
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
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), /cdp disconnected/);
    assert.equal(f.state.closed, true);
    assert.ok(!f.state.cdpCalls.some(call => call.method === "Browser.close"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("current proxy retries task-tab setup, handles daemon resets, and detaches on close", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-proxy-"));
  const home = path.join(root, "home");
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const before = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
  const marker = path.join(root, "native-close-called");
  const firstTab = path.join(root, "first-tab");
  const stateMarker = path.join(root, "native-state");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
(async () => {
  fs.writeFileSync('bao.pid', ${JSON.stringify(String(process.pid))});
  fs.writeFileSync(${JSON.stringify(stateMarker)}, process.cwd());
  const attempts = fs.existsSync(${JSON.stringify(firstTab)}) ? Number(fs.readFileSync(${JSON.stringify(firstTab)}, 'utf8')) : 0;
  if (command === 'tab' && args.includes('new') && attempts < 2) {
    fs.writeFileSync(${JSON.stringify(firstTab)}, String(attempts + 1));
    console.error('injected tab failure'); process.exitCode = 1; return;
  }
  if (command === 'close') fs.writeFileSync(${JSON.stringify(marker)}, 'closed');
  if (command === 'tab' && args.includes('new')) await fetch('http://' + endpoint.host + '/json/new?about:blank', { method: 'PUT' });
  if (command === 'open') {
    const targets = await (await fetch('http://' + endpoint.host + '/json/list')).json();
    const target = targets.find(t => t.type === 'page');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'data:text/html,<h1>Task</h1>' } }));
      socket.onmessage = event => { if (JSON.parse(event.data).id === 1) { socket.close(); resolve(); } };
      socket.onerror = reject;
    });
  }
  if (command === 'tab' && args.includes('--json')) {
    const targets = await (await fetch('http://' + endpoint.host + '/json/list')).json();
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map((t, i) => ({ targetId: t.id, active: i === 0 })) } }));
  } else console.log('native output');
})().catch(e => { console.error(e); process.exitCode = 1; });
`, { mode: 0o700 });
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  let throwConsent = false;
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, endpoint, cdp, closed: cdp.disconnected,
    isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
    withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
      if (throwConsent) { throwConsent = false; throw new Error("injected consent failure"); }
      return operation(signal ?? new AbortController().signal);
    } }));
  const proxy = new AgentBrowserProxy({ home, sourceRoot: path.join(root, "chrome"), executable, keepOpen: () => true });
  try {
    await assert.rejects(proxy.execute("open", [], "other"), /browser must/);
    await assert.rejects(proxy.execute("snapshot", [], "current"), /first open/);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    throwConsent = true;
    await assert.rejects(proxy.execute("open"), /injected consent failure/);
    await assert.rejects(proxy.execute("open"), /Native tab list failed.*injected tab failure/);
    const afterFailure = await cdp.send<typeof before>("Target.getTargets");
    assert.equal(afterFailure.targetInfos.filter(target => target.type === "page").length,
      before.targetInfos.filter(target => target.type === "page").length);
    assert.equal((await proxy.execute("open"))[0]!.exitCode, 0);
    await assert.rejects(proxy.execute("open", [], "copy"), /first open/);
    const afterOpen = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; attached?: boolean }[] }>("Target.getTargets");
    const pageIds = (targets: typeof afterOpen) => targets.targetInfos.filter(target => target.type === "page").map(target => target.targetId).sort();
    assert.equal(pageIds(afterOpen).length, pageIds(before).length + 1);
    assert.ok(afterOpen.targetInfos.filter(target => target.type === "page").every(target => target.attached === false), "recording detaches its per-page CDP sessions");
    const stateDir = await readFile(stateMarker, "utf8");
    await rm(path.join(stateDir, "bao.pid"));
    assert.equal((await proxy.execute("snapshot"))[0]!.exitCode, 0);
    const afterReset = await cdp.send<typeof afterOpen>("Target.getTargets");
    assert.equal(pageIds(afterReset).length, pageIds(afterOpen).length + 1);
    for (const owner of before.targetInfos.filter(target => target.type === "page")) {
      assert.equal(afterReset.targetInfos.find(target => target.targetId === owner.targetId)?.url, owner.url);
    }
    await proxy.execute("close");
    assert.equal(chrome.isClosed(), false);
    await assert.rejects(access(marker), /ENOENT/);
    const probe = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const afterClose = await probe.send<typeof afterOpen>("Target.getTargets");
      assert.deepEqual(pageIds(afterClose), pageIds(afterReset));
    } finally { probe.close(); }
    const library = new Library(home);
    const runs = library.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
    const steps = library.readRun(runs[0]!.id).steps as unknown as RecordedAgentBrowserCommand[];
    const opens = steps.filter(step => step.native.command === "open");
    assert.equal(opens.length, 4);
    for (const step of opens.slice(0, 3)) {
      assert.equal(step.status, "failed");
      assert.equal(step.afterShot, undefined);
    }
    assert.match(opens[2]!.native.error!, /injected tab failure/);
    for (const step of [opens[3]!, steps.find(step => step.native.command === "snapshot")!]) {
      assert.equal(step.status, "passed");
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

test("unexpected current disconnect requires a browser choice, unlike fresh or explicitly closed sessions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-ended-"));
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}\nconsole.error('tab setup failed'); process.exitCode = 1;\n`, { mode: 0o700 });
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
  let copies = 0;
  t.mock.method(profileCopy, "openCopiedChromeForProxy", async () => { copies++; throw new Error("copy startup reached"); });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const f = await fixture(true);
    fixtures.push(f);
    return { pid: 7, endpoint: { port: 9222, browserPath: "/devtools/browser/fixture" },
      cdp: f.socket, closed: f.socket.disconnected, isClosed: () => !f.socket.isOpen,
      detach: () => f.socket.close(),
      withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(signal ?? new AbortController().signal) };
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: root, executable });
  const fresh = new AgentBrowserProxy({ home: path.join(root, "fresh"), sourceRoot: root, executable });
  try {
    await assert.rejects(fresh.execute("open"), /copy startup reached/);
    assert.equal(copies, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    fixtures[0]!.socket.close();
    await assert.rejects(proxy.execute("snapshot"), /owner's Chrome session ended.*browser=current.*browser=copy/);
    await assert.rejects(proxy.execute("open"), /owner's Chrome session ended/);
    assert.equal(copies, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    assert.equal(fixtures.length, 2);
    fixtures[1]!.socket.close();
    await assert.rejects(proxy.execute("open", [], "copy"), /copy startup reached/);
    assert.equal(copies, 2);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    await proxy.execute("close");
    await assert.rejects(proxy.execute("open"), /copy startup reached/);
    assert.equal(copies, 3);
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
