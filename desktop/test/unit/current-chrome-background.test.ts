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
    const { targetId: owner } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner` });
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
