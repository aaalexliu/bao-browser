// Two processes on one user-data-dir must open one debugging connection. A second user-data-dir, or a Chrome restart,
// opens one more. The counting endpoint stands in for Chrome's Allow sheet: each browser-level upgrade is one ask.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { holdDir, holdLaunch, joinOrStartHold, serveHold } from "../../src/cdp-live/chrome-hold";
import { openCurrentChrome, type CurrentChrome } from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort, type DevToolsEndpoint } from "../../src/cdp-live/endpoint";
import { connectCdp, ServerFrameDecoder, serverFrame } from "../../src/cdp-live/socket";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { chromeProfiles } from "../support/chrome-profiles";

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

test("one user-data-dir is one Chrome connection, shared by a later process, and a restart opens one more", { timeout: 120_000 }, async (t) => {
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
  const deadAt = Date.now() + 5_000;
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
  const gone = Date.now() + 12_000;
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
          result: { protocolVersion: "1.3", product: "Chrome/test", revision: "0", userAgent: "test", jsVersion: "0" },
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

test("a reader between the hold publish and the starting-record removal finds the hold", async (t) => {
  const browserPath = "/devtools/browser/publish-gap";
  const endpoint = await versionEndpoint(t, browserPath);
  const scratch = await mkdtemp(path.join(tmpdir(), "bao-chrome-hold-gap-"));
  const root = await realpath(scratch);
  const dir = await privateHoldDir(root);
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });
  const planted = published(root, endpoint.port, browserPath, process.pid);
  await writeFile(path.join(dir, "hold.json"), JSON.stringify(planted));
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }));
  const axLog = path.join(scratch, "ax.jsonl");
  const [first, second] = await Promise.all([
    joinOrStartHold({ root, axLog }),
    joinOrStartHold({ root, axLog }),
  ]);
  assert.equal(first.endpoint.port, endpoint.port);
  assert.equal(second.endpoint.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 2, "two sessions joined the published hold and neither started another connection");
  const saved = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid: number; port: number };
  assert.equal(saved.holderPid, process.pid);
  assert.equal(saved.port, endpoint.port);
  first.detach();
  second.detach();
});

test("teardown leaves a successor hold, and a waiting session joins the published one", { timeout: 20_000 }, async (t) => {
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
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: process.pid, startedAt: Date.now() }));
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
  } as CurrentChrome);
  const joined = await joinOrStartHold({ root, axLog: path.join(scratch, "ax.jsonl") });
  assert.equal(joined.endpoint.port, endpoint.port);
  assert.equal(endpoint.upgrades(), 1, "the waiting session joined the published hold");
  joined.detach();
  await writeFile(path.join(dir, "hold.json"), JSON.stringify(published(root, endpoint.port, browserPath, successorPid)));
  await writeFile(path.join(dir, "starting.json"), JSON.stringify({ holderPid: successorPid, startedAt: Date.now() }));
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

test("a failed hold records its error and leaves a successor starting record", { timeout: 20_000 }, async (t) => {
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
  const started = Date.now() + 10_000;
  let holder = 0;
  while (holder !== child.pid) {
    if (Date.now() >= started) throw new Error(`the hold did not write its starting record: ${errText}`);
    try {
      holder = (JSON.parse(await readFile(path.join(dir, "starting.json"), "utf8")) as { holderPid: number }).holderPid;
    } catch { holder = 0; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
