import assert from "node:assert/strict";
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
import type { AxHit } from "../../src/proxy/os-macos";
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

test("native commands outlive the consent polling deadline", { timeout: 35_000 }, async () => {
  const f = await fixture(true);
  try {
    const chrome = await currentChrome.openCurrentChrome(f.options, f.deps);
    assert.equal(await chrome.withConsent(async (signal) => {
      await new Promise(resolve => setTimeout(resolve, 26_000));
      signal.throwIfAborted();
      return "slow native output";
    }), "slow native output");
    chrome.detach();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("failed consent closes the pending CDP connection without closing Chrome", async () => {
  const f = await fixture(true);
  try {
    const exec = f.deps.helper!.exec;
    f.deps.helper!.exec = async (args, timeout) => {
      if (args.includes("--press") && f.state.pending) throw new Error("Allow failed");
      return exec(args, timeout);
    };
    await assert.rejects(currentChrome.openCurrentChrome(f.options, f.deps), /Allow failed/);
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
  const before = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
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
  if (command === 'tab' && args.includes('new') && !fs.existsSync(${JSON.stringify(firstTab)})) {
    fs.writeFileSync(${JSON.stringify(firstTab)}, 'attempted');
    console.error('injected tab failure'); process.exitCode = 1; return;
  }
  if (command === 'close') fs.writeFileSync(${JSON.stringify(marker)}, 'closed');
  if (command === 'tab' && args.includes('new')) await fetch('http://' + endpoint.host + '/json/new?about:blank', { method: 'PUT' });
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
    const afterFailure = await cdp.send<typeof before>("Target.getTargets");
    assert.equal(afterFailure.targetInfos.filter(target => target.type === "page").length,
      before.targetInfos.filter(target => target.type === "page").length);
    assert.equal((await proxy.execute("open"))[0]!.exitCode, 0);
    await assert.rejects(proxy.execute("open", [], "copy"), /first open/);
    const afterOpen = await cdp.send<{ targetInfos: { targetId: string; type: string; attached?: boolean }[] }>("Target.getTargets");
    const pageIds = (targets: typeof afterOpen) => targets.targetInfos.filter(target => target.type === "page").map(target => target.targetId).sort();
    assert.equal(pageIds(afterOpen).length, pageIds(before).length + 1);
    assert.ok(afterOpen.targetInfos.filter(target => target.type === "page").every(target => target.attached === false), "recording detaches its per-page CDP sessions");
    const stateDir = await readFile(stateMarker, "utf8");
    await rm(path.join(stateDir, "bao.pid"));
    assert.equal((await proxy.execute("snapshot"))[0]!.exitCode, 0);
    const afterReset = await cdp.send<typeof afterOpen>("Target.getTargets");
    assert.equal(pageIds(afterReset).length, pageIds(afterOpen).length + 1);
    await proxy.execute("close");
    assert.equal(chrome.isClosed(), false);
    await assert.rejects(access(marker), /ENOENT/);
    const probe = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const afterClose = await probe.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      assert.deepEqual(pageIds(afterClose), pageIds(afterReset));
    } finally { probe.close(); }
    assert.ok(new Library(home).listRuns().some(run => run.status === "failed"));
  } finally {
    await proxy.end();
    cdp.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  }
});
