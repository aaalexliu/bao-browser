import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { startApp } from "../../src/app/server";
import { runWorkflow } from "../../src/mcp/catalog";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";

pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><p id=out>not clicked</p>
<script>let frames=0;(function f(){frames++;requestAnimationFrame(f)})();b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

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

test("the owner's Chrome keeps its active tab while the agent works in a background task tab", { skip: !binary, timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-background-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, endpoint, cdp, closed: cdp.disconnected,
    isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
    withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(signal ?? new AbortController().signal) }));
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot: path.join(root, "chrome"), executable: binary });
  try {
    const { owner, ownerState } = await openOwnerTab(probe, `${base}/owner`);

    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]]] as const) {
      const [result] = await proxy.execute(command, [...args]);
      assert.equal(result!.exitCode, 0, result!.stderr);
    }
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    const task = targetInfos.find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task, "the agent drove a task tab of its own");
    assert.deepEqual(await evaluate(probe, task, `new Promise(resolve => { const start = frames; setTimeout(() => resolve({
      text: out.textContent, visibility: document.visibilityState, painting: frames > start }), 300); })`),
    { text: "clicked, typed: Ada", visibility: "visible", painting: true }, "focus emulation keeps the background task tab live");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");

    assert.equal((await proxy.execute("close"))[0]!.exitCode, 0);
    const deadline = Date.now() + 2000;
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

test("replaying a workflow on the owner's Chrome works in a background tab and shows it only when it holds for the owner", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-replay-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    return { pid: 7, endpoint, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
      withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(signal ?? new AbortController().signal) };
  });
  const priorSource = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = path.join(root, "chrome");
  const library = new Library(path.join(root, "home"));
  const identity = (testId: string, role: string) => ({ surface: "dom" as const, role, testId, path: [] });
  const workflow = (steps: WorkflowV2["steps"]): string => {
    const id = `replay-${steps.length}`;
    library.save({ schema: "bao.workflow/v2", version: 2, id, name: "Background replay", startUrl: `${base}/task`, createdAt: 1, inputs: [], steps });
    return id;
  };
  const fill: WorkflowV2["steps"][number] = { id: "fill", index: 0, action: "type", label: "Fill name", heal: "never", surface: "dom", value: "Ada",
    identity: identity("q", "textbox"), timeoutMs: 5000 };
  const save: WorkflowV2["steps"][number] = { id: "save", index: 1, action: "click", label: "Save", heal: "never", surface: "dom", identity: identity("b", "button"),
    postcondition: { kind: "text", match: "clicked, typed: Ada", timeoutMs: 5000 }, timeoutMs: 5000 };
  const hold: WorkflowV2["steps"][number] = { id: "apply", index: 2, action: "confirm", human: true, label: "Confirm before Save", surface: "dom",
    identity: identity("b", "button"), postcondition: { kind: "text", match: "never", timeoutMs: 1000 }, timeoutMs: 1000 };
  let resume: string | undefined;
  try {
    const { ownerState } = await openOwnerTab(probe, `${base}/owner`);

    const done = await runWorkflow(library, { id: workflow([fill, save]), browser: "current" });
    assert.equal(done.outcome, "ok", done.reason);
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    const task = targetInfos.find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task, "the replay drove a tab of its own, which stays open after replay");
    assert.equal(await evaluate(probe, task, "out.textContent"), "clicked, typed: Ada");

    const held = await runWorkflow(library, { id: workflow([fill, save, hold]), browser: "current" });
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

test("app Replay on the owner's Chrome works in a background tab and shows it only when it holds for the owner", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-app-replay-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/task" ? TASK : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  t.mock.method(profileCopy, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    return { pid: 7, endpoint, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
      withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(signal ?? new AbortController().signal) };
  });
  const app = await startApp({ home: path.join(root, "home"), port: 0, extensionHost: false, chromeProfilesRoot: root });
  const url = (route: string) => `http://127.0.0.1:${app.port}${route}`;
  const replay = (id: string) => fetch(url("/api/replay"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, browser: "current", args: {} }), signal: AbortSignal.timeout(30_000) }).then(response => response.json() as Promise<{ status: string }>);
  const identity = (testId: string, role: string) => ({ surface: "dom" as const, role, testId, path: [] });
  const workflow = (steps: WorkflowV2["steps"]): string => {
    const id = `app-replay-${steps.length}`;
    app.library.save({ schema: "bao.workflow/v2", version: 2, id, name: "Background app replay", startUrl: `${base}/task`, createdAt: 1, inputs: [], steps });
    return id;
  };
  const fill: WorkflowV2["steps"][number] = { id: "fill", index: 0, action: "type", label: "Fill name", heal: "never", surface: "dom", value: "Ada",
    identity: identity("q", "textbox"), timeoutMs: 5000 };
  const save: WorkflowV2["steps"][number] = { id: "save", index: 1, action: "click", label: "Save", heal: "never", surface: "dom", identity: identity("b", "button"),
    postcondition: { kind: "text", match: "clicked, typed: Ada", timeoutMs: 5000 }, timeoutMs: 5000 };
  const hold: WorkflowV2["steps"][number] = { id: "apply", index: 2, action: "confirm", human: true, label: "Confirm before Save", surface: "dom",
    identity: identity("b", "button"), postcondition: { kind: "text", match: "never", timeoutMs: 1000 }, timeoutMs: 1000 };
  let held: Promise<{ status: string }> | undefined;
  try {
    const { ownerState } = await openOwnerTab(probe, `${base}/owner`);

    assert.equal((await replay(workflow([fill, save]))).status, "passed");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");

    held = replay(workflow([fill, save, hold]));
    const deadline = Date.now() + 20_000;
    while ((await ownerState()).visibility !== "hidden" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
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
