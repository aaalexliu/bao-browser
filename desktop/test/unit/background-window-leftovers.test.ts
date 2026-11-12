import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentBrowserProxy, frontApplication, parseFrontPid } from "../../src/engines/agent-browser-proxy";
import { openBackgroundCdp } from "../../src/engines/background-cdp";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import * as profiles from "../../src/engines/chrome-profile-copy";
import * as bao from "../../src/engines/bao-profile";
import { clientFrame, ServerFrameDecoder, serverFrame, type CdpSocket } from "../../src/cdp-live/socket";
import * as sockets from "../../src/cdp-live/socket";
import { scaledMs } from "../runtime";

test("parseFrontPid reads the lsappinfo pid line and ignores a bare ASN", () => {
  assert.equal(parseFrontPid("pid = 15133"), 15133);
  assert.equal(parseFrontPid("ASN:0x0-0xbb0bb:\npid = 15133\n"), 15133);
  assert.equal(parseFrontPid("ASN:0x0-0xbb0bb:"), undefined);
  assert.equal(parseFrontPid(""), undefined);
});

test("a multi-megabyte frame split into small chunks decodes in full", () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
  payload[0] = 0x7b;
  payload[payload.length - 1] = 0x7d;
  const frame = clientFrame(1, payload);
  const decoder = new ServerFrameDecoder();
  const decoded = [];
  for (let i = 0; i < frame.length; i += 1024) decoded.push(...decoder.push(frame.subarray(i, i + 1024)));
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.text?.length, payload.length);
  assert.equal(decoded[0]!.text?.[0], "{");
  assert.equal(decoded[0]!.text?.at(-1), "}");
});

test("the background endpoint does not forward a raise, and forces a new tab into the background", { timeout: scaledMs(5_000) }, async () => {
  const forwarded: { method?: string; params?: { background?: boolean; url?: string }; sessionId?: string }[] = [];
  const chrome = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    let upgraded = false;
    const decoder = new ServerFrameDecoder();
    const take = (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode !== 1 || !frame.text) continue;
        const command = JSON.parse(frame.text) as { id: number; method: string; params?: { background?: boolean; url?: string }; sessionId?: string };
        forwarded.push(command);
        socket.write(serverFrame(1, Buffer.from(JSON.stringify({ id: command.id, result: { targetId: "NEW" } }))));
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) { take(chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      const split = pending.indexOf("\r\n\r\n");
      if (split < 0) return;
      upgraded = true;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      const rest = pending.subarray(split + 4);
      pending = Buffer.alloc(0);
      if (rest.length) take(rest);
    });
  });
  await new Promise<void>((resolve) => chrome.listen(0, "127.0.0.1", resolve));
  const port = (chrome.address() as net.AddressInfo).port;
  const background = await openBackgroundCdp({ port, browserPath: "/devtools/browser/fake" });
  const socket = new WebSocket(`ws://127.0.0.1:${background.endpoint.port}${background.endpoint.browserPath}`);
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((resolve, reject) => {
    const next = ++id;
    waiting.set(next, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result));
    socket.send(JSON.stringify({ id: next, method, params, ...sessionId ? { sessionId } : {} }));
  });
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("agent connection failed")), { once: true });
    });
    await send("Page.bringToFront", {}, "S");
    await send("Target.activateTarget", { targetId: "T" });
    const created = await send("Target.createTarget", { url: "https://example.test/" }) as { targetId?: string };
    await send("Page.navigate", { url: "https://example.test/next" }, "S");
    assert.equal(created.targetId, "NEW");
    assert.equal(forwarded.some((command) => command.method === "Page.bringToFront" || command.method === "Target.activateTarget"), false);
    const create = forwarded.find((command) => command.method === "Target.createTarget");
    assert.equal(create?.params?.background, true);
    assert.equal(create?.params?.url, "https://example.test/");
    assert.equal(forwarded.some((command) => command.method === "Page.navigate" && command.sessionId === "S"), true);
  } finally {
    socket.close();
    background.close();
    await new Promise<void>((resolve) => chrome.close(() => resolve()));
  }
});

function followSend(t: TestContext, cdp: CdpSocket): void {
  t.mock.method(cdp, "sendUntilProgress", (method: string, params?: Record<string, unknown>, sessionId?: string) => cdp.send(method, params ?? {}, sessionId));
}

function instruction(result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>): string {
  return (JSON.parse(result[0]!.stdout) as { instruction: string }).instruction;
}

function outcome(result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>): string {
  return (JSON.parse(result[0]!.stdout) as { outcome: string }).outcome;
}

async function sourceProfile(root: string): Promise<string> {
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Profile 2", "Preferences"), "{}");
  return sourceRoot;
}

async function writeNative(root: string, targetId: string): Promise<string> {
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab' && args.includes('--json')) process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: ${JSON.stringify(targetId)} }] } }));
else process.stdout.write(command + ' unchanged\\n');
`, { mode: 0o700 });
  return executable;
}

test("a kept window selects the agent's last tab before it disconnects", { timeout: scaledMs(5_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-kept-tab-"));
  const order: string[] = [];
  const sourceRoot = await sourceProfile(root);
  const executable = await writeNative(root, "CHECKOUT");
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    const portFile = path.join(copy.userDataDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/kept-tab\n");
    let gone = false;
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, targetId: "START", pid: 4242, closed, bytes: copy.bytes, copyMs: copy.copyMs,
      isClosed: () => gone, close: async () => { gone = true; closedWindow(); await copy.close(); },
      keepOpen: () => { order.push("keepOpen"); return copy.keepOpen(); },
    };
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.activateTarget") order.push(`activate:${String(params?.targetId)}`);
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/article", title: "Article" } };
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      return {};
    });
    followSend(t, cdp);
    return cdp;
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable, keepOpen: () => true });
  try {
    await proxy.execute("open", ["http://127.0.0.1/article"], "copy");
    await proxy.finishTask({ outcome: "passed", reason: "The form is filled." }, proxy.activeRunId);
    assert.deepEqual(order, ["activate:CHECKOUT", "keepOpen"]);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a handoff skips the Dock raise when Bao's Chrome is already the front app", { timeout: scaledMs(5_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-front-skip-"));
  const methods: string[] = [];
  const sourceRoot = await sourceProfile(root);
  const executable = await writeNative(root, "CHECKOUT");
  t.mock.method(frontApplication, "pid", async () => 4242);
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    const portFile = path.join(copy.userDataDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/front-skip\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, targetId: "CHECKOUT", pid: 4242, closed, bytes: copy.bytes, copyMs: copy.copyMs,
      isClosed: () => false, close: async () => { closedWindow(); await copy.close(); }, keepOpen: () => copy.keepOpen(),
    };
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      methods.push(method);
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/login", title: "Sign in" } };
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    });
    followSend(t, cdp);
    return cdp;
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  try {
    const result = await proxy.execute("open", ["http://127.0.0.1/login"], "copy");
    assert.equal(outcome(result), "halted");
    assert.equal(methods.includes("Target.activateTarget"), true);
    assert.equal(methods.includes("Browser.setWindowBounds"), false);
    assert.equal(instruction(result).includes("brought this window to the front"), false);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("an open on a sign-in wall raises at discovery, and a declined move does not raise again", { timeout: scaledMs(5_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-move-raise-"));
  const order: string[] = [];
  const sourceRoot = await sourceProfile(root);
  const executable = await writeNative(root, "CHECKOUT");
  t.mock.method(frontApplication, "pid", async () => 1);
  t.mock.method(bao, "openBaoChromeForProxy", async () => {
    const portFile = path.join(root, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/move-raise\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, pid: 4242, closed,
      isClosed: () => false, close: async () => { closedWindow(); }, keepOpen: async () => undefined,
    };
  });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    order.push("move");
    throw new Error("Chrome is not open");
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      if (method === "Target.activateTarget" || method === "Browser.setWindowBounds") order.push(method);
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/login", title: "Sign in" } };
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    });
    followSend(t, cdp);
    return cdp;
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  try {
    const result = await proxy.execute("open", ["http://127.0.0.1/login"], "bao");
    const moveAt = order.indexOf("move");
    const raiseAt = order.indexOf("Target.activateTarget");
    assert.ok(moveAt >= 0, "the later move was attempted");
    assert.equal(outcome(result), "halted");
    assert.equal(order.filter((item) => item === "Target.activateTarget").length, 1);
    assert.ok(raiseAt >= 0 && raiseAt < moveAt, `discovery raise at ${raiseAt} is not before move at ${moveAt}: ${order.join(",")}`);
    if (process.platform === "darwin") assert.match(instruction(result), /brought this window to the front/);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a new wait does not claim a raise from a handoff that already ended", { timeout: scaledMs(8_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-stale-raise-"));
  let page = { url: "http://127.0.0.1/login", title: "Sign in" };
  let probe = false;
  let armed = 0;
  let nested = "";
  const sourceRoot = await sourceProfile(root);
  const executable = await writeNative(root, "CHECKOUT");
  t.mock.method(frontApplication, "pid", async () => 1);
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    const portFile = path.join(copy.userDataDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/stale-raise\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, targetId: "CHECKOUT", pid: 4242, closed, bytes: copy.bytes, copyMs: copy.copyMs,
      isClosed: () => false, close: async () => { closedWindow(); await copy.close(); }, keepOpen: () => copy.keepOpen(),
    };
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      if (probe && method === "Target.getTargetInfo") {
        armed += 1;
        if (armed === 1) throw new Error("no page yet");
        probe = false;
        const shot = await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId);
        nested = instruction(shot);
        throw new Error("probe done");
      }
      if (method === "Target.getTargetInfo") return { targetInfo: page };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "CHECKOUT", ...page }] };
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    });
    followSend(t, cdp);
    return cdp;
  });
  try {
    const first = await proxy.execute("open", ["http://127.0.0.1/login"], "copy");
    assert.equal(outcome(first), "halted");
    if (process.platform === "darwin") assert.match(instruction(first), /brought this window to the front/);
    page = { url: "http://127.0.0.1/done", title: "Done" };
    const ready = await proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(outcome(ready), "ready");
    page = { url: "http://127.0.0.1/login", title: "Sign in" };
    probe = true;
    await proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, proxy.activeRunId);
    assert.notEqual(nested, "");
    assert.equal(nested.includes("brought this window to the front"), false);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered wait_for_owner read moves before it raises", { timeout: scaledMs(5_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-recovered-wait-"));
  const order: string[] = [];
  const article = { url: "http://127.0.0.1/article", title: "Article" };
  const signIn = { url: "http://127.0.0.1/login", title: "Sign in" };
  let arm = false;
  let missed = false;
  const sourceRoot = await sourceProfile(root);
  const executable = await writeNative(root, "CHECKOUT");
  t.mock.method(frontApplication, "pid", async () => 1);
  t.mock.method(bao, "openBaoChromeForProxy", async () => {
    const portFile = path.join(root, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/recovered-wait\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, pid: 4242, closed,
      isClosed: () => false, close: async () => { closedWindow(); }, keepOpen: async () => undefined,
    };
  });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    order.push("move");
    throw new Error("Chrome is not open. Open Google Chrome, then try again.");
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      if (method === "Target.activateTarget" || method === "Browser.setWindowBounds") order.push(method);
      if (method === "Target.getTargetInfo") {
        if (arm && !missed) {
          missed = true;
          throw new Error("transient metadata miss");
        }
        return { targetInfo: missed ? signIn : article };
      }
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "CHECKOUT", ...signIn }] };
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
      return {};
    });
    followSend(t, cdp);
    return cdp;
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  try {
    await proxy.execute("open", [article.url], "bao");
    assert.equal(order.includes("move"), false);
    assert.equal(order.includes("Target.activateTarget"), false);
    arm = true;
    const waited = await proxy.execute("wait_for_owner", ["800"], undefined, false, undefined, {}, proxy.activeRunId);
    const moveAt = order.indexOf("move");
    const raiseAt = order.findIndex((item) => item === "Target.activateTarget" || item === "Browser.setWindowBounds");
    assert.equal(missed, true);
    assert.equal(outcome(waited), "waiting");
    assert.equal(order.filter((item) => item === "move").length, 1);
    assert.ok(moveAt >= 0, "the recovered read attempted the move");
    assert.ok(proxy.pickLines.some((line) => line.includes("a sign-in page")), proxy.pickLines.join("\n"));
    assert.equal(order.filter((item) => item === "Target.activateTarget").length, 1);
    assert.ok(raiseAt > moveAt, `raise at ${raiseAt} is not after move at ${moveAt}: ${order.join(",")}`);
    assert.match(instruction(waited), /sign in to 127\.0\.0\.1/);
    if (process.platform === "darwin") {
      const dockAt = order.indexOf("Browser.setWindowBounds");
      assert.ok(dockAt > moveAt, `dock raise at ${dockAt} is not after move at ${moveAt}`);
      assert.equal(order.slice(0, moveAt).includes("Browser.setWindowBounds"), false);
      assert.match(instruction(waited), /brought this window to the front/);
    }
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function loggingNative(executable: string, log: string, box: boolean): Promise<void> {
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args[args.indexOf("--idle-timeout") + 2];
fs.appendFileSync(${JSON.stringify(log)}, command + "\\n");
if (command === "tab" && args.includes("--json")) process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: "CHECKOUT" }] } }));
else if (${box} && command === "get") process.stdout.write(JSON.stringify({ data: { x: 4, y: 8, width: 40, height: 24 } }));
else process.stdout.write(command + " unchanged\\n");
`, { mode: 0o700 });
}

async function nativeCommands(log: string): Promise<string[]> {
  return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

async function baoHandoff(t: TestContext, root: string, executable: string, answer: (method: string, params: Record<string, unknown> | undefined) => unknown): Promise<{ proxy: AgentBrowserProxy; order: string[] }> {
  const order: string[] = [];
  const sourceRoot = await sourceProfile(root);
  t.mock.method(frontApplication, "pid", async () => 1);
  t.mock.method(bao, "openBaoChromeForProxy", async () => {
    const portFile = path.join(root, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/handoff\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    return {
      target: { kind: "bao" as const, portFile }, pid: 4242, closed,
      isClosed: () => false, close: async () => { closedWindow(); }, keepOpen: async () => undefined,
    };
  });
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    order.push("move");
    throw new Error("Chrome is not open. Open Google Chrome, then try again.");
  });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.activateTarget" || method === "Browser.setWindowBounds") order.push(method);
      return answer(method, params);
    });
    followSend(t, cdp);
    return cdp;
  });
  return { proxy: new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable }), order };
}

test("a recovered page that is not a sign-in moves or raises, and the poll reads no page text", { timeout: scaledMs(8_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-recovered-plain-"));
  const executable = path.join(root, "agent-browser");
  const log = path.join(root, "native.log");
  await loggingNative(executable, log, false);
  const article = { url: "http://127.0.0.1:9/article", title: "Article" };
  const pageReads: string[] = [];
  let arm = false;
  let missed = false;
  const { proxy, order } = await baoHandoff(t, root, executable, (method, params) => {
    if (arm && method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (!expression.includes("bao-owner-wait")) pageReads.push(expression);
    }
    if (method === "Target.getTargetInfo") {
      if (arm && !missed) {
        missed = true;
        throw new Error("transient metadata miss");
      }
      return { targetInfo: article };
    }
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "CHECKOUT", ...article }] };
    if (method === "Target.attachToTarget") return { sessionId: "fixture" };
    if (method === "Browser.getWindowForTarget") return { windowId: 7 };
    if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
    return {};
  });
  try {
    await proxy.execute("open", [article.url], "bao");
    arm = true;
    const before = (await nativeCommands(log)).length;
    const waited = await proxy.execute("wait_for_owner", ["800"], undefined, false, undefined, {}, proxy.activeRunId);
    const during = (await nativeCommands(log)).slice(before);
    const moveAt = order.indexOf("move");
    const raiseAt = order.findIndex((item) => item === "Target.activateTarget" || item === "Browser.setWindowBounds");
    assert.equal(missed, true);
    assert.equal(outcome(waited), "recording");
    assert.equal(during.includes("snapshot"), false, during.join(","));
    assert.deepEqual(pageReads, []);
    assert.equal(order.filter((item) => item === "move").length, 1);
    assert.ok(proxy.pickLines.some((line) => line.includes("a step that needs the owner")), proxy.pickLines.join("\n"));
    assert.equal(proxy.pickLines.some((line) => line.includes("a sign-in page")), false);
    assert.equal(order.filter((item) => item === "Target.activateTarget").length, 1);
    assert.ok(raiseAt > moveAt, `raise at ${raiseAt} is not after move at ${moveAt}: ${order.join(",")}`);
    if (process.platform === "darwin") assert.ok(order.indexOf("Browser.setWindowBounds") > moveAt);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function evidenceWall(t: TestContext, command: "click" | "fill" | "snapshot"): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `bao-evidence-${command}-`));
  const executable = path.join(root, "agent-browser");
  const log = path.join(root, "native.log");
  await loggingNative(executable, log, command !== "snapshot");
  const article = { url: "http://127.0.0.1:9/article", title: "Article" };
  const signIn = { url: "http://127.0.0.1:9/login", title: "Sign in" };
  const pageReads: string[] = [];
  let reads = 0;
  let arm = false;
  const { proxy, order } = await baoHandoff(t, root, executable, (method, params) => {
    if (arm && method === "Runtime.evaluate") {
      const expression = String(params?.expression ?? "");
      if (!expression.includes("bao-owner-wait")) pageReads.push(expression);
    }
    if (method === "Target.getTargetInfo") {
      if (arm) reads += 1;
      const wallAt = command === "snapshot" ? 3 : 2;
      return { targetInfo: arm && reads >= wallAt ? signIn : article };
    }
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "CHECKOUT", ...article }] };
    if (method === "Target.attachToTarget") return { sessionId: "fixture" };
    if (method === "Browser.getWindowForTarget") return { windowId: 7 };
    if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
    return {};
  });
  try {
    await proxy.execute("open", [article.url], "bao");
    arm = true;
    const before = (await nativeCommands(log)).length;
    const args = command === "fill" ? ["@email", "owner-only"] : command === "click" ? ["@pay"] : [];
    const result = await proxy.execute(command, args, undefined, false, undefined, {}, proxy.activeRunId);
    const during = (await nativeCommands(log)).slice(before);
    const receipt = proxy.lastCommand?.step.summary?.text ?? "";
    if (command === "snapshot") {
      assert.equal(result[0]?.stdout, "snapshot unchanged\n");
      assert.equal(result[0]?.stdout.includes("halted"), false);
      assert.equal(receipt.includes("Your turn"), false);
    } else {
      assert.equal(outcome(result), "halted", `${command} returned ${result[0]?.stdout}`);
      assert.match(receipt, /Your turn/);
      assert.equal(receipt.includes("Clicked"), false, receipt);
      assert.equal(receipt.includes("Typed"), false, receipt);
    }
    assert.equal(during.filter((item) => item === "snapshot").length, command === "snapshot" ? 1 : 0, during.join(","));
    assert.equal(during.includes(command) && command !== "snapshot", false, during.join(","));
    assert.deepEqual(pageReads, []);
    assert.equal(order.includes("move"), false, order.join(","));
    assert.equal(order.filter((item) => item === "Target.activateTarget").length, 1);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

test("a click evidence wall is halted, raises, and does not move", async (t) => {
  await evidenceWall(t, "click");
});

test("a fill evidence wall is halted, raises, and does not move", async (t) => {
  await evidenceWall(t, "fill");
});

test("a completion screenshot wall keeps the command result and does not move", async (t) => {
  await evidenceWall(t, "snapshot");
});

test("wait_for_owner's first read moves before it raises, and a declined move raises once", { timeout: scaledMs(8_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-first-read-"));
  const executable = path.join(root, "agent-browser");
  const log = path.join(root, "native.log");
  await loggingNative(executable, log, false);
  const article = { url: "http://127.0.0.1:9/article", title: "Article" };
  const signIn = { url: "http://127.0.0.1:9/login", title: "Sign in" };
  let arm = false;
  const { proxy, order } = await baoHandoff(t, root, executable, (method) => {
    if (method === "Target.getTargetInfo") return { targetInfo: arm ? signIn : article };
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "CHECKOUT", ...signIn }] };
    if (method === "Target.attachToTarget") return { sessionId: "fixture" };
    if (method === "Browser.getWindowForTarget") return { windowId: 7 };
    if (method === "Browser.getWindowBounds") return { bounds: { windowState: "normal" } };
    return {};
  });
  try {
    await proxy.execute("open", [article.url], "bao");
    arm = true;
    const before = (await nativeCommands(log)).length;
    const waited = await proxy.execute("wait_for_owner", ["800"], undefined, false, undefined, {}, proxy.activeRunId);
    const during = (await nativeCommands(log)).slice(before);
    const moveAt = order.indexOf("move");
    const raiseAt = order.indexOf("Target.activateTarget");
    assert.equal(outcome(waited), "waiting");
    assert.equal(during.includes("snapshot"), false, during.join(","));
    assert.equal(order.filter((item) => item === "move").length, 1);
    assert.equal(order.filter((item) => item === "Target.activateTarget").length, 1);
    assert.ok(raiseAt > moveAt, `raise at ${raiseAt} is not after move at ${moveAt}: ${order.join(",")}`);
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
