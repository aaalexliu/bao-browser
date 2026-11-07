import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launch from "../../src/launch";
import { Library } from "../../src/v1/store";

launch.pinTestBrowser();

test("window close and proxy cleanup await the owned shutdown before reopening", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab' && args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  fetch('http://' + endpoint.host + '/json/list').then(r => r.json()).then(targets => {
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
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  try {
    await proxy.execute("open");
    const chrome = chromes[0]!;
    const endpoint = await readDevToolsActivePort(chrome.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      const pages = targetInfos.filter(target => target.type === "page");
      assert.equal(pages.length, 1);
      await cdp.send("Target.closeTarget", { targetId: pages[0]!.targetId });
      await chrome.closed;
    } finally { cdp.close(); }
    assert.equal((await proxy.execute("close"))[0]!.exitCode, 0, "close after manual window close succeeds");
    assert.equal((await proxy.execute("close"))[0]!.exitCode, 0, "repeated close succeeds");
    assert.ok(new Library(home).listRuns().every(run => run.status === "passed"));
    const reopened = await proxy.execute("open");
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(chromes.length, 2);
    assert.notEqual(copies[0], copies[1]);
    await assert.rejects(access(copies[0]!), /ENOENT/);
    assert.equal(launch.pidsForDataDir(copies[0]!).length, 0);
    const endpoint2 = await readDevToolsActivePort(chromes[1]!.portFile);
    const cdp2 = await connectCdp(endpoint2.port, endpoint2.browserPath);
    try {
      const { targetInfos } = await cdp2.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      assert.equal(targetInfos.filter(target => target.type === "page").length, 1);
    } finally { cdp2.close(); }
  } finally {
    await proxy.close().catch(() => undefined);
    for (const chrome of chromes) await chrome.close().catch(() => undefined);
    for (const copy of copies) {
      assert.equal(launch.pidsForDataDir(copy).length, 0);
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a slow copied browser releases the proxy without deleting its live profile", { timeout: 60_000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-slow-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const statesFile = path.join(root, "state-dirs");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'open') require('node:fs').appendFileSync(${JSON.stringify(statesFile)}, process.cwd() + '\\n');
if (command === 'tab' && args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  fetch('http://' + endpoint.host + '/json/list').then(r => r.json()).then(targets => {
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
  const traces: string[] = [];
  const log = console.error.bind(console);
  t.mock.method(console, "error", (...args: unknown[]) => {
    traces.push(args.map(String).join(" "));
    log(...args);
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  let stoppedPid: number | undefined;
  try {
    await proxy.execute("open");
    const copy = copies[0]!;
    const rows = launch.pidsForDataDir(copy).map((pid) => ({ pid, ppid: 0, command: launch.readOwnedCommand(pid, copy, process.platform) }));
    stoppedPid = launch.guiChromeBrowserPid(process.env.BAO_TEST_BROWSER!, copy, rows);
    assert.ok(stoppedPid, "the synthetic browser PID must be known before stopping it");
    const stateDir = (await readFile(statesFile, "utf8")).trim();
    process.kill(stoppedPid, "SIGSTOP");
    assert.equal((await proxy.execute("close"))[0]!.exitCode, 0);
    assert.equal(chromes[0]!.isClosed(), true);
    assert.ok(launch.pidsForDataDir(copy).includes(stoppedPid), "Chrome must outlive the bounded shutdown period");
    await access(path.join(copy, "Default", "Preferences"));
    await assert.rejects(access(stateDir), /ENOENT/);
    assert.ok(traces.some((trace) => trace.includes("browser still shutting down") && trace.includes(copy)));
    assert.ok(new Library(home).listRuns().every((run) => run.status === "passed"));
    const reopened = await proxy.execute("open");
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(chromes.length, 2);
    assert.notEqual(copies[0], copies[1]);
    assert.ok(launch.pidsForDataDir(copy).includes(stoppedPid), "refreshing the copy must not terminate the old browser");
    await access(path.join(copy, "Default", "Preferences"));
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
      const deadline = Date.now() + 5000;
      while (launch.pidsForDataDir(copy).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(copies.every((copy) => launch.pidsForDataDir(copy).length === 0), "all real browsers must exit before profiles are removed");
    for (const dir of new Set(copies.map((copy) => path.dirname(copy)))) await rm(dir, { recursive: true, force: true });
    for (const state of (await readFile(statesFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)) await rm(state, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
