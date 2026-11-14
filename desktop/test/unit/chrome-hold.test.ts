// Two processes on one user-data-dir must open one debugging connection. A second user-data-dir, or a Chrome restart,
// opens one more. The counting endpoint stands in for Chrome's Allow sheet: each browser-level upgrade is one ask.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { bindHoldSessions, holdDir, holdEnd, holdLaunch, joinOrStartHold, serveHold, starterReusable } from "../../src/cdp-live/chrome-hold";
import { openCurrentChrome, type CurrentChrome } from "../../src/cdp-live/current-chrome";
import { claimOwned, writeClaim } from "../../src/cdp-live/debug-switch";
import { readDevToolsActivePort, type DevToolsEndpoint } from "../../src/cdp-live/endpoint";
import { connectCdp, ServerFrameDecoder, serverFrame } from "../../src/cdp-live/socket";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { chromeProfiles } from "../support/chrome-profiles";
import { scaledMs } from "../runtime";

pinTestBrowser();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function countingEndpoint(t: TestContext, chrome: DevToolsEndpoint) {
  let upgrades = 0;
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
      upstream.pipe(client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  });
  return {
    port: (server.address() as AddressInfo).port,
    browserPath: chrome.browserPath,
    upgrades: () => upgrades,
    closeConnections() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function joinFromOtherProcess(root: string, axLog: string, home: string): Promise<{ port: number; targetId: string }> {
  const script = `
    const { openCurrentChrome } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/current-chrome.js"))});
    openCurrentChrome({ root: ${JSON.stringify(root)}, axLog: ${JSON.stringify(axLog)} }).then(async (chrome) => {
      const created = await chrome.cdp.send("Target.createTarget", { url: "about:blank", background: true });
      process.stdout.write(JSON.stringify({ port: chrome.endpoint.port, targetId: created.targetId }) + "\\n");
      chrome.detach();
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`join timed out: ${err}`)); }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
  if (code !== 0) throw new Error(`other session exited ${code}: ${err}`);
  return JSON.parse(out) as { port: number; targetId: string };
}

async function holderPid(root: string): Promise<number | undefined> {
  try {
    const record = JSON.parse(await readFile(path.join(holdDir(root), "hold.json"), "utf8")) as { holderPid?: number };
    return record.holderPid;
  } catch {
    return undefined;
  }
}

test("a packaged hold starts through bao so the Chrome folder read stays Bao's", () => {
  const options = { root: "/tmp/chrome", axLog: "/tmp/ax.jsonl" };
  const dev = holdLaunch("/work/cli.js", options);
  assert.deepEqual(dev.args.slice(1), ["chrome-hold", "--root", options.root, "--ax-log", options.axLog]);
  const packaged = holdLaunch("/Applications/Bao.app/Contents/Resources/bao/src/app/cli.js", options, "/Applications/Bao.app/Contents/MacOS/bao");
  assert.equal(packaged.command, "/Applications/Bao.app/Contents/MacOS/bao");
  assert.deepEqual(packaged.args, ["--run-node", "--own", "/Applications/Bao.app/Contents/Resources/bao/src/app/cli.js", "chrome-hold", "--root", options.root, "--ax-log", options.axLog]);
});

test("one user-data-dir is one Chrome connection, shared by a later process, and a restart opens one more", { timeout: scaledMs(120_000) }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-home-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-"));
  const userDataDir = await chromeProfiles(path.join(scratch, "chrome"));
  const otherRoot = await chromeProfiles(path.join(scratch, "other-chrome"));
  const owned = await launchOwnedChromeEndpoint({ userDataDir, headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(owned.portFile);
  // A page on the test Chrome, not through the counter. The browser quits when its last page closes.
  const keeper = await connectCdp(endpoint.port, endpoint.browserPath);
  await keeper.send("Target.createTarget", { url: "about:blank", background: true });
  t.after(() => keeper.close());
  const counted = await countingEndpoint(t, endpoint);
  const holders: number[] = [];
  const previousHome = process.env.HOME;
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const fixture = JSON.stringify({
    port: counted.port, browserPath: counted.browserPath, chromePid: process.pid, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  process.env.HOME = home;
  process.env.BAO_CHROME_HOLD_FIXTURE = fixture;
  const axLog = path.join(home, "audit", "current-chrome.jsonl");
  const holds = [holdDir(userDataDir), holdDir(otherRoot)];
  t.after(async () => {
    process.env.HOME = previousHome;
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    const left = [await holderPid(userDataDir), await holderPid(otherRoot)];
    for (const pid of [...holders, ...left]) {
      if (pid && pid !== process.pid && pidAlive(pid)) process.kill(pid, "SIGTERM");
    }
    await owned.close();
    await rm(scratch, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    for (const dir of holds) await rm(dir, { recursive: true, force: true });
  });

  const [first, sibling] = await Promise.all([
    openCurrentChrome({ root: userDataDir, axLog }),
    openCurrentChrome({ root: userDataDir, axLog }),
  ]);
  holders.push(await holderPid(userDataDir) ?? 0);
  const holdRoot = path.dirname(holdDir(userDataDir));
  const rootStat = await lstat(holdRoot);
  const dirStat = await lstat(holdDir(userDataDir));
  const recordStat = await lstat(path.join(holdDir(userDataDir), "hold.json"));
  const uid = process.getuid?.();
  assert.equal(path.basename(holdRoot), `bao-chrome-hold-${uid}`);
  assert.equal(rootStat.isDirectory() && rootStat.uid === uid && (rootStat.mode & 0o777) === 0o700, true);
  assert.equal(dirStat.isDirectory() && dirStat.uid === uid && (dirStat.mode & 0o777) === 0o700, true);
  assert.equal(recordStat.isSymbolicLink(), false);
  assert.equal(recordStat.mode & 0o777, 0o600);
  assert.equal(counted.upgrades(), 1, "two sessions starting together opened one connection");
  assert.equal(sibling.endpoint.port, first.endpoint.port);
  sibling.detach();
  const { targetId } = await first.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
  const listed = await first.cdp.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets");
  assert.ok(listed.targetInfos.some((target) => target.targetId === targetId));
  const contexts = await first.cdp.send<{ defaultBrowserContextId?: string }>("Target.getBrowserContexts");
  assert.equal(typeof contexts.defaultBrowserContextId, "string");
  const versionTab = await first.cdp.send<{ targetId: string }>("Target.createTarget", { url: "chrome://version", background: true, hidden: true });
  await first.cdp.send("Target.closeTarget", { targetId: versionTab.targetId });

  const otherHome = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-other-home-"));
  t.after(() => rm(otherHome, { recursive: true, force: true }));
  const other = await joinFromOtherProcess(userDataDir, axLog, otherHome);
  assert.equal(other.port, first.endpoint.port, "the other process joined the same endpoint");
  assert.equal(counted.upgrades(), 1, "a second session did not open a second connection");
  const afterOther = await first.cdp.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets");
  assert.ok(afterOther.targetInfos.some((target) => target.targetId === other.targetId), "the other session's tab is on the shared connection");
  first.detach();
  const stayed = await openCurrentChrome({ root: userDataDir, axLog });
  assert.equal(stayed.endpoint.port, other.port);
  assert.equal(counted.upgrades(), 1, "the first session leaving did not drop the connection");
  stayed.detach();

  assert.notEqual(holdDir(userDataDir), holdDir(otherRoot));
  const separate = await openCurrentChrome({ root: otherRoot, axLog });
  holders.push(await holderPid(otherRoot) ?? 0);
  assert.equal(counted.upgrades(), 2, "a different user-data-dir is a different Chrome connection");
  separate.detach();

  const killed = await holderPid(userDataDir);
  if (!killed) throw new Error("no holder to reuse");
  process.kill(killed, "SIGKILL");
  const deadAt = Date.now() + scaledMs(5_000);
  while (pidAlive(killed)) {
    if (Date.now() >= deadAt) throw new Error("the holder did not die");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const recordPath = path.join(holdDir(userDataDir), "hold.json");
  const previous = JSON.parse(await readFile(recordPath, "utf8")) as { root: string; executable: string; chromePid: number };
  const refusedPort = await closedPort();
  await writeFile(recordPath, JSON.stringify({
    root: previous.root, chromePid: previous.chromePid, executable: previous.executable,
    port: refusedPort, browserPath: "/devtools/browser/stale", holderPid: process.pid,
  }));
  const recovered = await openCurrentChrome({ root: userDataDir, axLog });
  holders.push(await holderPid(userDataDir) ?? 0);
  assert.notEqual(recovered.endpoint.port, refusedPort);
  assert.equal(counted.upgrades(), 3, "a live reused pid does not keep a refused endpoint");
  await recovered.cdp.send("Browser.getVersion");
  recovered.detach();

  counted.closeConnections();
  const gone = Date.now() + scaledMs(12_000);
  while (await holderPid(userDataDir) !== undefined || await holderPid(otherRoot) !== undefined) {
    if (Date.now() >= gone) throw new Error("the hold stayed up after its Chrome connection closed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const restarted = await openCurrentChrome({ root: userDataDir, axLog });
  holders.push(await holderPid(userDataDir) ?? 0);
  assert.equal(counted.upgrades(), 4, "Chrome's connection closing opens one new connection, not one per session");
  await restarted.cdp.send("Browser.getVersion");
  restarted.detach();
});

async function versionEndpoint(t: TestContext, browserPath: string) {
  let upgrades = 0;
  const server = createServer((socket) => {
    const decoder = new ServerFrameDecoder();
    let header = Buffer.alloc(0);
    let upgraded = false;
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        header = Buffer.concat([header, chunk]);
        const split = header.indexOf("\r\n\r\n");
        if (split < 0) return;
        upgrades++;
        upgraded = true;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        take(header.subarray(split + 4));
        return;
      }
      take(chunk);
    });
    function take(bytes: Buffer): void {
      if (!bytes.length) return;
      for (const frame of decoder.push(bytes)) {
        if (frame.opcode !== 1 || !frame.text) continue;
        const message = JSON.parse(frame.text) as { id?: number };
        if (message.id === undefined) continue;
        socket.write(serverFrame(1, Buffer.from(JSON.stringify({
          id: message.id,
          result: { protocolVersion: "1.3", product: "Chrome/test", revision: "0", userAgent: "test", jsVersion: "0", sessionId: "browser-session" },
        }))));
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, browserPath, upgrades: () => upgrades };
}

async function privateHoldDir(root: string): Promise<string> {
  const dir = holdDir(root);
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(dir), 0o700);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

function published(root: string, port: number, browserPath: string, holderPid: number) {
  return {
    root, chromePid: process.pid, executable: "/bin/test-chrome",
    port, browserPath, holderPid,
  };
}

function admitted(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.on("data", (chunk: Buffer) => {
      if (chunk.includes(0x31)) resolve(socket);
    });
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("session closed")));
  });
}

test("a settle cannot take the switch while the holder is still opening", { timeout: scaledMs(20_000) }, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-owner-"));
  const root = await realpath(scratch);
  const axLog = path.join(scratch, "ax.jsonl");
  const marker = path.join(scratch, "opening");
  const dir = holdDir(root);
  const script = `
    const { holdMain } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    const { writeFileSync } = require("fs");
    holdMain(${JSON.stringify(["--root", root, "--ax-log", axLog, "--initiator-fd", "3"])}, async () => {
      writeFileSync(${JSON.stringify(marker)}, "opening");
      await new Promise(() => undefined);
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const started = Date.now() + scaledMs(8_000);
  let sessionPort = 0;
  while (!sessionPort) {
    if (Date.now() >= started) throw new Error(`the holder did not publish a session port: ${errText}`);
    try {
      sessionPort = (JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { sessionPort?: number }).sessionPort ?? 0;
    } catch { sessionPort = 0; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const session = await admitted(sessionPort);
  t.after(() => session.destroy());
  const opening = Date.now() + scaledMs(8_000);
  while (!existsSync(marker)) {
    if (Date.now() >= opening) throw new Error(`the holder did not open after the session was counted: ${errText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(path.join(dir, "hold.json")), false);
  writeClaim(dir, true);
  const settle = `
    const { holdMain } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    holdMain(${JSON.stringify(["--root", root, "--ax-log", axLog, "--settle"])}).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  const settler = spawn(process.execPath, ["-e", settle], { stdio: ["ignore", "ignore", "pipe"] });
  let settleErr = "";
  settler.stderr?.on("data", (chunk: Buffer) => { settleErr += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { settler.kill("SIGKILL"); reject(new Error(`settle did not leave the live holder: ${settleErr}`)); }, 5_000);
    settler.once("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
  assert.equal(code, 0, settleErr);
  const starting = JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { holderPid: number };
  assert.equal(starting.holderPid, child.pid);
  assert.equal(claimOwned(dir), true);
  assert.equal(pidAlive(child.pid ?? 0), true);
  assert.equal(existsSync(marker), true);
});

test("a session that starts before the hold is published still joins it", { timeout: scaledMs(15_000) }, async (t) => {
  const browserPath = "/devtools/browser/reread";
  const endpoint = await versionEndpoint(t, browserPath);
  const sessions = await bindHoldSessions();
  t.after(() => sessions.close());
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-reread-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  const axLog = path.join(scratch, "ax.jsonl");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }));
  const script = `
    const { joinOrStartHold } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    joinOrStartHold({ root: ${JSON.stringify(root)}, axLog: ${JSON.stringify(axLog)} }).then((chrome) => {
      process.stdout.write(JSON.stringify({ port: chrome.endpoint.port }) + "\\n");
      chrome.detach();
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  let out = "";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({
    holderPid: process.pid, startedAt: Date.now(), sessionPort: sessions.port,
  }));
  await writeFile(path.join(dir, "hold.json"), JSON.stringify({
    ...published(root, endpoint.port, browserPath, process.pid), sessionPort: sessions.port,
  }));
  const deadline = Date.now() + scaledMs(8_000);
  while (!out.includes("port")) {
    if (Date.now() >= deadline) throw new Error(`the session did not join the hold it missed: ${errText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const joined = JSON.parse(out) as { port: number };
  assert.equal(joined.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 1, "the session joined the hold it missed");
  assert.equal(sessions.count(), 0);
});

test("teardown leaves a successor hold, and a waiting session joins the published one", { timeout: scaledMs(20_000) }, async (t) => {
  const browserPath = "/devtools/browser/published";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-publish-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  const successor = spawn("sleep", ["30"], { stdio: "ignore" });
  if (!successor.pid) throw new Error("no successor pid");
  const successorPid = successor.pid;
  t.after(() => { if (pidAlive(successorPid)) process.kill(successorPid, "SIGKILL"); });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const sessions = await bindHoldSessions();
  t.after(() => sessions.close());
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({
    holderPid: process.pid, startedAt: Date.now(), sessionPort: sessions.port,
  }));
  let release: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { release = resolve; });
  const serving = serveHold({
    pid: process.pid,
    executable: "/bin/test-chrome",
    root,
    endpoint: { port: endpoint.port, browserPath },
    closed,
    isClosed: () => false,
    detach() {},
  } as CurrentChrome, undefined, { sessionPort: sessions.port });
  const joined = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
  assert.equal(joined.endpoint.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 1, "the waiting session joined the published hold");
  joined.detach();
  await writeFile(path.join(dir, "hold.json"), JSON.stringify({
    ...published(root, endpoint.port, browserPath, successorPid), sessionPort: sessions.port,
  }));
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({
    holderPid: successorPid, startedAt: Date.now(), sessionPort: sessions.port,
  }));
  release();
  await serving;
  const hold = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid: number };
  const starting = JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { holderPid: number };
  assert.equal(hold.holderPid, successorPid);
  assert.equal(starting.holderPid, successorPid);
  const again = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
  assert.equal(again.endpoint.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 2, "joining the successor did not start a second holder");
  const still = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid: number };
  assert.equal(still.holderPid, successorPid);
  again.detach();
});

test("a failed hold records its error and leaves a successor starting record", { timeout: scaledMs(20_000) }, async (t) => {
  let fail: () => void = () => undefined;
  const failed = new Promise<void>((resolve) => { fail = resolve; });
  const server = createServer((socket) => {
    void failed.then(() => { socket.end("HTTP/1.1 500 No\r\nConnection: close\r\n\r\n"); });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-fail-"));
  const root = await realpath(scratch);
  const axLog = path.join(scratch, "ax.jsonl");
  const dir = holdDir(root);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const fixture = JSON.stringify({
    port, browserPath: "/devtools/browser/fail", chromePid: process.pid, executable: "/bin/test-chrome",
  });
  const script = `
    const { holdMain } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    holdMain(${JSON.stringify(["--root", root, "--ax-log", axLog])}).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, BAO_CHROME_HOLD_FIXTURE: fixture },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  const started = Date.now() + scaledMs(10_000);
  let holder = 0;
  let sessionPort = 0;
  while (holder !== child.pid || !sessionPort) {
    if (Date.now() >= started) throw new Error(`the hold did not write its starting record: ${errText}`);
    try {
      const starting = JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { holderPid: number; sessionPort?: number };
      holder = starting.holderPid;
      sessionPort = starting.sessionPort ?? 0;
    } catch { holder = 0; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const session = await admitted(sessionPort);
  t.after(() => session.destroy());
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }));
  fail();
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`holdMain did not exit: ${errText}`)); }, 15_000);
    child.once("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
  assert.notEqual(code, 0, errText);
  const err = (await readFile(path.join(dir, "hold.err"), "utf8")).trim();
  assert.ok(err.length > 0);
  const starting = JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { holderPid: number };
  assert.equal(starting.holderPid, process.pid);
});

test("a holder that is turning the switch off is not replaced while it still runs", () => {
  const alive = () => true;
  const dead = () => false;
  assert.equal(starterReusable({ holderPid: 99, startedAt: Date.now(), stopping: true }, alive), "wait");
  assert.equal(starterReusable({ holderPid: 99, startedAt: Date.now(), stopping: true }, dead), "replace");
  assert.equal(starterReusable({ holderPid: 99, startedAt: Date.now() }, alive), "wait");
  assert.equal(starterReusable({ holderPid: 99, startedAt: Date.now() - 120_000 }, alive), "wait");
  assert.equal(starterReusable(undefined, alive), "replace");
});

test("a signaled hold turns the switch off even while a session is still connected", () => {
  assert.equal(holdEnd({ signaled: true, chromeClosed: false, sessions: 1, owned: true, seenSession: true }), "turn-off");
  assert.equal(holdEnd({ signaled: false, chromeClosed: false, sessions: 1, owned: true, seenSession: true }), "wait");
  assert.equal(holdEnd({ signaled: false, chromeClosed: false, sessions: 0, owned: true, seenSession: true }), "turn-off");
  assert.equal(holdEnd({ signaled: false, chromeClosed: false, sessions: 0, owned: false, seenSession: true }), "leave");
  assert.equal(holdEnd({ signaled: false, chromeClosed: true, sessions: 1, owned: true, seenSession: true }), "turn-off");
  assert.equal(holdEnd({ signaled: true, chromeClosed: false, sessions: 1, owned: false, seenSession: true }), "leave");
});

test("a new session is rejected once the hold is draining, and one close does not empty two", async () => {
  const sessions = await bindHoldSessions();
  const first = createConnection({ host: "127.0.0.1", port: sessions.port });
  const second = createConnection({ host: "127.0.0.1", port: sessions.port });
  await new Promise<void>((resolve, reject) => {
    let open = 0;
    const up = () => { if (++open === 2) resolve(); };
    first.once("connect", up);
    second.once("connect", up);
    first.once("error", reject);
    second.once("error", reject);
  });
  const counted = Date.now() + 1_000;
  while (sessions.count() !== 2) {
    if (Date.now() >= counted) throw new Error(`the hold counted ${sessions.count()} of 2 sessions`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  first.end();
  const one = Date.now() + 1_000;
  while (sessions.count() !== 1) {
    if (Date.now() >= one) throw new Error(`one close left ${sessions.count()} sessions`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sessions.drain();
  const rejected = createConnection({ host: "127.0.0.1", port: sessions.port });
  await new Promise<void>((resolve) => {
    rejected.once("close", () => resolve());
    rejected.once("error", () => resolve());
  });
  assert.equal(sessions.count(), 1);
  second.end();
  const none = Date.now() + 1_000;
  while (sessions.count() !== 0) {
    if (Date.now() >= none) throw new Error(`the last close left ${sessions.count()} sessions`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sessions.close();
});

test("a joined session is a connection to the hold, and detach closes it", async (t) => {
  const browserPath = "/devtools/browser/session";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-session-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const sessions = await bindHoldSessions();
  t.after(() => sessions.close());
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now(), sessionPort: sessions.port }));
  const serving = serveHold({
    pid: process.pid,
    executable: "/bin/test-chrome",
    root,
    endpoint: { port: endpoint.port, browserPath },
    closed: new Promise<void>(() => undefined),
    isClosed: () => false,
    detach() {},
  } as CurrentChrome, undefined, { sessionPort: sessions.port });
  t.after(() => { serving.catch(() => undefined); });
  const joined = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
  assert.equal(sessions.count(), 1);
  joined.detach();
  const gone = Date.now() + 2_000;
  while (sessions.count() !== 0) {
    if (Date.now() >= gone) throw new Error("detach did not close the session connection");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a listen-only hold is spawned with that flag and does not turn the switch on", () => {
  const options = { root: "/tmp/chrome", axLog: "/tmp/ax.jsonl", listenOnly: true };
  const dev = holdLaunch("/work/cli.js", options);
  assert.ok(dev.args.includes("--listen-only"));
  assert.equal(dev.args.includes("--settle"), false);
  const settle = holdLaunch("/work/cli.js", { root: options.root, axLog: options.axLog, settle: true });
  assert.ok(settle.args.includes("--settle"));
  assert.equal(settle.args.includes("--listen-only"), false);
});

test("a profile read uses the shared connection only after the hold counts it", { timeout: scaledMs(15_000) }, async (t) => {
  const browserPath = "/devtools/browser/profile-read";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-profile-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  const marker = path.join(scratch, "read-done");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const sessions = await bindHoldSessions();
  t.after(() => sessions.close());
  sessions.drain();
  await writeFile(path.join(dir, "hold.json"), JSON.stringify({
    ...published(root, endpoint.port, browserPath, process.pid), sessionPort: sessions.port,
  }));
  const script = `
    delete process.env.BAO_LANE;
    delete process.env.BAO_TEST_BROWSER;
    const { existsSync } = require("fs");
    const { withListeningConnection } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/current-chrome.js"))});
    withListeningConnection(${JSON.stringify(root)}, async (cdp) => {
      await cdp.send("Browser.getVersion", {}, undefined, 5000);
      process.stdout.write("reading\\n");
      const deadline = Date.now() + 8000;
      while (!existsSync(${JSON.stringify(marker)})) {
        if (Date.now() >= deadline) throw new Error("the profile read was not released");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return "ok";
    }).then((value) => {
      if (value !== "ok") process.exit(2);
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  let out = "";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(out.includes("reading"), false, errText);
  assert.equal(endpoint.upgrades(), 0);
  sessions.resume();
  const deadline = Date.now() + scaledMs(8_000);
  while (!out.includes("reading")) {
    if (Date.now() >= deadline) throw new Error(`the profile read did not join after admission: ${errText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sessions.count(), 1);
  assert.equal(endpoint.upgrades(), 1);
  await writeFile(marker, "done");
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(errText)); }, 8_000);
    child.once("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
  assert.equal(code, 0, errText);
  assert.equal(sessions.count(), 0);
});

test("a client does not join a hold that is turning the switch off", { timeout: scaledMs(15_000) }, async (t) => {
  const browserPath = "/devtools/browser/draining";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-drain-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const sessions = await bindHoldSessions();
  t.after(() => sessions.close());
  sessions.drain();
  await writeFile(path.join(dir, "hold.json"), JSON.stringify({
    ...published(root, endpoint.port, browserPath, process.pid), sessionPort: sessions.port,
  }));
  let joined = false;
  const joining = joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") }).then((chrome) => {
    joined = true;
    return chrome;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(joined, false);
  assert.equal(endpoint.upgrades(), 0);
  const saved = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid: number };
  assert.equal(saved.holderPid, process.pid);
  sessions.resume();
  const chrome = await joining;
  assert.equal(chrome.endpoint.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 1);
  assert.equal(sessions.count(), 1);
  chrome.detach();
});

test("a starter that exits before it connects does not enable debugging", { timeout: scaledMs(15_000) }, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-starter-"));
  const root = await realpath(scratch);
  const axLog = path.join(scratch, "ax.jsonl");
  const marker = path.join(scratch, "enabled");
  const dir = holdDir(root);
  const script = `
    const { holdMain } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    const { writeFileSync } = require("fs");
    holdMain(${JSON.stringify(["--root", root, "--ax-log", axLog, "--initiator-fd", "3"])}, async () => {
      writeFileSync(${JSON.stringify(marker)}, "enabled");
      return new Promise(() => undefined);
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const started = Date.now() + scaledMs(8_000);
  while (!existsSync(path.join(dir, "starting.json"))) {
    if (Date.now() >= started) throw new Error(`the holder did not start: ${errText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pipe = child.stdio[3];
  if (!pipe || typeof pipe === "number") throw new Error("the starter pipe was not passed");
  pipe.destroy();
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`the holder stayed up without a session: ${errText}`)); }, 8_000);
    child.once("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
  assert.equal(code, 0, errText);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path.join(dir, "hold.json")), false);
  assert.equal(existsSync(path.join(dir, "starting.json")), false);
});

test("a listen-only profile read returns the opener error when the switch is off", { timeout: scaledMs(15_000) }, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-silent-"));
  const root = await realpath(scratch);
  const axLog = path.join(scratch, "ax.jsonl");
  const dir = holdDir(root);
  const script = `
    const { holdMain } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/chrome-hold.js"))});
    holdMain(${JSON.stringify(["--root", root, "--ax-log", axLog, "--listen-only", "--initiator-fd", "3"])}, async () => {
      throw new Error("Chrome is not listening");
    }).catch((error) => {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
  let errText = "";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
  t.after(() => { if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL"); });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const started = Date.now() + scaledMs(8_000);
  while (!existsSync(path.join(dir, "starting.json"))) {
    if (Date.now() >= started) throw new Error(`the holder did not start: ${errText}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const began = Date.now();
  await assert.rejects(joinOrStartHold({ root, axLog, listenOnly: true }), /Chrome is not listening/);
  assert.ok(Date.now() - began < 5_000, "the profile read waited out the hold deadline");
  const pipe = child.stdio[3];
  if (pipe && typeof pipe !== "number") pipe.destroy();
});

test("a stale hold error from a dead holder does not cancel a fresh start", { timeout: scaledMs(20_000) }, async (t) => {
  const browserPath = "/devtools/browser/stale-err";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-stale-err-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  const dead = spawn("sleep", ["30"], { stdio: "ignore" });
  if (!dead.pid) throw new Error("no dead holder pid");
  const deadPid = dead.pid;
  process.kill(deadPid, "SIGKILL");
  const stale = JSON.stringify({ holderPid: deadPid, message: "stale opener" });
  const previous = process.env.BAO_CHROME_HOLD_FIXTURE;
  process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
    port: endpoint.port, browserPath, chromePid: process.pid, executable: "/bin/test-chrome",
  });
  t.after(() => {
    if (previous === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previous;
  });
  t.after(async () => {
    try {
      const record = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid?: number };
      if (record.holderPid && pidAlive(record.holderPid)) process.kill(record.holderPid, "SIGKILL");
    } catch {
      /* the holder already exited */
    }
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  let stop = false;
  const keepStale = setInterval(() => {
    if (stop || existsSync(path.join(dir, "hold.json"))) return;
    writeFile(path.join(dir, "hold.err"), stale).catch(() => undefined);
  }, 5);
  t.after(() => { stop = true; clearInterval(keepStale); });
  await writeFile(path.join(dir, "hold.err"), stale);
  const chrome = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
  stop = true;
  clearInterval(keepStale);
  await chrome.cdp.send("Browser.getVersion", {}, undefined, 5_000);
  assert.equal(endpoint.upgrades(), 1);
  chrome.detach();
});

async function olderHoldSetup(t: TestContext, press: string, record: boolean) {
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-older-"));
  const root = await realpath(await chromeProfiles(path.join(scratch, "chrome")));
  const owned = await launchOwnedChromeEndpoint({ userDataDir: root, headless: true, args: ["--no-startup-window"] });
  if (!owned.pid) throw new Error("the test Chrome has no pid");
  const chromePid = owned.pid;
  const endpoint = await readDevToolsActivePort(owned.portFile);
  const keeper = await connectCdp(endpoint.port, endpoint.browserPath);
  await keeper.send("Target.createTarget", { url: "about:blank", background: true });
  let live = 0;
  let mostLive = 0;
  const sockets = new Set<Socket>();
  const counter = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: endpoint.port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy()).once("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.once("data", (head: Buffer) => {
      if (/^GET \/devtools\/browser\S* HTTP/.test(head.toString("latin1"))) {
        live++;
        mostLive = Math.max(mostLive, live);
        client.once("close", () => { live--; });
      }
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  await new Promise<void>((resolve) => counter.listen(0, "127.0.0.1", resolve));
  const port = (counter.address() as AddressInfo).port;
  const dir = await privateHoldDir(root);
  const olderLog = path.join(scratch, "older-home", "audit", "current-chrome.jsonl");
  const axLog = path.join(scratch, "new-home", "audit", "current-chrome.jsonl");
  await mkdir(path.dirname(olderLog), { recursive: true });
  await writeFile(olderLog, `${JSON.stringify({ what: "AXPress", role: "AXCheckBox", name: "Allow remote debugging for this browser instance", window: "Inspect with Chrome Developer Tools", at: press, via: "BaoOSHelper" })}\n`);
  // A holder from before the owner lock: same command line, one Chrome connection of its own, a record with no session port.
  const stubFile = path.join(scratch, "older-holder.js");
  await writeFile(stubFile, `
    const { connectCdp } = require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
    connectCdp(${port}, ${JSON.stringify(endpoint.browserPath)}).then(async (cdp) => {
      await cdp.send("Browser.getVersion");
      process.once("SIGTERM", () => { cdp.close(); process.exit(0); });
      process.stdout.write("held\\n");
    });
  `);
  const older = spawn(process.execPath, [stubFile, "chrome-hold", "--root", root, "--ax-log", olderLog], { stdio: ["ignore", "pipe", "inherit"] });
  if (!older.pid) throw new Error("the older holder did not start");
  const olderPid = older.pid;
  const exited = new Promise<void>((resolve) => older.once("exit", () => resolve()));
  const olderExit = () => Promise.race([exited, new Promise((resolve) => setTimeout(resolve, scaledMs(3_000)))]);
  await new Promise<void>((resolve) => older.stdout?.once("data", () => resolve()));
  if (record) {
    await writeFile(path.join(dir, "hold.json"), JSON.stringify({
      root, chromePid, executable: "/bin/test-chrome", port, browserPath: endpoint.browserPath, holderPid: olderPid,
    }));
  }
  const previous = process.env.BAO_CHROME_HOLD_FIXTURE;
  process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({ port, browserPath: endpoint.browserPath, chromePid, executable: "/bin/test-chrome" });
  t.after(async () => {
    if (previous === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previous;
    if (pidAlive(olderPid)) older.kill("SIGKILL");
    const left = await holderPid(root);
    if (left && left !== olderPid && pidAlive(left)) process.kill(left, "SIGTERM");
    counter.close();
    for (const socket of sockets) socket.destroy();
    keeper.close();
    await owned.close();
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  return { root, dir, axLog, olderLog, olderPid, olderExit, mostLive: () => mostLive };
}

async function holderAfterLastSession(root: string, chrome: CurrentChrome): Promise<{ holder: number; exited: boolean }> {
  const holder = await holderPid(root);
  if (!holder) throw new Error("the new hold did not publish");
  chrome.detach();
  const until = Date.now() + scaledMs(3_000);
  while (pidAlive(holder) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  return { holder, exited: !pidAlive(holder) };
}

test("an older Bao's live hold is retired before the new hold connects, and the switch it turned on is turned off at the last session end", { timeout: scaledMs(60_000) }, async (t) => {
  const older = await olderHoldSetup(t, new Date().toISOString(), true);
  const chrome = await joinOrStartHold({ root: older.root, axLog: older.axLog });
  await older.olderExit();
  assert.equal(older.mostLive(), 1, "Chrome never had two Bao connections at once");
  assert.equal(pidAlive(older.olderPid), false, "the older holder ended");
  assert.notEqual(older.olderLog, older.axLog);
  let sessionAudit = "";
  try { sessionAudit = await readFile(older.axLog, "utf8"); } catch { sessionAudit = ""; }
  assert.equal(sessionAudit.includes("AXCheckBox"), false, "the upgraded session's audit has no press");
  assert.equal(claimOwned(older.dir), true, "a press since this Chrome started is Bao's switch");
  await chrome.cdp.send("Browser.getVersion");
  const { holder, exited } = await holderAfterLastSession(older.root, chrome);
  assert.notEqual(holder, older.olderPid);
  assert.equal(exited, true, "the last session ending took the turn-off path, which ends the hold");
});

test("an older Bao's hold whose record is already gone is retired, and a switch Bao did not turn on in this Chrome stays the owner's", { timeout: scaledMs(60_000) }, async (t) => {
  const older = await olderHoldSetup(t, "2026-01-01T00:00:00.000Z", false);
  const chrome = await joinOrStartHold({ root: older.root, axLog: older.axLog });
  await older.olderExit();
  assert.equal(older.mostLive(), 1);
  assert.equal(pidAlive(older.olderPid), false);
  assert.equal(claimOwned(older.dir), false);
  const { exited } = await holderAfterLastSession(older.root, chrome);
  assert.equal(exited, false, "the hold stays while Chrome runs when the switch is the owner's");
});
