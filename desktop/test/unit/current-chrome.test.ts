import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { CdpSocket } from "../../src/cdp-live/socket";
import * as runningChrome from "../../src/extension/running-chrome";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import * as baoProfile from "../../src/engines/bao-profile";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { Library } from "../../src/v1/store";

async function lifecycleFixture(t: TestContext, keepOpen = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-lifecycle-"));
  const home = path.join(root, "home");
  const executable = path.join(root, "native");
  await writeFile(executable, "", { mode: 0o700 });
  const stateDirs = new Set<string>();
  const state = { closed: false, tabs: 0, commands: [] as string[], cleanupFails: false, setupFails: false, activations: [] as unknown[],
    hold: false, closes: 0, kept: 0, taskGone: false, noActivePage: false,
    onSnapshot: undefined as ((resume: () => void) => void) | undefined,
    onClose: undefined as (() => Promise<void>) | undefined };
  let disconnected!: () => void;
  const cdp = {
    get isOpen() { return !state.closed; },
    disconnected: new Promise<void>(resolve => { disconnected = resolve; }),
    close() { state.closed = true; disconnected(); },
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === "Target.createTarget") {
        assert.deepEqual(params, { url: "about:blank" });
        state.tabs++;
        if (state.setupFails) throw new Error("setup failed");
        return { targetId: "task" };
      }
      if (method === "Bao.showTab" || method === "Bao.settleTab") state.activations.push({ method, ...params });
      if (method === "Target.getTargets") return { targetInfos: state.taskGone ? [] : [{ targetId: "task", url: "https://fixture.invalid/", title: "Task" }] };
      if (method === "Bao.closeTabs") {
        state.closes++;
        if (state.cleanupFails) throw new Error("cleanup failed");
      }
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "https://fixture.invalid/", title: "Task" } };
      if (method === "Target.attachToTarget") return { sessionId: "page" };
      if (method === "Page.captureScreenshot") return { data: "iVBORw0KGgo=" };
      return {};
    },
  } as unknown as CdpSocket;
  t.mock.method(runningChrome, "openRunningChrome", async () => {
    if (state.closed) throw new Error("reconnect startup reached");
    return { endpoint: { port: 9222, browserPath: "/devtools/browser/lease" },
      cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close() };
  });
  t.mock.method(profileCopy, "openCopiedChromeForProxy", async () => ({ target: { portFile: "unused" },
    closed: cdp.disconnected, isClosed: () => !cdp.isOpen,
    close: async () => { state.closes++; await state.onClose?.(); cdp.close(); }, keepOpen: async () => { state.kept++; } }));
  t.mock.method(childProcess, "execFile", (_file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void) => {
    const command = args[args.indexOf("--idle-timeout") + 2]!;
    state.commands.push(command === "tab" && args.includes("new") ? "tab new" : command);
    stateDirs.add(String(options.cwd));
    void writeFile(path.join(String(options.cwd), "bao.pid"), String(process.pid)).then(() => {
      if (command === "snapshot" && state.onSnapshot) state.onSnapshot(() => callback(null, "snapshot result", ""));
      else callback(null, args.includes("--json") ? JSON.stringify({ data: { tabs: state.noActivePage ? [] : [{ active: true, targetId: "task" }] } }) : "native output", "");
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

for (const keepOpen of [false, true]) test(`idle backstop releases an owned session with keep-open=${keepOpen}`, async (t) => {
  const f = await lifecycleFixture(t, keepOpen);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: 9222, browserPath: "/browser" }));
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
  assert.match(f.library.listRuns()[0]!.envelope!.reason!, /ended without finish_task/);
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
  assert.equal(f.state.closes, 1, "the lease closes whatever Bao tabs are left");
  assert.equal(f.library.listRuns()[0]!.envelope?.reason, "session_closed");
  await assert.rejects(f.proxy.execute("open"), /owner's Chrome session ended/);
  await assert.rejects(f.proxy.execute("open", [], "current"), /reconnect startup reached/);
});

for (const keepOpen of [false, true]) test(`a copied session whose waiting tab closed still expires with keep-open=${keepOpen}`, async (t) => {
  const f = await lifecycleFixture(t, keepOpen);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: 9222, browserPath: "/browser" }));
  const socket = await import("../../src/cdp-live/socket");
  t.mock.method(socket, "connectCdp", async () => ({ ...f.cdp, close() {} }));
  await f.proxy.execute("open", [], "copy");
  await f.proxy.execute("wait_for_owner", ["1"]);
  assert.deepEqual(f.state.activations, []);
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

test("finish_task during async window cleanup applies the same session's checked outcome", async (t) => {
  const f = await lifecycleFixture(t);
  const endpoint = await import("../../src/cdp-live/endpoint");
  t.mock.method(endpoint, "readDevToolsActivePort", async () => ({ port: 9222, browserPath: "/browser" }));
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
  assert.deepEqual(f.state.activations, [{ method: "Bao.showTab", targetId: "task" }], "the owner wait opens Bao's group and shows the task tab");
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

test("failed task-tab setup closes the lease's tabs and detaches before any native command", async (t) => {
  const f = await lifecycleFixture(t);
  f.state.setupFails = true;
  await assert.rejects(f.proxy.execute("open", [], "current"), /setup failed/);
  assert.equal(f.state.tabs, 1);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.closed, true);
  assert.deepEqual(f.state.commands, []);
  assert.equal(f.proxy.hasSession(), false);
});

test("unexpected current disconnect requires a browser choice, unlike fresh or explicitly closed sessions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-ended-"));
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}\nconsole.error('tab setup failed'); process.exitCode = 1;\n`, { mode: 0o700 });
  const sockets: CdpSocket[] = [];
  let copies = 0;
  let lasting = 0;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(root, "default-chrome"));
  t.mock.method(profileCopy, "openCopiedChromeForProxy", async () => { copies++; throw new Error("copy startup reached"); });
  t.mock.method(baoProfile, "openBaoChromeForProxy", async () => { lasting++; throw new Error("Bao startup reached"); });
  t.mock.method(runningChrome, "openRunningChrome", async () => {
    let open = true;
    let ended!: () => void;
    const socket = {
      get isOpen() { return open; },
      disconnected: new Promise<void>((resolve) => { ended = resolve; }),
      close() { open = false; ended(); },
      async send(method: string) { return method === "Target.createTarget" ? { targetId: "task" } : {}; },
    } as unknown as CdpSocket;
    sockets.push(socket);
    return { endpoint: { port: 9222, browserPath: "/devtools/browser/lease" },
      cdp: socket, closed: socket.disconnected, isClosed: () => !socket.isOpen, detach: () => socket.close() };
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: root, executable });
  const fresh = new AgentBrowserProxy({ home: path.join(root, "fresh"), sourceRoot: root, executable });
  try {
    await assert.rejects(fresh.execute("open"), /Bao startup reached/);
    assert.equal(lasting, 1);
    assert.equal(copies, 0);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    sockets[0]!.close();
    await assert.rejects(proxy.execute("snapshot"), /owner's Chrome session ended.*browser=current.*browser=bao/);
    await assert.rejects(proxy.execute("open"), /owner's Chrome session ended/);
    assert.equal(copies, 0);
    assert.equal(lasting, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    assert.equal(sockets.length, 2);
    sockets[1]!.close();
    await assert.rejects(proxy.execute("open", [], "copy"), /copy startup reached/);
    assert.equal(copies, 1);
    assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
    await proxy.execute("close");
    await assert.rejects(proxy.execute("open"), /Bao startup reached/);
    assert.equal(lasting, 2);
    assert.equal(copies, 1);
  } finally {
    await proxy.end();
    await fresh.end();
    for (const socket of sockets) socket.close();
    await rm(root, { recursive: true, force: true });
  }
});
