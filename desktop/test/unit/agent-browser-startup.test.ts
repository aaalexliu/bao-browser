import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launches from "../../src/launch";
import { Library } from "../../src/v1/store";
import { LIST_TARGETS } from "../support/fake-agent-browser";
import { scaledMs } from "../runtime";

launches.pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

test("a copy that restores 20 tabs opens a timer-heavy page in its own tab, keeps every restored tab, and saves the task as a workflow", { skip: !binary, timeout: scaledMs(120_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-restored-start-"));
  const sourceRoot = path.join(root, "source");
  const loads: string[] = [];
  const held: import("node:http").ServerResponse[] = [];
  // The page requests its late bundle after a chain of timers, and an image that answers only once that bundle is requested
  // holds its load event, so the load needs the agent's tab to keep its timers running behind the owner's apps.
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/hold") { held.push(response); return; }
    if (url.pathname === "/loaded") { loads.push(url.searchParams.get("visibility")!); response.end(); return; }
    if (url.pathname === "/bundle.js") {
      for (const image of held.splice(0)) image.end();
      response.setHeader("Content-Type", "text/javascript");
      response.end("");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(url.pathname === "/app" ? `<!doctype html><title>App</title><script>
      addEventListener('load', () => fetch('/loaded?visibility=' + document.visibilityState));
      let left = 40;
      const step = () => { if (--left) { setTimeout(step, 0); return; } const bundle = document.createElement('script'); bundle.src = '/bundle.js'; document.head.append(bundle); };
      setTimeout(step, 0);
    </script><img src="/hold" alt=""><button data-testid="go" onclick="this.textContent = 'Done'">Go</button>` : `<!doctype html><title>Restored ${url.pathname}</title>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
  await source.pages()[0]!.goto(`${base}/restored/0`);
  for (let index = 1; index < 20; index++) await (await source.newPage()).goto(`${base}/restored/${index}`);
  await source.close();
  const launch = launches.launchOwnedChromeEndpoint;
  let copyDir = "";
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    copyDir = options.userDataDir;
    return launch({ ...options, headless: true });
  });
  const proxy = new AgentBrowserProxy({ sourceRoot, home: path.join(root, "home"), executable: binary });
  try {
    const result = await proxy.execute("open", [`${base}/app`], "copy");
    assert.equal(result[0]!.exitCode, 0, result[0]!.stdout + result[0]!.stderr);
    assert.deepEqual(loads, ["visible"]);
    const endpoint = await readDevToolsActivePort(path.join(copyDir, "DevToolsActivePort"));
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string; url: string }[] }>("Target.getTargets");
      const restored = Array.from({ length: 20 }, (_, index) => `${base}/restored/${index}`);
      assert.deepEqual(targetInfos.filter(target => target.type === "page").map(target => target.url).sort(),
        [...restored, `${base}/app`].sort(), "every restored tab stays on its own URL beside the agent's tab");
    } finally { cdp.close(); }
    // The native daemon's start with 20 restored tabs used to outlast a fixed tab read, so only the session's end bounds that first call.
    const clicked = await proxy.execute("click", ['[data-testid="go"]'], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(clicked[0]!.exitCode, 0, clicked[0]!.stdout + clicked[0]!.stderr);
    await proxy.finishTask({ outcome: "passed", reason: "Clicked Go." }, proxy.activeRunId);
    assert.match(proxy.lastWorkflowOutcome ?? "", /^Saved workflow:/);
  } finally {
    proxy.disconnect();
    await proxy.close();
    for (const image of held) image.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// The 20-tab case can pass when the real daemon starts under 5 s. `activePage` leaves its first tab read without a timer, so removing only the daemonStarted clear does not fail it. With both first-call guards removed, the 30 s progress ceiling bounds that read, and a 6 s sleep still passes. A first-call limit under 6 s, like the old 5 s tab read, fails it.
const SLOW_NATIVE_MS = 6_000;

test("a copy capture still saves as a workflow when the first native call sleeps past 5 seconds", { timeout: scaledMs(60_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-slow-native-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const calls = path.join(root, "calls.jsonl");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>App</title><button data-testid="go" onclick="this.textContent='Done'">Go</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const launch = launches.launchOwnedChromeEndpoint;
  let copyDir = "";
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    copyDir = options.userDataDir;
    assert.equal(options.headless, false, "product pass-through stays visible");
    return launch({ ...options, headless: true });
  });
  t.mock.method(chromium, "connectOverCDP", () => { throw new Error("pass-through must not attach Playwright"); });
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args[args.indexOf('--cdp') + 1];
const command = args[args.indexOf('--idle-timeout') + 2];
const commandArgs = args.slice(args.indexOf('--idle-timeout') + 3);
const marker = ${JSON.stringify(path.join(root, "first-call"))};
let first = false;
try { fs.writeFileSync(marker, String(Date.now()), { flag: 'wx' }); first = true; } catch {}
const started = Date.now();
if (first) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_NATIVE_MS});
const sleptMs = first ? Date.now() - started : 0;
const bound = () => JSON.parse(fs.readFileSync('bao.target', 'utf8')).targetId;
const withCdp = (body) => new Promise((resolve, reject) => {
  const socket = new WebSocket(endpoint);
  let id = 0;
  const pending = new Map();
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    socket.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.onerror = () => reject(new Error('CDP connection failed'));
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  socket.onopen = () => {
    Promise.resolve(body(send)).then((value) => { socket.close(); resolve(value); }, (error) => { socket.close(); reject(error); });
  };
});
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
async function main() {
  if (command === 'tab' && commandArgs[0] === 'list' && commandArgs.includes('--json')) {
    const targetId = bound();
    const tabs = await withCdp(async (send) => {
      const { targetInfos } = await send('Target.getTargets', {});
      return targetInfos.filter((target) => target.type === 'page').map((target) => ({ targetId: target.targetId, url: target.url, active: target.targetId === targetId }));
    });
    if (!tabs.some((tab) => tab.active)) throw new Error('bound tab missing from tab list');
    console.log(JSON.stringify({ data: { tabs } }));
  } else if (command === 'open') {
    const url = commandArgs[0];
    await withCdp(async (send) => {
      const { sessionId } = await send('Target.attachToTarget', { targetId: bound(), flatten: true });
      await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send('Page.navigate', { url }, sessionId);
      const deadline = Date.now() + ${scaledMs(10000)};
      while (Date.now() < deadline) {
        const { result } = await send('Runtime.evaluate', { expression: 'document.querySelector("[data-testid=go]") ? location.href : ""', returnByValue: true }, sessionId);
        if (result.value) return;
        pause(50);
      }
      throw new Error('page did not show the button');
    });
    console.log('Opened');
  } else if (command === 'click') {
    await withCdp(async (send) => {
      const { sessionId } = await send('Target.attachToTarget', { targetId: bound(), flatten: true });
      const { result } = await send('Runtime.evaluate', { expression: '(() => { const el = document.querySelector("[data-testid=go]"); if (!el) return null; const box = el.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height }; })()', returnByValue: true }, sessionId);
      if (!result.value || result.value.w <= 0 || result.value.h <= 0) throw new Error('button has no box');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: result.value.x, y: result.value.y, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: result.value.x, y: result.value.y, button: 'left', clickCount: 1 }, sessionId);
      const deadline = Date.now() + ${scaledMs(2000)};
      let text = '';
      while (Date.now() < deadline) {
        text = (await send('Runtime.evaluate', { expression: 'document.querySelector("[data-testid=go]").textContent', returnByValue: true }, sessionId)).result.value;
        if (text === 'Done') break;
        pause(20);
      }
      if (text !== 'Done') throw new Error('click did not land');
      pause(150);
    });
    console.log('Clicked');
  } else if (command === 'get') process.exitCode = 1;
  else console.log('native ' + command);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args: commandArgs, first, sleptMs, ms: Date.now() - started }) + '\\n');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ sourceRoot, home, executable });
  try {
    const opened = await proxy.execute("open", [`${base}/app`], "copy");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stdout + opened[0]!.stderr);
    const clicked = await proxy.execute("click", ['[data-testid="go"]'], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(clicked[0]!.exitCode, 0, clicked[0]!.stdout + clicked[0]!.stderr);
    await proxy.finishTask({ outcome: "passed", reason: "Clicked Go." }, proxy.activeRunId);
    const recorded = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[]; first: boolean; sleptMs: number });
    const first = recorded.find((call) => call.first);
    assert.ok(first, "the fake native executable ran");
    assert.deepEqual([first.command, first.args[0], first.args.includes("--json")], ["tab", "list", true], "the first native call is the workflow recorder's tab read");
    assert.ok(first.sleptMs >= 5_000, `first native call slept ${first.sleptMs} ms`);
    assert.match(proxy.lastWorkflowOutcome ?? "", /^Saved workflow:/);
    assert.equal(new Library(home).list().workflows.length, 1);
  } finally {
    proxy.disconnect();
    await proxy.close();
    if (copyDir) await rm(path.dirname(copyDir), { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("pass-through open lists every restored tab even when an unrelated renderer never answers", { timeout: scaledMs(30_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-stalled-start-"));
  const sourceRoot = path.join(root, "source");
  let block = false;
  let blockedRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const blocked = block && request.url === "/blocked";
    if (blocked) blockedRequests++;
    response.end(`<!doctype html><title>${request.url}</title><h1>Local restored tab</h1>${blocked ? "<script>while (true) {}</script>" : ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
  await source.pages()[0]!.goto(`${base}/blocked`);
  await (await source.newPage()).goto(`${base}/ready`);
  await source.close();
  const before = await readFile(path.join(sourceRoot, "Default", "Preferences"), "utf8");
  block = true;
  const launch = launches.launchOwnedChromeEndpoint;
  let copyDir = "";
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    copyDir = options.userDataDir;
    assert.equal(options.headless, false, "product pass-through stays visible");
    assert.equal(options.loadExtensions, false);
    assert.equal(options.preserveRestoredTabs, true);
    return launch({ ...options, headless: true });
  });
  t.mock.method(chromium, "connectOverCDP", () => { throw new Error("pass-through must not attach Playwright"); });
  // A native CLI stand-in reads only Chrome's browser-level target inventory.
  // The real Chrome process and its stuck renderer are not mocked.
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const args = process.argv.slice(2);
const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab') {
  listTargets(endpoint.href).then(targets => {
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map(t => ({ targetId: t.id, url: t.url, active: t.url.endsWith('/ready') })) } }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else { console.log('native ' + command); }
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ sourceRoot, home: path.join(root, "home"),
    executable: process.env.AGENT_BROWSER_PROXY_BINARY || executable });
  try {
    const result = await proxy.execute("open", [`${base}/ready`], "copy");
    assert.equal(result[0]!.exitCode, 0, result[0]!.stderr);
    assert.equal(result[1]!.exitCode, 0, result[1]!.stderr);
    assert.ok(result[1]!.stdout.includes(`${base}/blocked`), "open returns the unrelated restored tab too");
    assert.ok(result[1]!.stdout.includes(`${base}/ready`));
    const [listed] = await proxy.execute("tab", ["list", "--json"], undefined, false, undefined, {}, proxy.activeRunId);
    const parsed = JSON.parse(listed!.stdout) as { data: { tabs: { url: string; targetId: string }[] } };
    const tabs = parsed.data.tabs;
    assert.equal(tabs.length, 3, "both restored tabs stay beside the agent's new tab");
    for (const url of [`${base}/blocked`, `${base}/ready`]) assert.ok(tabs.some(tab => tab.url === url), url);
    const deadline = Date.now() + scaledMs(5000);
    while (blockedRequests === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(blockedRequests > 0, "the restored blocked renderer must have started");
    const endpoint = await readDevToolsActivePort(path.join(copyDir, "DevToolsActivePort"));
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: tabs.find(tab => tab.url === `${base}/blocked`)!.targetId, flatten: true,
      });
      await assert.rejects(cdp.send("Runtime.evaluate", { expression: "1 + 1" }, sessionId, 300), /cdp timeout/);
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      assert.equal(targetInfos.filter(target => target.type === "page").length, 3);
    } finally { cdp.close(); }
    assert.equal(await readFile(path.join(sourceRoot, "Default", "Preferences"), "utf8"), before);
  } finally {
    proxy.disconnect();
    await proxy.close();
    if (copyDir) {
      assert.deepEqual(launches.pidsForDataDir(copyDir), []);
      await assert.rejects(access(copyDir), /ENOENT/);
      await rm(path.dirname(copyDir), { recursive: true, force: true });
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
