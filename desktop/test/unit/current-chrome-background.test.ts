import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";

pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

const TASK = `<!doctype html><title>Task</title><input id=q aria-label=Name><button id=b>Save</button><button id=p onclick="window.open('/popup')">Sign in</button><p id=out>not clicked</p>
<script>let frames=0;(function f(){frames++;requestAnimationFrame(f)})();b.onclick=()=>{out.textContent='clicked, typed: '+q.value};</script>`;

async function evaluate<T>(cdp: CdpSocket, targetId: string, expression: string): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { result } = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return result.value;
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }); }
}

async function withCurrentChrome(t: TestContext, body: (context: { base: string; probe: CdpSocket; proxy: AgentBrowserProxy; owner: string;
  pages: () => Promise<{ targetId: string; url: string }[]> }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-background-"));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url?.startsWith("/task") ? TASK : request.url === "/popup" ? "<!doctype html><title>Popup</title><h1>Popup page</h1>"
      : "<!doctype html><title>Owner</title><h1>Owner tab</h1>");
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
  const pages = async () => (await probe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
    .filter(target => target.type === "page").map(({ targetId, url }) => ({ targetId, url }));
  try {
    const { targetId: owner } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner` });
    await body({ base, probe, proxy, owner, pages });
  } finally {
    await proxy.end();
    probe.close();
    cdp.close();
    await chrome.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("the owner's Chrome keeps its active tab while the agent works in a background task tab", { skip: !binary, timeout: 60_000 }, (t) =>
  withCurrentChrome(t, async ({ base, probe, proxy, owner, pages }) => {
    const ownerState = () => evaluate<{ visibility: string; events: string[] }>(probe, owner, "({ visibility: document.visibilityState, events: window.ownerEvents })");
    assert.equal(await evaluate(probe, owner, `window.ownerEvents = [];
      document.addEventListener('visibilitychange', () => ownerEvents.push(document.visibilityState));
      addEventListener('blur', () => ownerEvents.push('blur')); document.visibilityState`), "visible");

    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    for (const [command, args] of [["fill", ["#q", "Ada"]], ["click", ["#b"]]] as const) {
      const [result] = await proxy.execute(command, [...args]);
      assert.equal(result!.exitCode, 0, result!.stderr);
    }
    const task = (await pages()).find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task, "the agent drove a task tab of its own");
    assert.deepEqual(await evaluate(probe, task, `new Promise(resolve => { const start = frames; setTimeout(() => resolve({
      text: out.textContent, visibility: document.visibilityState, painting: frames > start }), 300); })`),
    { text: "clicked, typed: Ada", visibility: "visible", painting: true }, "focus emulation keeps the background task tab live");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] }, "the owner's tab never left the front");

    assert.equal((await proxy.execute("close"))[0]!.exitCode, 0);
    const deadline = Date.now() + 2000;
    let left: string[] = [];
    while (Date.now() < deadline) {
      left = (await pages()).map(target => target.targetId);
      if (!left.includes(task)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(left, [owner], "only the task tab closes");
    assert.deepEqual(await ownerState(), { visibility: "visible", events: [] });
  }));

test("the agent stays in its task tab when the owner opens a tab, and stops when the task tab closes", { skip: !binary, timeout: 60_000 }, (t) =>
  withCurrentChrome(t, async ({ base, probe, proxy, owner, pages }) => {
    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    const task = (await pages()).find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task);

    const { targetId: later } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner?later` });
    const [moved] = await proxy.execute("open", [`${base}/task?second`]);
    assert.equal(moved!.exitCode, 0, moved!.stderr);
    const [filled] = await proxy.execute("fill", ["#q", "Grace"]);
    assert.equal(filled!.exitCode, 0, filled!.stderr);
    const urls = new Map((await pages()).map(target => [target.targetId, target.url]));
    assert.equal(urls.get(task), `${base}/task?second`, "open navigated the task tab");
    assert.equal(urls.get(later), `${base}/owner?later`, "the owner's new tab kept its page");
    assert.equal(await evaluate(probe, task, "q.value"), "Grace");

    await probe.send("Target.closeTarget", { targetId: task });
    while ((await pages()).some(target => target.targetId === task)) await new Promise(resolve => setTimeout(resolve, 50));
    const [stopped] = await proxy.execute("snapshot");
    assert.equal(stopped!.exitCode, 0);
    assert.equal(JSON.parse(stopped!.stdout).outcome, "closed");
    assert.match(JSON.parse(stopped!.stdout).instruction, /task tab was closed/);
    await assert.rejects(proxy.execute("snapshot"), /Reconnect with command=open and browser=current/);
    assert.deepEqual(new Map((await pages()).map(target => [target.targetId, target.url])),
      new Map([[owner, `${base}/owner`], [later, `${base}/owner?later`]]), "the owner's tabs stay open and untouched");
  }));

test("the agent follows tabs its own pages open and returns to the task tab when they close", { skip: !binary, timeout: 60_000 }, (t) =>
  withCurrentChrome(t, async ({ base, probe, proxy, owner, pages }) => {
    const opened = await proxy.execute("open", [`${base}/task`], "current");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    const task = (await pages()).find(target => target.url === `${base}/task`)?.targetId;
    assert.ok(task);
    const { targetId: later } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner?later` });

    const [clicked] = await proxy.execute("click", ["#p"]);
    assert.equal(clicked!.exitCode, 0, clicked!.stderr);
    while (!(await pages()).some(target => target.url === `${base}/popup`)) await new Promise(resolve => setTimeout(resolve, 50));
    const [popup] = await proxy.execute("snapshot");
    assert.match(popup!.stdout, /Popup page/, "the agent follows the popup its task page opened");
    const popupTab = (await pages()).find(target => target.url === `${base}/popup`)?.targetId;
    assert.ok(popupTab);

    const [closed] = await proxy.execute("tab", ["close"]);
    assert.equal(closed!.exitCode, 0, closed!.stderr);
    assert.doesNotMatch(closed!.stdout, /"outcome"/);
    const [back] = await proxy.execute("snapshot");
    assert.match(back!.stdout, /Save/, "closing the popup returns to the task tab");

    const [second] = await proxy.execute("tab", ["new", `${base}/task?second`]);
    assert.equal(second!.exitCode, 0, second!.stderr);
    assert.equal((await proxy.execute("tab", ["close"]))[0]!.exitCode, 0);
    const [filled] = await proxy.execute("fill", ["#q", "Lin"]);
    assert.equal(filled!.exitCode, 0, filled!.stderr);
    assert.equal(await evaluate(probe, task, "q.value"), "Lin", "closing the agent's second tab returns to the task tab");
    assert.deepEqual(new Map((await pages()).map(target => [target.targetId, target.url])),
      new Map([[task, `${base}/task`], [owner, `${base}/owner`], [later, `${base}/owner?later`]]), "the owner's tabs stay untouched");
  }));
