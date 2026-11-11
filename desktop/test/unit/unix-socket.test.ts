import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startExtensionLink, hostScriptPath } from "../../src/extension/link";
import { assertSocketPath, createSocketSession, prepareSocketPath, socketRoot } from "../../src/unix-socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launches from "../../src/launch";

function deepTmpdir(t: TestContext, value: string): void {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = value;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
}

async function stop(child: ChildProcess, group = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (group && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { child.kill("SIGTERM"); }
  } else child.kill("SIGTERM");
  await exited;
}

async function started(child: ChildProcess, pattern: RegExp): Promise<string> {
  let output = "";
  let errors = "";
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timed out: ${output}\n${errors}`)), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`startup exited ${code}: ${output}\n${errors}`)); });
    child.stdout!.on("data", chunk => {
      output += String(chunk);
      if (pattern.test(output)) { clearTimeout(timer); resolve(output); }
    });
  });
}

test("Unix socket length errors include the path and its byte length", () => {
  assert.doesNotThrow(() => assertSocketPath("/" + "x".repeat(102)));
  for (const socket of ["/" + "x".repeat(103), "/" + "é".repeat(52)]) {
    assert.throws(() => assertSocketPath(socket), { message: `Unix socket path is ${Buffer.byteLength(socket)} bytes (maximum 103): ${socket}` });
  }
});

test("deep TMPDIR and two Bao homes keep extension bridges separate", { timeout: 20_000 }, async t => {
  const root = await mkdtemp("/tmp/bao-sockets-test-");
  const deep = path.join(root, "x".repeat(150));
  await mkdir(deep);
  deepTmpdir(t, deep);
  const homes = [path.join(deep, "one"), path.join(deep, "two")];
  const links: Awaited<ReturnType<typeof startExtensionLink>>[] = [];
  try {
    for (const home of homes) {
      const link = await startExtensionLink({ home, configHome: home, hostScript: hostScriptPath() });
      links.push(link);
      assert.equal(link.socketPath, path.join(socketRoot(home), "bridge.sock"));
      assert.ok((await lstat(link.socketPath)).isSocket());
      assert.equal((await lstat(socketRoot(home))).mode & 0o777, 0o700);
      const socket = createConnection(link.socketPath);
      try { await once(socket, "connect"); } finally { socket.destroy(); }
      const wrapper = await readFile(path.join(home, "extension-host/bao-native-host.sh"), "utf8");
      assert.ok(wrapper.includes(link.socketPath));
    }
    assert.notEqual(links[0]!.socketPath, links[1]!.socketPath);
    await links[0]!.close();
    await assert.rejects(lstat(links[0]!.socketPath), { code: "ENOENT" });
    assert.equal((await lstat(socketRoot(homes[0]!))).isDirectory(), true);
    assert.ok((await lstat(links[1]!.socketPath)).isSocket());
  } finally {
    for (const link of links) await link.close();
    for (const home of homes) await rm(socketRoot(home), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a finished owner leaves the shared root a peer has already prepared", async () => {
  const root = await mkdtemp("/tmp/bao-socket-race-");
  const home = path.join(root, "home");
  const link = await startExtensionLink({ home, configHome: home, hostScript: hostScriptPath() });
  const prefix = prepareSocketPath(home, "proxy-");
  try {
    await link.close();
    const dir = mkdtempSync(prefix);
    assert.equal(path.dirname(dir), socketRoot(home));
    await rm(dir, { recursive: true, force: true });
    const session = createSocketSession(home);
    assert.equal(path.dirname(session), socketRoot(home));
    await rm(session, { recursive: true, force: true });
  } finally {
    await link.close();
    await rm(socketRoot(home), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI serve and the MCP client bind short sockets from a deep TMPDIR", { timeout: 40_000 }, async t => {
  const root = await mkdtemp("/tmp/bao-socket-start-");
  const deep = path.join(root, "x".repeat(150));
  await mkdir(deep);
  deepTmpdir(t, deep);
  const home = path.join(deep, "home");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BAO_HOME: home, TMPDIR: deep, BAO_HEAL_CURSOR_ACCOUNT: "0" };
  delete env.BAO_MCP_SOCK;
  const cli = path.resolve(__dirname, "../../src/app/cli.js");
  const app = spawn(process.execPath, [cli, "serve", "--home", home, "--port", "0"], { env, detached: true });
  let client: ChildProcess | undefined;
  try {
    await started(app, /bao \d+ home/);
    const bridge = path.join(socketRoot(home), "bridge.sock");
    assert.ok((await lstat(bridge)).isSocket());
    assert.ok(Buffer.byteLength(bridge) <= 103);
    await stop(app, true);
    client = spawn(process.execPath, [path.resolve(__dirname, "../../src/mcp/client.js"), "serve"], { env, detached: true });
    await started(client, /mcp client listening/);
    assert.ok((await lstat(path.join(socketRoot(home), "mcp.sock"))).isSocket());
    assert.equal((await lstat(socketRoot(home))).mode & 0o777, 0o700);
  } finally {
    await stop(app, true);
    if (client) await stop(client, true);
    await rm(socketRoot(home), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

const native = process.env.AGENT_BROWSER_PROXY_BINARY;

test("the pinned agent-browser starts its session socket with deep TMPDIR", { skip: !native, timeout: 60_000 }, async t => {
  launches.pinTestBrowser();
  const root = await mkdtemp("/tmp/bao-native-socket-");
  const deep = path.join(root, "x".repeat(150));
  await mkdir(deep);
  deepTmpdir(t, deep);
  const home = path.join(deep, "home");
  const launch = launches.launchOwnedChromeEndpoint;
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => launch({ ...options, headless: true }));
  const server = createServer((_request, response) => response.end("<!doctype html><title>Socket fixture</title><h1>Ready</h1>"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxy = new AgentBrowserProxy({ home, sourceRoot: path.join(root, "no-chrome-profile"), executable: native });
  try {
    const results = await proxy.execute("open", [`http://127.0.0.1:${address.port}/`], "bao");
    assert.equal(results[0]!.exitCode, 0, results[0]!.stdout + results[0]!.stderr);
    const session = (await readdir(socketRoot(home))).find(name => name.startsWith("proxy-"));
    assert.ok(session);
    const socketPath = path.join(socketRoot(home), session, "bao.sock");
    assert.ok((await lstat(socketPath)).isSocket());
    assertSocketPath(socketPath);
    assert.equal((await lstat(path.dirname(socketPath))).mode & 0o777, 0o700);
    console.log(`native socket ${Buffer.byteLength(socketPath)} bytes with TMPDIR ${Buffer.byteLength(deep)} bytes`);
    proxy.disconnect();
    await proxy.close();
    assert.equal((await readdir(socketRoot(home))).some(name => name.startsWith("proxy-")), false);
  } finally {
    proxy.disconnect();
    await proxy.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(socketRoot(home), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("native and JS socket paths match, bind and clean with deep TMPDIR", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const root = await mkdtemp("/tmp/bao-notify-socket-");
  const deep = path.join(root, "x".repeat(150));
  await mkdir(deep);
  deepTmpdir(t, deep);
  const home = path.join(deep, "home");
  const socketPath = prepareSocketPath(home, "notify.sock");
  try {
    const fixture = path.join(root, "notify-test.m");
    await writeFile(fixture, `#define main bao_launcher_main
#include "bao-main.c"
#undef main
int bao_window_run(const char *url, int pid) { (void)url; (void)pid; return 1; }
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  char root[64], sock[104];
  notify_paths(argv[1], root, sizeof root, sock, sizeof sock);
  if (strcmp(sock, argv[2]) != 0 || strlen(sock) > 103) return 2;
  rmdir(root);
  if (bao_notify_prepare(sock) != 0) return 3;
  struct stat st;
  if (stat(sock, &st) != 0 || !S_ISSOCK(st.st_mode)) return 4;
  puts(sock);
  bao_notify_stop();
  if (stat(sock, &st) == 0 || stat(root, &st) != 0) return 5;
  char too_long[105]; memset(too_long, 'x', 104); too_long[104] = 0;
  if (bao_notify_prepare(too_long) != -1) return 6;
  puts("ok native notification socket");
  return 0;
}
`);
    const macos = path.resolve("desktop/packaging/macos");
    const binary = path.join(root, "notify-test");
    execFileSync("/usr/bin/clang", ["-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror", "-I", macos,
      "-framework", "Foundation", "-framework", "AppKit", "-framework", "WebKit", "-framework", "UserNotifications",
      fixture, path.join(macos, "bao-launch.c"), path.join(macos, "bao-run-node.c"), path.join(macos, "bao-notify.m"), "-o", binary], { timeout: 40_000 });
    const output = execFileSync(binary, [home, socketPath], { env: { ...process.env, HOME: root, TMPDIR: deep }, encoding: "utf8", timeout: 5000 });
    assert.equal(output, `${socketPath}\nok native notification socket\n`);
    assert.equal((await lstat(socketRoot(home))).isDirectory(), true);
  } finally {
    await rm(socketRoot(home), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
