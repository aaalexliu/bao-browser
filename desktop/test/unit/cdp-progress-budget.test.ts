import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ServerFrameDecoder, connectCdp, serverFrame } from "../../src/cdp-live/socket";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
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

test("a progress wait ends when the peer goes quiet, not after a long hang", { timeout: 3_000 }, async () => {
  const fake = await fakeCdp({ answerPings: false, delay: () => 60_000 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const started = Date.now();
  try {
    await assert.rejects(cdp.sendUntilProgress("Emulation.setFocusEmulationEnabled", { enabled: true }, undefined, { silenceMs: 400 }), /cdp timeout Emulation.setFocusEmulationEnabled/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 2_000, `quiet peer took ${elapsed}ms`);
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("a progress wait keeps going past its silence budget while pongs arrive", { timeout: 5_000 }, async () => {
  const fake = await fakeCdp({ answerPings: true, delay: () => 1_200 });
  const cdp = await connectCdp(fake.port, fake.browserPath);
  const started = Date.now();
  try {
    await cdp.sendUntilProgress("Runtime.evaluate", { expression: "1" }, "s", { silenceMs: 400 });
    assert.ok(Date.now() - started > 400, "pongs are progress, so silence is not a deadline from the start");
  } finally {
    cdp.close();
    await fake.close();
  }
});

test("an aborted progress wait stops without waiting out the silence", { timeout: 2_000 }, async () => {
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

test("quit during a stuck capture returns without waiting out the ceiling", { timeout: 20_000 }, async (t: TestContext) => {
  let hang = false;
  let sawStuck!: () => void;
  const stuck = new Promise<void>((resolve) => { sawStuck = resolve; });
  const fake = await fakeCdp({
    answerPings: true,
    delay: (method) => hang && method === "Target.attachToTarget" ? 120_000 : 0,
    onCommand: (method) => { if (hang && method === "Target.attachToTarget") sawStuck(); },
    result: (method) => {
      if (method === "Target.createTarget") return { targetId: "tab-1" };
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://fixture.test/", title: "Fixture" } };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab-1", type: "page" }] };
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
    await stuck;
    const started = Date.now();
    await proxy.end();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `quit waited ${elapsed}ms`);
    await click.catch(() => undefined);
  } finally {
    cdp.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});
