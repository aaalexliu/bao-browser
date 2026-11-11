import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { startApp } from "../../src/app/server";
import { runWorkflow } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import type { WorkflowStep } from "../../src/v1/schema";
import { targetFor, testWorkflow } from "../support/workflow";
import { chromeProfiles } from "../support/chrome-profiles";
import { scaledMs } from "../runtime";

pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
// Replay takes page pictures, and Linux Chromium never answers Page.captureScreenshot for a background tab. The current route is Mac-only.
const replaySkip = process.platform !== "darwin" && "replay pictures of a background tab hang on Linux Chromium";

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><p id=out>not clicked</p>
<script>let frames=0;(function f(){frames++;requestAnimationFrame(f)})();b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

const target = (id: string, role: string) => targetFor({ surface: "dom", role, id, path: [] });
const FILL: WorkflowStep = { id: "fill", index: 0, action: "type", caption: { text: "Fill name" }, heal: "never", text: { literal: "Ada" }, target: target("q", "textbox"), timeoutMs: 5000 };
const SAVE: WorkflowStep = { id: "save", index: 0, action: "click", caption: { text: "Save" }, heal: "never", target: target("b", "button"),
  check: { kind: "text", match: "clicked, typed: Ada", timeoutMs: 5000 }, timeoutMs: 5000 };
const HOLD: WorkflowStep = { id: "apply", index: 0, action: "handoff", reason: "owner-press", caption: { text: "Confirm before Save" }, target: target("b", "button"),
  check: { kind: "text", match: "never", timeoutMs: 1000 }, timeoutMs: 1000 };

async function evaluate<T>(cdp: CdpSocket, targetId: string, expression: string): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result } = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result.value;
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
}

// Opens the owner's tab and records its blur and visibility changes once the page, not the initial about:blank, is loaded.
async function openOwnerTab(probe: CdpSocket, url: string) {
  const { targetId: owner } = await probe.send<{ targetId: string }>("Target.createTarget", { url });
  while (await evaluate(probe, owner, "document.readyState === 'complete' && location.href") !== url) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await evaluate(probe, owner, `window.ownerEvents = [];
    document.addEventListener('visibilitychange', () => ownerEvents.push(document.visibilityState));
    addEventListener('blur', () => ownerEvents.push('blur')); document.visibilityState`), "visible");
  const ownerState = () => evaluate<{ visibility: string; events: string[] }>(probe, owner, "({ visibility: document.visibilityState, events: window.ownerEvents })");
  return { owner, ownerState };
}

test("the owner's Chrome keeps its active tab while the agent works in a background task tab", { skip: !binary, timeout: scaledMs(60_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-background-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: path.join(root, "chrome"), executable: binary });
  try {
    const { owner, ownerState } = await openOwnerTab(probe, `${base}/owner`);

    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]]] as const) {
      const [result] = await proxy.execute(command, [...args], undefined, false, undefined, {}, proxy.activeRunId);
      assert.equal(result!.exitCode, 0, result!.stderr);
    }
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    const task = targetInfos.find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task, "the agent drove a task tab of its own");
    assert.deepEqual(await evaluate(probe, task, `new Promise(resolve => { const start = frames; setTimeout(() => resolve({
      text: out.textContent, visibility: document.visibilityState, painting: frames > start }), 300); })`),
    { text: "clicked, typed: Ada", visibility: "visible", painting: true }, "focus emulation keeps the background task tab live");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");

    assert.equal((await proxy.execute("close", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0);
    const deadline = Date.now() + scaledMs(2000);
    let pages: string[] = [];
    while (Date.now() < deadline) {
      pages = (await probe.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets")).targetInfos
        .filter(target => target.type === "page").map(target => target.targetId);
      if (!pages.includes(task)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(pages, [owner], "only the task tab closes");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] });
  } finally {
    await proxy.end();
    probe.close();
    cdp.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("on the owner's Chrome the agent keeps its task tab when the owner opens a tab, and follows a tab its own click opens", { skip: !binary, timeout: scaledMs(60_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-tabs-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? `${TASK}<a id=pop href=/popup target=_blank>Details</a>`
      : request.url === "/popup" ? "<!doctype html><title>Details</title><h1>Popup page</h1>" : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: path.join(root, "chrome"), executable: binary });
  try {
    await openOwnerTab(probe, `${base}/owner`);
    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    const lines = opened[1]!.stdout.trim().split("\n");
    assert.deepEqual(lines.map(line => line.includes("(Bao task tab)")), lines.map(line => line.includes(`${base}/task`)), opened[1]!.stdout);

    await probe.send("Target.createTarget", { url: `${base}/owner?new` });
    for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]]] as const) {
      const [result] = await proxy.execute(command, [...args], undefined, false, undefined, {}, proxy.activeRunId);
      assert.equal(result!.exitCode, 0, result!.stderr);
    }
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    const task = targetInfos.find(target => target.url === `${base}/task`)!.targetId;
    assert.equal(await evaluate(probe, task, "out.textContent"), "clicked, typed: Ada", "the tab the owner opened did not take the agent");

    assert.equal((await proxy.execute("click", ["#pop"], undefined, false, undefined, {}, proxy.activeRunId))[0]!.exitCode, 0);
    const [read] = await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId);
    assert.match(read!.stdout, /Popup page/, "the agent follows the tab its click opened");
  } finally {
    await proxy.end();
    probe.close();
    cdp.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replaying a workflow on the owner's Chrome works in a background tab and shows it only when it holds for the owner", { skip: replaySkip, timeout: scaledMs(180_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-replay-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const priorSource = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = path.join(root, "chrome");
  const library = new Library(path.join(root, "home"));
  const workflow = (steps: WorkflowStep[]): string => {
    const id = `replay-${steps.length}`;
    library.save(testWorkflow({ id, name: "Background replay", startUrl: `${base}/task`, steps }));
    return id;
  };
  let resume: string | undefined;
  try {
    const { ownerState } = await openOwnerTab(probe, `${base}/owner`);

    const done = await runWorkflow(library, { id: workflow([FILL, SAVE]), browser: "current" });
    assert.equal(done.outcome, "ok", done.reason);
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");
    // The Save step's check proved the click; the replay's own tab closes with the run, and Chrome destroys it a moment after.
    let pages: string[] = [];
    while (!t.signal.aborted) {
      pages = (await probe.send<{ targetInfos: { type: string; url: string }[] }>("Target.getTargets")).targetInfos.filter(target => target.type === "page").map(target => target.url);
      if (!pages.includes(`${base}/task`)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(pages, [`${base}/owner`], "the replay's own tab closes with the run; the owner's tab stays");

    const held = await runWorkflow(library, { id: workflow([FILL, SAVE, HOLD]), browser: "current" });
    resume = held.resume;
    assert.equal(held.outcome, "needs_human", held.reason);
    assert.equal((await ownerState()).visibility, "hidden", "a held replay brings its tab to the front for the owner");
  } finally {
    if (resume) await runWorkflow(library, { resume, cancel: true }).catch(() => undefined);
    if (priorSource === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT; else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = priorSource;
    probe.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("app Replay on the owner's Chrome works in a background tab and shows it only when it holds for the owner", { skip: replaySkip, timeout: scaledMs(180_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-app-replay-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const app = await startApp({ home: path.join(root, "home"), port: 0, extensionHost: false, chromeProfilesRoot: path.join(root, "chrome") });
  const url = (route: string) => `http://127.0.0.1:${app.port}${route}`;
  const replay = (id: string) => fetch(url("/api/replay"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, browser: "current", args: {} }), signal: t.signal }).then(response => response.json() as Promise<{ status: string }>);
  const workflow = (steps: WorkflowStep[]): string => {
    const id = `app-replay-${steps.length}`;
    app.library.save(testWorkflow({ id, name: "Background app replay", startUrl: `${base}/task`, steps }));
    return id;
  };
  let held: Promise<{ status: string }> | undefined;
  try {
    const { ownerState } = await openOwnerTab(probe, `${base}/owner`);

    assert.equal((await replay(workflow([FILL, SAVE]))).status, "passed");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");

    held = replay(workflow([FILL, SAVE, HOLD]));
    while ((await ownerState()).visibility !== "hidden" && !t.signal.aborted) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await ownerState()).visibility, "hidden", "a held app Replay brings its tab to the front for the owner");
  } finally {
    const state = await fetch(url("/api/state")).then(response => response.json() as Promise<{ activeRun?: { id: string } }>).catch(() => undefined);
    if (state?.activeRun) await fetch(url("/api/replay/cancel"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: state.activeRun.id }) });
    await held?.catch(() => undefined);
    await app.close();
    probe.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replay on the owner's Chrome starts and finishes while another owner tab never answers, and attaches none of the owner's tabs", { skip: replaySkip, timeout: scaledMs(180_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-stuck-"));
  let blocked!: () => void;
  const stuckPage = new Promise<void>(resolve => { blocked = resolve; });
  const server = createServer((request, response) => {
    // The stuck page's synchronous request never gets an answer, so its page thread never returns.
    if (request.url === "/hang") return blocked();
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : request.url === "/stuck"
      ? "<!doctype html><title>Stuck</title><script>const hang = new XMLHttpRequest(); hang.open('GET', '/hang', false); hang.send();</script>"
      : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    const shared = await shareConnection(cdp);
    return { pid: 7, executable: pinTestBrowser(), root: path.join(root, "chrome"), endpoint: shared.endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => { shared.close(); cdp.close(); } };
  });
  const priorSource = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = path.join(root, "chrome");
  const library = new Library(path.join(root, "home"));
  const base = `http://127.0.0.1:${port}`;
  library.save(testWorkflow({ id: "stuck-neighbor", name: "Replay next to a stuck tab", startUrl: `${base}/task`, steps: [FILL, SAVE] }));
  try {
    const { owner, ownerState } = await openOwnerTab(probe, `${base}/owner`);
    // Another site keeps the stuck page out of the task tab's process.
    const { targetId: stuck } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `http://localhost:${port}/stuck`, background: true });
    await stuckPage;
    const { sessionId } = await probe.send<{ sessionId: string }>("Target.attachToTarget", { targetId: stuck, flatten: true });
    await assert.rejects(probe.send("Page.enable", {}, sessionId, 1000), /cdp timeout Page.enable/, "the stuck tab never answers");
    await probe.send("Target.detachFromTarget", { sessionId });

    const attached: string[] = [];
    probe.on("Target.targetInfoChanged", undefined, (params) => {
      const info = params.targetInfo as { targetId: string; attached: boolean };
      if (info.attached && [owner, stuck].includes(info.targetId)) attached.push(info.targetId);
    });
    await probe.send("Target.setDiscoverTargets", { discover: true });
    const done = await runWorkflow(library, { id: "stuck-neighbor", browser: "current" });
    assert.equal(done.outcome, "ok", done.reason);
    await probe.send("Target.setDiscoverTargets", { discover: false });
    assert.deepEqual(attached, [], "replay never attached the owner's tabs");
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    assert.equal(targetInfos.find(target => target.targetId === stuck)?.url, `http://localhost:${port}/stuck`, "the stuck tab stays open where it was");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");
  } finally {
    if (priorSource === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT; else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = priorSource;
    probe.close();
    await chrome.close();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
