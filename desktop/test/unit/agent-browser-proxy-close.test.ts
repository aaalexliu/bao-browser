import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import * as launch from "../../src/launch";
import { Library } from "../../src/v1/store";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";
import { LIST_TARGETS } from "../support/fake-agent-browser";
import { trapPort } from "../support/trap-port";
import { scaledMs } from "../runtime";

launch.pinTestBrowser();

for (const { mode, force, deny } of [
  { mode: "close", force: false, deny: false },
  { mode: "disconnect", force: false, deny: false },
  { mode: "stop", force: false, deny: false },
  { mode: "close", force: true, deny: false },
  { mode: "close", force: false, deny: true },
] as const) test(deny ? "current close preserves native state when shutdown fails" : `current ${mode} waits for native daemon exit after ${force ? "SIGKILL" : "a second SIGTERM"}`, { timeout: scaledMs(30_000) }, async (t) => {
  let daemon: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let proxy: AgentBrowserProxy | undefined;
  let stateDir: string | undefined;
  const root = await mkdtemp(path.join(tmpdir(), "bao-daemon-close-"));
  t.after(async () => {
    try {
      if (daemon?.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
      await exited;
    } finally {
      try { await proxy?.end().catch(() => undefined); }
      finally {
        try { if (stateDir) await rm(stateDir, { recursive: true, force: true }); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  });
  let detached = false;
  let resolveClosed!: () => void;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(root, "default-chrome"));
  await chromeProfiles(path.join(root, "source"));
  fakeTaskTab(t);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root: path.join(root, "source"), endpoint: { port: await trapPort(), browserPath: "/fixture" },
    cdp: { get isOpen() { return !detached; }, send: async (method: string) =>
      method === "Target.createTarget" ? { targetId: "task" } : method === "Target.getTargets" ? { targetInfos: [] } : {},
      sendUntilProgress(this: { send: (method: string) => Promise<unknown> }, method: string) { return this.send(method); } },
    closed: new Promise<void>(resolve => { resolveClosed = resolve; }),
    isClosed: () => detached,
    detach: () => { detached = true; resolveClosed(); },
  } as Awaited<ReturnType<typeof currentChrome.openCurrentChrome>>));
  const signals = path.join(root, "signals");
  daemon = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    let terms = 0;
    process.on('SIGTERM', () => {
      fs.appendFileSync(${JSON.stringify(signals)}, 'SIGTERM\\n');
      if (++terms > 1 && ${!force}) setTimeout(() => process.exit(0), 75);
    });
    setInterval(() => {}, 1000);
    console.log('ready');
  `], { stdio: ["ignore", "pipe", "pipe"] });
  exited = once(daemon, "exit");
  await Promise.race([
    once(daemon.stdout!, "data"),
    exited.then(() => { throw new Error("fake daemon exited before readiness"); }),
  ]);
  const executable = path.join(root, "native");
  const stateMarker = path.join(root, "state");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
    const fs = require('node:fs');
    fs.writeFileSync('bao.pid', ${JSON.stringify(String(daemon.pid))});
    fs.writeFileSync(${JSON.stringify(stateMarker)}, process.env.AGENT_BROWSER_SOCKET_DIR);
    process.exitCode = 1;
  `, { mode: 0o700 });
  proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: path.join(root, "source"), executable });
  assert.equal((await proxy.execute("open", [], "current"))[0]!.exitCode, 1);
  stateDir = await fs.readFile(stateMarker, "utf8");
  const remove = fs.rm;
  t.mock.method(fs, "rm", async (file: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
    if (file === stateDir) assert.ok(daemon!.exitCode !== null || daemon!.signalCode !== null, "daemon must exit before its state is removed");
    return remove(file, options);
  });
  if (deny) {
    const kill = process.kill;
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === daemon!.pid && signal !== 0) throw Object.assign(new Error("fixture signal denied"), { code: "EPERM" });
      return kill(pid, signal);
    });
    await assert.rejects(proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId), (error: Error) => /^Bao could not clean up the browser session of run .+: fixture signal denied$/.test(error.message)
      && (error.cause as NodeJS.ErrnoException).code === "EPERM");
    await access(stateDir);
    assert.equal(daemon.exitCode, null);
    assert.equal(daemon.signalCode, null);
    assert.equal(detached, true);
    return;
  }
  if (mode === "close") await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId);
  else {
    proxy.disconnect();
    await proxy.end(mode === "stop");
  }
  assert.equal(daemon.exitCode, force ? null : 0);
  assert.equal(daemon.signalCode, force ? "SIGKILL" : null);
  assert.equal(await fs.readFile(signals, "utf8"), "SIGTERM\nSIGTERM\n");
  await assert.rejects(access(stateDir), /ENOENT/);
  assert.equal(detached, true);
});

test("a close after the owner's Chrome ended still names the owner's Chrome", { timeout: scaledMs(30_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-ended-"));
  let detached = false;
  let resolveClosed!: () => void;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(root, "default-chrome"));
  await chromeProfiles(path.join(root, "source"));
  fakeTaskTab(t);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root: path.join(root, "source"), endpoint: { port: await trapPort(), browserPath: "/fixture" },
    cdp: { get isOpen() { return !detached; }, send: async (method: string) =>
      method === "Target.createTarget" ? { targetId: "task" } : method === "Target.getTargets" ? { targetInfos: [] } : {},
      sendUntilProgress(this: { send: (method: string) => Promise<unknown> }, method: string) { return this.send(method); } },
    closed: new Promise<void>(resolve => { resolveClosed = resolve; }),
    isClosed: () => detached,
    detach: () => { detached = true; resolveClosed(); },
  } as Awaited<ReturnType<typeof currentChrome.openCurrentChrome>>));
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}\nprocess.exitCode = 1;\n`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: path.join(root, "source"), executable });
  t.after(async () => { await proxy.end().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  await proxy.execute("open", [], "current");
  assert.equal(proxy.currentChrome, true);
  resolveClosed();
  detached = true;
  while (proxy.activeRunId) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(proxy.currentChrome, false, "no session and no close yet");
  assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(proxy.currentChrome, true, "the close after the owner's Chrome ended belongs to that route");
  await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId);
  assert.equal(proxy.currentChrome, false, "a later close has no ended route left");
});

test("window close awaits owned cleanup before browser choice and reopening", { timeout: scaledMs(30_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab' && args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  listTargets(endpoint.href).then(targets => {
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map((t, index) => ({ targetId: t.id, active: index === 0 })) } }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else { process.stdout.write('native success\\n'); }
`, { mode: 0o700 });
  const ownedLaunch = launch.launchOwnedChromeEndpoint;
  const chromes: Awaited<ReturnType<typeof ownedLaunch>>[] = [];
  const copies: string[] = [];
  t.mock.method(launch, "launchOwnedChromeEndpoint", async (options: Parameters<typeof ownedLaunch>[0]) => {
    const chrome = await ownedLaunch({ ...options, headless: true });
    chromes.push(chrome);
    copies.push(options.userDataDir);
    return chrome;
  });
  let releaseDelete!: () => void;
  let notifyDelete!: () => void;
  const deleting = new Promise<void>(resolve => { notifyDelete = resolve; });
  const deletionAllowed = new Promise<void>(resolve => { releaseDelete = resolve; });
  const remove = fs.rm;
  let held = false;
  t.mock.method(fs, "rm", async (file: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
    if (file === copies[0] && !held) {
      held = true;
      notifyDelete();
      await deletionAllowed;
    }
    return remove(file, options);
  });
  let currentStarts = 0;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => path.join(root, "default-chrome"));
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    currentStarts++;
    await assert.rejects(access(copies[0]!), /ENOENT/);
    throw new Error("current startup reached");
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  try {
    await proxy.execute("open", [], "copy");
    assert.equal((await proxy.execute("open", [], "copy", false, undefined, {}, proxy.activeRunId))[0]!.stdout, "native success\n");
    await assert.rejects(proxy.execute("open", [], "current", false, undefined, {}, proxy.activeRunId), /close the current session before choosing a different browser/);
    const chrome = chromes[0]!;
    const endpoint = await readDevToolsActivePort(chrome.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      const pages = targetInfos.filter(target => target.type === "page");
      assert.equal(pages.length, 1, "the agent uses the copy's startup tab");
      for (const page of pages) await cdp.send("Target.closeTarget", { targetId: page.targetId });
      await chrome.closed;
    } finally { cdp.close(); }
    await deleting;
    assert.ok(new Library(home).listRuns().every(run => run.status === "passed"));
    await assert.rejects(proxy.execute("open", [], "invalid", false, undefined, {}, proxy.activeRunId), /must be copy, bao, or current/);
    let settled = false;
    const switching = proxy.execute("open", [], "current", false, undefined, {}, proxy.activeRunId).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "browser choice waits for profile deletion");
    assert.equal(currentStarts, 0);
    releaseDelete();
    const startupError = await switching;
    assert.ok(startupError instanceof Error);
    assert.equal(startupError.message, "current startup reached");
    assert.equal(currentStarts, 1);
    assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0, "close after manual window close succeeds");
    assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0, "repeated close succeeds");
    const reopened = await proxy.execute("open", [], "copy", false, undefined, {}, proxy.activeRunId);
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(chromes.length, 2);
    assert.notEqual(copies[0], copies[1]);
    await assert.rejects(access(copies[0]!), /ENOENT/);
    assert.equal(launch.pidsForDataDir(copies[0]!).length, 0);
    const endpoint2 = await readDevToolsActivePort(chromes[1]!.portFile);
    const cdp2 = await connectCdp(endpoint2.port, endpoint2.browserPath);
    try {
      const { targetInfos } = await cdp2.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      assert.equal(targetInfos.filter(target => target.type === "page").length, 1, "the agent uses the new copy's startup tab");
    } finally { cdp2.close(); }
  } finally {
    releaseDelete();
    await proxy.close().catch(() => undefined);
    for (const chrome of chromes) await chrome.close().catch(() => undefined);
    for (const copy of copies) {
      assert.equal(launch.pidsForDataDir(copy).length, 0);
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled copied browser exits before the proxy deletes its profile and reopens", { timeout: scaledMs(60_000), skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-slow-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const statesFile = path.join(root, "state-dirs");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'open') require('node:fs').appendFileSync(${JSON.stringify(statesFile)}, process.cwd() + '\\n');
if (command === 'tab' && args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  listTargets(endpoint.href).then(targets => {
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map((t, index) => ({ targetId: t.id, active: index === 0 })) } }));
  }).catch(() => { process.exitCode = 1; });
} else { process.stdout.write('native success\\n'); }
`, { mode: 0o700 });
  const ownedLaunch = launch.launchOwnedChromeEndpoint;
  const chromes: Awaited<ReturnType<typeof ownedLaunch>>[] = [];
  const copies: string[] = [];
  t.mock.method(launch, "launchOwnedChromeEndpoint", async (options: Parameters<typeof ownedLaunch>[0]) => {
    const chrome = await ownedLaunch({ ...options, headless: true });
    chromes.push(chrome);
    copies.push(options.userDataDir);
    return chrome;
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  let stoppedPid: number | undefined;
  try {
    await proxy.execute("open", [], "copy");
    const copy = copies[0]!;
    const rows = launch.pidsForDataDir(copy).map((pid) => ({ pid, ppid: 0, command: launch.readOwnedCommand(pid, copy, process.platform) }));
    stoppedPid = launch.guiChromeBrowserPid(process.env.BAO_TEST_BROWSER!, copy, rows);
    assert.ok(stoppedPid, "the synthetic browser PID must be known before stopping it");
    const stateDir = (await readFile(statesFile, "utf8")).trim();
    process.kill(stoppedPid, "SIGSTOP");
    assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0);
    assert.equal(chromes[0]!.isClosed(), true);
    assert.equal(launch.pidsForDataDir(copy).length, 0, "close must await every exact-profile process, including a stopped browser");
    await assert.rejects(access(copy), /ENOENT/, "the stopped browser's copy is removed only after its processes exit");
    await assert.rejects(access(stateDir), /ENOENT/);
    assert.ok(new Library(home).listRuns().every((run) => run.status === "passed"));
    const reopened = await proxy.execute("open", [], "copy", false, undefined, {}, proxy.activeRunId);
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(chromes.length, 2);
    assert.notEqual(copies[0], copies[1]);
    assert.equal(launch.pidsForDataDir(copy).length, 0, "reopening must not restore the stopped browser");
    await assert.rejects(access(copy), /ENOENT/);
  } finally {
    if (stoppedPid) {
      try { process.kill(stoppedPid, "SIGCONT"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await proxy.close().catch(() => undefined);
    for (const chrome of chromes) {
      try {
        const endpoint = await readDevToolsActivePort(chrome.portFile);
        const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 3000 });
        try { await cdp.send("Browser.close", {}, undefined, 3000).catch(() => undefined); }
        finally { cdp.close(); }
      } catch {}
      await chrome.close().catch(() => undefined);
    }
    for (const copy of copies) {
      const deadline = Date.now() + scaledMs(5000);
      while (launch.pidsForDataDir(copy).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(copies.every((copy) => launch.pidsForDataDir(copy).length === 0), "all real browsers must exit before profiles are removed");
    for (const dir of new Set(copies.map((copy) => path.dirname(copy)))) await rm(dir, { recursive: true, force: true });
    for (const state of (await readFile(statesFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)) await rm(state, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
