import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { shareConnection } from "../../src/cdp-live/shared-connection";
import { ServerFrameDecoder, connectCdp, serverFrame } from "../../src/cdp-live/socket";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
import { Library } from "../../src/v1/store";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";

const SWITCH = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

interface FakeCdp {
  port: number;
  browserPath: string;
  close(): Promise<void>;
}

function fakeCdp(opts: {
  answerPings?: boolean;
  delay?: (method: string) => number;
  result?: (method: string) => Record<string, unknown>;
  onCommand?: (method: string) => void;
  onPing?: () => void;
} = {}): Promise<FakeCdp> {
  const peers: Socket[] = [];
  const server = createServer((socket) => {
    peers.push(socket);
    const decoder = new ServerFrameDecoder();
    let header = Buffer.alloc(0);
    let upgraded = false;
    const onFrame = (bytes: Buffer) => {
      for (const frame of decoder.push(bytes)) {
        if (frame.opcode === 9 && opts.answerPings !== false) {
          opts.onPing?.();
          socket.write(serverFrame(10, frame.payload ?? Buffer.alloc(0)));
          continue;
        }
        if (frame.opcode !== 1 || !frame.text) continue;
        const message = JSON.parse(frame.text) as { id: number; method: string };
        opts.onCommand?.(message.method);
        const wait = opts.delay?.(message.method) ?? 0;
        const result = opts.result?.(message.method) ?? {};
        const timer = setTimeout(() => {
          if (!socket.destroyed) socket.write(serverFrame(1, Buffer.from(JSON.stringify({ id: message.id, result }))));
        }, wait);
        timer.unref();
      }
    };
    socket.on("data", (chunk) => {
      if (!upgraded) {
        header = Buffer.concat([header, chunk]);
        const split = header.indexOf("\r\n\r\n");
        if (split < 0) return;
        upgraded = true;
        socket.write(SWITCH);
        const rest = header.subarray(split + 4);
        header = Buffer.alloc(0);
        if (rest.length) onFrame(rest);
        return;
      }
      onFrame(chunk);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        browserPath: "/devtools/browser/progress",
        async close() {
          for (const peer of peers) peer.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

test("a focus-emulation wait survives a reply slower than 5s while the peer answers", { timeout: 15_000 }, async () => {
  const fake = await fakeCdp({ delay: () => 5_500, answerPings: true, result: () => ({ enabled: true }) });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const started = Date.now();
  try {
    const result = await cdp.sendUntilProgress<{ enabled: boolean }>("Emulation.setFocusEmulationEnabled", { enabled: true }, "session-1");
    assert.equal(result.enabled, true);
    assert.ok(Date.now() - started > 5_000, "the wait is not a 5s wall clock");
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("a progress wait ends when the peer goes quiet, not after a long hang", { timeout: 45_000 }, async () => {
  const fake = await fakeCdp({ answerPings: false, delay: () => 60_000 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const started = Date.now();
  try {
    await assert.rejects(cdp.sendUntilProgress("Emulation.setFocusEmulationEnabled", { enabled: true }, undefined, { silenceMs: 400 }), /cdp timeout Emulation.setFocusEmulationEnabled/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 30_000, `quiet peer took ${elapsed}ms`);
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("a progress wait keeps going past its silence budget while pongs arrive", { timeout: 30_000 }, async () => {
  const fake = await fakeCdp({ answerPings: true, delay: () => 5_000 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const started = Date.now();
  try {
    await cdp.sendUntilProgress("Runtime.evaluate", { expression: "1" }, "s", { silenceMs: 2_000 });
    assert.ok(Date.now() - started > 2_000, "pongs are progress, so silence is not a deadline from the start");
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("an aborted progress wait stops without waiting out the silence", { timeout: 20_000 }, async () => {
  const fake = await fakeCdp({ answerPings: true, delay: () => 60_000 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const signal = AbortSignal.timeout(150);
  try {
    await assert.rejects(cdp.sendUntilProgress("Runtime.enable", {}, "s", { signal, silenceMs: 30_000 }), /cdp aborted Runtime.enable/);
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("workflow capture still records when attach takes longer than 3s", { timeout: 15_000 }, async () => {
  const observation = { page: { url: "http://fixture.test/", title: "Fixture", nodes: [], texts: [], values: [] }, leaves: {} };
  let evaluates = 0;
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => method === "Target.attachToTarget" ? 3_500 : 0,
    result: (method) => {
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Runtime.evaluate") {
        evaluates += 1;
        return { result: { value: evaluates === 1 ? { before: observation } : observation } };
      }
      return {};
    },
  });
  const home = await mkdtemp(path.join(tmpdir(), "bao-progress-workflow-"));
  await mkdir(path.join(home, "trails"), { recursive: true });
  const started = Date.now();
  try {
    const workflow = new AgentBrowserWorkflow(home, "run-slow", async () => ({
      port: fake.port, browserPath: fake.browserPath, targetId: "tab-1", targetIds: ["tab-1"],
    }));
    const result = await workflow.record("click", ["#go"], "command-1", async () => ({ stdout: "ok", stderr: "", exitCode: 0 }), () => false);
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started > 3_000, "attach was slower than the old 3s budget");
    assert.doesNotMatch(workflow.finish(), /could not be recorded/);
    assert.match(workflow.finish(), /no durable target/);
  } finally {
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("opening the owner's Chrome waits out a slow attach reply", { timeout: 20_000 }, async (t: TestContext) => {
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => method === "Target.attachToTarget" ? 5_500 : 0,
    result: (method) => method === "Target.attachToTarget" || method === "Target.createTarget" ? { targetId: "tab-1", sessionId: "s1" } : {},
  });
  const root = await mkdtemp(path.join(tmpdir(), "bao-progress-attach-"));
  const userDataDir = await chromeProfiles(path.join(root, "chrome"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    cdp, executable: "/usr/bin/false", root: userDataDir, detach() { cdp.close(); },
  }) as unknown as currentChrome.CurrentChrome);
  fakeTaskTab(t);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: userDataDir, executable: "/usr/bin/false" });
  const started = Date.now();
  try {
    await assert.rejects(
      proxy.execute("open", ["http://fixture.test/"], "current", false, "Default"),
      (error: Error) => {
        assert.doesNotMatch(error.message, /cdp timeout Target.attachToTarget/);
        return true;
      },
    );
    assert.ok(Date.now() - started > 5_000, "attach was slower than the old 5s budget");
  } finally {
    cdp.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("opening the owner's Chrome waits out a slow focus-emulation reply", { timeout: 20_000 }, async (t: TestContext) => {
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => method === "Emulation.setFocusEmulationEnabled" ? 5_500 : 0,
    result: (method) => method === "Target.attachToTarget" || method === "Target.createTarget" ? { targetId: "tab-1", sessionId: "s1" } : {},
  });
  const root = await mkdtemp(path.join(tmpdir(), "bao-progress-open-"));
  const userDataDir = await chromeProfiles(path.join(root, "chrome"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    cdp, executable: "/usr/bin/false", root: userDataDir, detach() { cdp.close(); },
  }) as unknown as currentChrome.CurrentChrome);
  fakeTaskTab(t);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: userDataDir, executable: "/usr/bin/false" });
  const started = Date.now();
  try {
    await assert.rejects(
      proxy.execute("open", ["http://fixture.test/"], "current", false, "Default"),
      (error: Error) => {
        assert.doesNotMatch(error.message, /cdp timeout Emulation.setFocusEmulationEnabled/);
        return true;
      },
    );
    assert.ok(Date.now() - started > 5_000, "focus emulation was slower than the old 5s budget");
  } finally {
    cdp.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stuck page that keeps answering pings skips capture at the ceiling and the next command still runs", { timeout: 90_000 }, async () => {
  let released = false;
  const fake = await fakeCdp({
    answerPings: true,
    delay: () => released ? 0 : 120_000,
    result: (method) => method === "Target.attachToTarget" ? { sessionId: "s1" } : {},
  });
  const home = await mkdtemp(path.join(tmpdir(), "bao-progress-ceiling-"));
  await mkdir(path.join(home, "trails"), { recursive: true });
  let commands = 0;
  try {
    const workflow = new AgentBrowserWorkflow(home, "run-stuck", async () => ({
      port: fake.port, browserPath: fake.browserPath, targetId: "tab-1", targetIds: ["tab-1"],
    }));
    const started = Date.now();
    const result = await workflow.record("click", ["#go"], "command-1", async () => {
      commands += 1;
      released = true;
      return { stdout: "clicked", stderr: "", exitCode: 0 };
    }, () => false);
    const elapsed = Date.now() - started;
    assert.equal(result.stdout, "clicked");
    assert.equal(commands, 1);
    assert.ok(elapsed > 20_000 && elapsed < 60_000, `stuck capture took ${elapsed}ms`);
    assert.match(workflow.finish(), /could not be recorded/);
    const again = await workflow.record("click", ["#next"], "command-2", async () => {
      commands += 1;
      return { stdout: "next", stderr: "", exitCode: 0 };
    }, () => false);
    assert.equal(again.stdout, "next");
    assert.equal(commands, 2);
  } finally {
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("quit during a stuck capture returns without waiting out the ceiling", { timeout: 45_000 }, async (t: TestContext) => {
  let hang = false;
  let evaluates = 0;
  let sawStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { sawStuck = resolve; });
  const observation = { page: { url: "http://fixture.test/", title: "Fixture", nodes: [], texts: [], values: [] }, leaves: {} };
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => hang && method === "Runtime.enable" ? 120_000 : 0,
    onCommand: (method) => { if (hang && method === "Runtime.enable") sawStuck(); },
    result: (method) => {
      if (method === "Target.createTarget") return { targetId: "tab-1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://fixture.test/", title: "Fixture" } };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab-1", type: "page" }] };
      if (method === "Runtime.evaluate") {
        evaluates += 1;
        return { result: { value: evaluates === 1 ? { before: observation } : observation } };
      }
      return {};
    },
  });
  const root = await mkdtemp(path.join(tmpdir(), "bao-progress-quit-"));
  const userDataDir = await chromeProfiles(path.join(root, "chrome"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab' && args.includes('--json')) process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: 'tab-1', tabId: 't1' }] } }));
else process.stdout.write('ok');
`, { mode: 0o700 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    pid: 7, executable: "/usr/bin/false", root: userDataDir, endpoint: { port: fake.port, browserPath: fake.browserPath },
    cdp, closed: new Promise<void>(() => undefined), isClosed: () => false, detach() { cdp.close(); },
  }) as unknown as currentChrome.CurrentChrome);
  fakeTaskTab(t);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: userDataDir, executable });
  try {
    const [opened] = await proxy.execute("open", ["http://fixture.test/"], "current", false, "Default");
    assert.equal(opened!.exitCode, 0, opened!.stderr.slice(0, 200));
    hang = true;
    const click = proxy.execute("click", ["#go"]);
    const settled = click.then(() => undefined, () => undefined);
    await stuck;
    const started = Date.now();
    await proxy.end();
    const elapsed = Date.now() - started;
    await settled;
    assert.ok(elapsed < 20_000, `quit waited ${elapsed}ms`);
    const run = new Library(home).listRuns()[0];
    assert.ok(run, "quit still records the run");
    const commands = run.steps.map((step) => (step as { native?: { command?: string } }).native?.command);
    assert.deepEqual(commands, ["open", "click"]);
  } finally {
    cdp.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the session's first native call is not killed at the capture ceiling", { timeout: 50_000 }, async (t: TestContext) => {
  let evaluates = 0;
  const observation = { page: { url: "http://fixture.test/", title: "Fixture", nodes: [], texts: [], values: [] }, leaves: {} };
  const fake = await fakeCdp({
    answerPings: true,
    result: (method) => {
      if (method === "Target.createTarget") return { targetId: "tab-1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://fixture.test/", title: "Fixture" } };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab-1", type: "page" }] };
      if (method === "Runtime.evaluate") {
        evaluates += 1;
        return { result: { value: evaluates === 1 ? { before: observation } : observation } };
      }
      return {};
    },
  });
  const root = await mkdtemp(path.join(tmpdir(), "bao-progress-daemon-"));
  const marker = path.join(root, "first-call");
  const userDataDir = await chromeProfiles(path.join(root, "chrome"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const command = args[args.indexOf('--idle-timeout') + 2];
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, 'started');
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 31000)']);
  fs.writeFileSync(marker, 'done');
}
if (command === 'tab' && args.includes('--json')) process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: 'tab-1', tabId: 't1' }] } }));
else process.stdout.write('ok');
`, { mode: 0o700 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({
    pid: 7, executable: "/usr/bin/false", root: userDataDir, endpoint: { port: fake.port, browserPath: fake.browserPath },
    cdp, closed: new Promise<void>(() => undefined), isClosed: () => false, detach() { cdp.close(); },
  }) as unknown as currentChrome.CurrentChrome);
  fakeTaskTab(t);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: userDataDir, executable });
  const started = Date.now();
  try {
    const [opened] = await proxy.execute("open", ["http://fixture.test/"], "current", false, "Default");
    const elapsed = Date.now() - started;
    assert.equal(opened!.exitCode, 0, opened!.stderr.slice(0, 200));
    assert.equal(await readFile(marker, "utf8"), "done");
    assert.ok(elapsed > 30_000, `first native call ended at ${elapsed}ms`);
    await proxy.end();
    assert.ok(proxy.lastWorkflowOutcome);
    assert.doesNotMatch(proxy.lastWorkflowOutcome, /could not be recorded/);
  } finally {
    await proxy.end().catch(() => undefined);
    cdp.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared-endpoint join waits past 10s while the peer answers", { timeout: 60_000 }, async () => {
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => method === "Target.attachToBrowserTarget" ? 11_000 : 0,
    result: (method) => method === "Target.attachToBrowserTarget" ? { sessionId: "browser-1" } : {},
  });
  const bao = await connectCdp(fake.port, fake.browserPath);
  const shared = await shareConnection(bao);
  const started = Date.now();
  try {
    const client = await connectCdp(shared.endpoint.port, shared.endpoint.browserPath);
    assert.ok(Date.now() - started > 10_000, "join is not a 10s wall clock");
    client.close();
  } finally {
    shared.close();
    bao.close();
    await fake.close();
  }
});

test("shared-endpoint join stops at the capture ceiling while pings continue", { timeout: 120_000 }, async () => {
  const fake = await fakeCdp({ answerPings: true, delay: () => 120_000 });
  const bao = await connectCdp(fake.port, fake.browserPath);
  const shared = await shareConnection(bao);
  const started = Date.now();
  try {
    await assert.rejects(connectCdp(shared.endpoint.port, shared.endpoint.browserPath), /cdp handshake status 502/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed > 20_000 && elapsed < 90_000, `join ceiling took ${elapsed}ms`);
  } finally {
    shared.close();
    bao.close();
    await fake.close();
  }
});

test("shared-endpoint join stops when the client closes", { timeout: 30_000 }, async () => {
  let pings = 0;
  let sawAttach!: () => void;
  const attached = new Promise<void>((resolve) => { sawAttach = resolve; });
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => method === "Target.attachToBrowserTarget" ? 120_000 : 0,
    onCommand: (method) => { if (method === "Target.attachToBrowserTarget") sawAttach(); },
    onPing: () => { pings += 1; },
  });
  const bao = await connectCdp(fake.port, fake.browserPath);
  const shared = await shareConnection(bao);
  const socket = connect({ host: "127.0.0.1", port: shared.endpoint.port });
  socket.on("error", () => undefined);
  socket.write(`GET ${shared.endpoint.browserPath} HTTP/1.1\r\nHost: 127.0.0.1:${shared.endpoint.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  try {
    await attached;
    const pinging = Date.now();
    while (pings < 1 && Date.now() - pinging < 5_000) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(pings >= 1, "join was waiting on the peer");
    socket.destroy();
    const started = Date.now();
    let last = pings;
    let quietSince = Date.now();
    let stopped = false;
    while (Date.now() - started < 15_000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (pings !== last) {
        last = pings;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 1_500) {
        stopped = true;
        break;
      }
    }
    assert.equal(stopped, true, "join kept pinging after the client closed");
  } finally {
    socket.destroy();
    shared.close();
    bao.close();
    await fake.close();
  }
});
