// Chrome asks the owner to allow every new browser-level debugging connection. These tests count those connections on a
// counting endpoint in front of a throwaway test Chromium, so they never reach the owner's Chrome.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort, type DevToolsEndpoint } from "../../src/cdp-live/endpoint";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profileCopy from "../../src/engines/chrome-profile-copy";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import type { AxHit } from "../../src/proxy/os-macos";
import { chromeProfiles } from "../support/chrome-profiles";

pinTestBrowser();

/**
 * Passes connections through to Chrome and counts the browser-level WebSocket upgrades, the ones Chrome asks about.
 * `hold` keeps Chrome's bytes back until it is called again with false.
 */
async function countingEndpoint(t: TestContext, chrome: DevToolsEndpoint) {
  let upgrades = 0;
  let held: (() => void)[] | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: chrome.port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy()).once("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.once("data", (head: Buffer) => {
      if (/^GET \/devtools\/browser\S* HTTP/.test(head.toString("latin1")) && /\r\nupgrade: websocket\r\n/i.test(head.toString("latin1"))) upgrades++;
      upstream.write(head);
      client.pipe(upstream);
    });
    upstream.on("data", (bytes: Buffer) => {
      if (held) held.push(() => client.write(bytes));
      else client.write(bytes);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  });
  const hold = (on: boolean) => {
    if (on) held ??= [];
    else if (held) { const writes = held; held = undefined; for (const write of writes) write(); }
  };
  return { endpoint: { port: (server.address() as AddressInfo).port, browserPath: chrome.browserPath } as DevToolsEndpoint, upgrades: () => upgrades, hold };
}

async function testChrome(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-current-connections-"));
  const userDataDir = await chromeProfiles(path.join(root, "chrome"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  // The owner's tab. Bao's test Chrome quits when its last page closes; the owner's Chrome keeps his tabs.
  const owner = await connectCdp(endpoint.port, endpoint.browserPath);
  await owner.send("Target.createTarget", { url: "about:blank", background: true });
  t.after(async () => {
    owner.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  });
  const counted = await countingEndpoint(t, endpoint);
  return { root, userDataDir, ...counted };
}

test("clients of the shared endpoint ride Bao's one connection, each in its own browser session", { timeout: 60_000 }, async (t) => {
  const f = await testChrome(t);
  const bao = await connectCdp(f.endpoint.port, f.endpoint.browserPath);
  const shared = await shareConnection(bao);
  try {
    const clients = await Promise.all([0, 1].map(() => connectCdp(shared.endpoint.port, shared.endpoint.browserPath)));
    const created: string[][] = [[], []];
    clients.forEach((client, index) => client.on("Target.targetCreated", undefined, (params) => {
      created[index]!.push((params.targetInfo as { targetId: string }).targetId);
    }));
    await clients[0]!.send("Target.setDiscoverTargets", { discover: true });
    const { targetId } = await bao.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
    // Ids repeat across clients and Bao; every reply still reaches the one who asked.
    const [first, second, own] = await Promise.all([
      clients[0]!.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }),
      clients[1]!.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }),
      bao.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }),
    ]);
    assert.equal(new Set([first.sessionId, second.sessionId, own.sessionId]).size, 3);
    const evaluate = (client: typeof bao, sessionId: string, expression: string) =>
      client.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId).then(({ result }) => result.value);
    assert.deepEqual(await Promise.all([evaluate(clients[0]!, first.sessionId, "1 + 1"), evaluate(clients[1]!, second.sessionId, "2 + 2"),
      evaluate(bao, own.sessionId, "3 + 3")]), [2, 4, 6]);
    assert.ok(created[0]!.includes(targetId));
    assert.deepEqual(created[1], [], "only the client that asked discovers targets");
    // A client that leaves takes its browser session with it; Bao's and the other client's sessions stay.
    const left = new Promise<void>((resolve) => bao.on("Target.detachedFromTarget", undefined, () => resolve()));
    clients[0]!.close();
    await left;
    assert.equal(await evaluate(clients[1]!, second.sessionId, "5"), 5);
    assert.equal(await evaluate(bao, own.sessionId, "7"), 7);
    assert.equal(f.upgrades(), 1, "Chrome saw only Bao's own connection");
    bao.close();
    await clients[1]!.disconnected;
  } finally {
    shared.close();
    bao.close();
  }
});

test("a reply without a session reaches the one who asked, though Bao and a client use the same ids", { timeout: 60_000 }, async (t) => {
  const f = await testChrome(t);
  const bao = await connectCdp(f.endpoint.port, f.endpoint.browserPath);
  const shared = await shareConnection(bao);
  const client = new WebSocket(`ws://127.0.0.1:${shared.endpoint.port}${shared.endpoint.browserPath}`);
  try {
    const replies = new Map<number, { result?: { sessionId?: string }; error?: { code: number; message: string }; sessionId?: string }>();
    let replied = () => {};
    client.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") { replies.set(message.id, message); replied(); }
    };
    await new Promise((resolve, reject) => { client.onopen = resolve; client.onerror = reject; });
    const ask = (id: number, method: string, params: Record<string, unknown>, sessionId?: string) => {
      client.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
      return new Promise<void>((resolve) => { replied = () => { if (replies.has(id)) resolve(); }; replied(); });
    };
    const { targetId } = await bao.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
    await ask(1, "Target.attachToTarget", { targetId, flatten: true });
    const gone = replies.get(1)!.result!.sessionId!;
    await ask(2, "Target.detachFromTarget", { sessionId: gone });
    replies.clear();

    // Chrome answers a command on a detached session with an error that names no session.
    const own = await bao.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await bao.send("Target.detachFromTarget", { sessionId: own.sessionId });
    await assert.rejects(bao.send("Runtime.evaluate", { expression: "1" }, own.sessionId, 5000), /Session with given id not found/);

    // With Chrome's replies held, Bao's request and the client's commands are all in flight; one of the client's ids is Bao's.
    f.hold(true);
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    for (const id of ids) client.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: gone }));
    const baoReply = bao.send<{ targetInfos: unknown[] }>("Target.getTargets");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const all = new Promise<void>((resolve) => { replied = () => { if (replies.size === ids.length) resolve(); }; });
    f.hold(false);
    assert.ok(Array.isArray((await baoReply).targetInfos));
    await all;
    for (const id of ids) {
      assert.equal(replies.get(id)?.error?.code, -32001, `client reply ${id}`);
      assert.equal(replies.get(id)?.sessionId, undefined);
    }
  } finally {
    client.close();
    shared.close();
    bao.close();
  }
});

const NATIVE = `#!${process.execPath}
// A stand-in for agent-browser: every call opens its own browser connection to --cdp, as a fresh native daemon does.
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
const url = args[args.indexOf('--cdp') + 1];
const bound = JSON.parse(fs.readFileSync('bao.target', 'utf8')).targetId;
const socket = new WebSocket(url);
let next = 1;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = next++;
  waiting.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
});
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = waiting.get(message.id);
  if (!waiter) return;
  waiting.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
};
socket.onerror = () => { console.error('CDP connection failed'); process.exit(1); };
socket.onopen = async () => {
  try {
    const { targetInfos } = await send('Target.getTargets');
    const pages = targetInfos.filter((target) => target.type === 'page');
    if (command === 'tab' && args.includes('--json')) {
      console.log(JSON.stringify({ data: { tabs: pages.map((target) => ({ targetId: target.targetId, active: target.targetId === bound })) } }));
    } else {
      const { sessionId } = await send('Target.attachToTarget', { targetId: bound, flatten: true });
      if (command === 'open') await send('Page.navigate', { url: args.at(-1) }, sessionId);
      const { result } = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
      console.log(command === 'snapshot' ? '- heading "' + result.value + '"' : 'native output');
    }
    socket.close();
  } catch (error) { console.error(String(error)); process.exit(1); }
};
`;

test("one Running Chrome session makes one browser connection to Chrome, whatever its native calls and workflow capture do", { timeout: 90_000 }, async (t) => {
  const f = await testChrome(t);
  const home = path.join(f.root, "home");
  const executable = path.join(f.root, "native");
  await writeFile(executable, NATIVE, { mode: 0o700 });
  const polls: string[][] = [];
  const helper = {
    async permissions(): Promise<AxHit> { return { ok: true, accessibility: true }; },
    async screenLocked() { return false; },
    async exec(args: string[]): Promise<AxHit> {
      polls.push(args);
      return { ok: true, found: false, pressed: false };
    },
  };
  const realOpen = currentChrome.openCurrentChrome;
  t.mock.method(profileCopy, "chromeProfilesRoot", () => f.userDataDir);
  t.mock.method(currentChrome, "openCurrentChrome", (options: Parameters<typeof realOpen>[0]) => realOpen(options, {
    helper, findChrome: async () => [7], executable: () => pinTestBrowser(),
    readPort: async () => f.endpoint, listener: async () => 7,
  }));
  const proxy = new AgentBrowserProxy({ home, sourceRoot: f.userDataDir, executable });
  t.after(() => proxy.end());
  const page = "data:text/html,<title>Task page</title><h1>Task</h1>";
  for (const session of [1, 2]) {
    const opened = await proxy.execute("open", [page], "current", false, "Default");
    assert.equal(opened[0]!.exitCode, 0, opened[0]!.stderr);
    const pollsBefore = polls.length;
    const snapshot = await proxy.execute("snapshot");
    assert.match(snapshot[0]!.stdout, /Task page/);
    assert.equal(polls.length, pollsBefore, "a native command raises no sheet, so the helper does not look for one");
    await proxy.execute("close");
    assert.doesNotMatch(proxy.lastWorkflowOutcome ?? "", /could not be recorded/, "workflow capture reaches the page through Bao's connection");
    assert.equal(f.upgrades(), session, "each session asks Chrome once: Bao's own connection");
  }
  assert.ok(polls.every((call) => call[0] === "debug-allow"));
});
