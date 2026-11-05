import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pinTestBrowser, pidsForDataDir } from "../../src/launch";
import { Library } from "../../src/v1/store";

const cli = path.resolve(__dirname, "../../src/app/cli.js");
interface Result { isError?: boolean; content?: { text: string }[] }

async function until(read: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await read()) return; await delay(50); }
  throw new Error("session cleanup timed out");
}

async function fixture(blockCommand?: "snapshot" | "close") {
  const root = await mkdtemp(path.join(tmpdir(), "bao-session-end-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(blockCommand)})) {
  require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "native-pending"))}, 'ready');
  setInterval(() => {}, 1000);
} else if (args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  fetch('http://' + endpoint.host + '/json/list').then(r => r.json()).then(tabs => {
    process.stdout.write(JSON.stringify({ data: { tabs: tabs.filter(t => t.type === 'page').map(t => ({ active: true, targetId: t.id })) } }));
  });
} else process.stdout.write('native success\\n');
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, BAO_HOME: home,
    BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_TEST_BROWSER: pinTestBrowser(),
    BAO_AGENT_BROWSER: executable, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  };
  const namespace = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 20);
  const copies = path.join(tmpdir(), `bao-profile-copies-${namespace}`);
  const library = new Library(home);
  const clients: ReturnType<typeof client>[] = [];
  return {
    home, library, env, copies,
    pending: () => until(() => access(path.join(root, "native-pending")).then(() => true, () => false)),
    start(agent = false) { const c = client(env, agent); clients.push(c); return c; },
    async copy() {
      const entries = await readdir(copies);
      assert.equal(entries.length, 1);
      return path.join(copies, entries[0]!);
    },
    async close() {
      for (const c of clients) await c.close();
      for (const name of await readdir(copies).catch(() => [])) {
        const copy = path.join(copies, name);
        for (const pid of pidsForDataDir(copy)) process.kill(pid, "SIGTERM");
        await until(() => pidsForDataDir(copy).length === 0);
      }
      await rm(copies, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function client(env: NodeJS.ProcessEnv, agent: boolean) {
  // Exiting this parent closes the MCP pipe, just as a real agent exiting does.
  const parent = `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath, [${JSON.stringify(cli)}, 'mcp'], {stdio:['pipe','inherit','inherit']});
    process.stdin.on('data', chunk=>c.stdin.write(chunk));
    process.stdin.on('end', ()=>process.exit(0));`;
  const child = spawn(process.execPath, agent ? ["-e", parent] : [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map<number, (result: Result) => void>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, newline)) as { id: number; result: Result };
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply.result);
      pending.delete(reply.id);
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const send = (method: string, params = {}, id = ++sequence) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const request = (method: string, params = {}): Promise<Result> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out: ${stderr}`)); }, 20_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    send(method, params, id);
  });
  return {
    request, send,
    call: (command: string) => request("tools/call", { name: "agent_browser", arguments: { command } }),
    async close() { if (child.exitCode === null && child.signalCode === null) child.stdin.end(); await exited; },
    async stop() { child.kill("SIGTERM"); await exited; },
  };
}

for (const ending of ["queued-eof", "active-signal"] as const) {
  test(`explicit close overrides keep-open during ${ending}`, { timeout: 60_000 }, async () => {
    const f = await fixture(ending === "queued-eof" ? "snapshot" : "close");
    try {
      f.library.updateSettings({ keepAgentBrowserOpen: true });
      const c = f.start();
      await c.request("initialize");
      assert.equal((await c.call("open")).isError, false);
      const copy = await f.copy();
      c.send("tools/call", { name: "agent_browser", arguments: { command: ending === "queued-eof" ? "snapshot" : "close" } });
      await f.pending();
      if (ending === "queued-eof") {
        c.send("tools/call", { name: "agent_browser", arguments: { command: "close" } });
        await c.close();
      } else {
        await c.stop();
      }
      assert.equal(pidsForDataDir(copy).length, 0, "explicit close must not leave Chrome running");
      await assert.rejects(access(copy), /ENOENT/, "explicit close must delete the private copy");
      assert.notEqual(f.library.listRuns()[0]!.status, "recording");
    } finally { await f.close(); }
  });
}

for (const ending of ["agent-exit", "disconnect", "signal"] as const) {
  test(`${ending} closes the marked Chrome, removes its copy, finishes the run and allows another open`, { timeout: 60_000 }, async () => {
    const f = await fixture();
    try {
      const c = f.start(ending === "agent-exit");
      await c.request("initialize");
      assert.equal((await c.call("open")).isError, false);
      const copy = await f.copy();
      assert.ok(pidsForDataDir(copy).length);
      assert.equal(f.library.listRuns()[0]!.status, "recording");
      if (ending === "signal") await c.stop(); else await c.close();
      await until(() => pidsForDataDir(copy).length === 0);
      await until(() => access(copy).then(() => false, () => true));
      assert.equal(f.library.listRuns()[0]!.status, "passed");
      const next = f.start();
      await next.request("initialize");
      assert.equal((await next.call("open")).isError, false);
      assert.notEqual(await f.copy(), copy);
      await next.close();
    } finally { await f.close(); }
  });
}

test("a stopped MCP cleans up its proxy even while a live request is stuck", { timeout: 45_000 }, async () => {
  const f = await fixture();
  let received!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((req) => { req.resume(); received(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(path.join(f.home, "server.json"), JSON.stringify({ port: address.port }));
  try {
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    c.send("tools/call", { name: "live_snapshot", arguments: {} });
    await requested;
    await c.stop();
    assert.equal(pidsForDataDir(copy).length, 0);
    await assert.rejects(access(copy), /ENOENT/);
    assert.equal(f.library.listRuns()[0]!.status, "passed");
    const next = f.start();
    await next.request("initialize");
    assert.equal((await next.call("open")).isError, false);
    await next.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

test("close received after stop closes a retained window before a queued live call finishes", { timeout: 45_000 }, async () => {
  const f = await fixture();
  let received!: () => void;
  let reply: (() => void) | undefined;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    if (reply) { res.end("{}"); return; }
    reply = () => res.end("{}");
    received();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(path.join(f.home, "server.json"), JSON.stringify({ port: address.port }));
  try {
    f.library.updateSettings({ keepAgentBrowserOpen: true });
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    c.send("tools/call", { name: "live_snapshot", arguments: {} });
    await requested;
    const stopped = c.stop();
    await until(async () => JSON.parse(await readFile(path.join(copy, "lease.json"), "utf8")).retained === true);
    c.send("tools/call", { name: "agent_browser", arguments: { command: "close" } });
    await until(() => access(copy).then(() => false, () => true));
    assert.equal(pidsForDataDir(copy).length, 0);
    reply?.();
    await stopped;
  } finally {
    reply?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});

test("keep-open finishes the run and the next session reclaims only that home's retained window", { timeout: 60_000 }, async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const unrelated = other.start();
    await unrelated.request("initialize");
    assert.equal((await unrelated.call("open")).isError, false);
    const unrelatedCopy = await other.copy();
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    // Read the owner's current choice at disconnect, not only at MCP startup.
    f.library.updateSettings({ keepAgentBrowserOpen: true });
    await c.close();
    assert.ok(pidsForDataDir(copy).length);
    const lease = JSON.parse(await readFile(path.join(copy, "lease.json"), "utf8")) as { retained?: boolean };
    assert.equal(lease.retained, true);
    assert.equal(f.library.listRuns()[0]!.status, "passed");
    const next = f.start();
    await next.request("initialize");
    assert.equal((await next.call("open")).isError, false);
    assert.equal(pidsForDataDir(copy).length, 0);
    await assert.rejects(access(copy), /ENOENT/);
    assert.notEqual(await f.copy(), copy);
    assert.ok(pidsForDataDir(unrelatedCopy).length, "another Bao home stays open");
    const freshCopy = await f.copy();
    assert.equal((await next.call("close")).isError, false, "explicit close overrides keep-open");
    assert.equal((await next.call("close")).isError, false, "explicit close is idempotent");
    await assert.rejects(access(freshCopy), /ENOENT/);
    await next.close();
  } finally { await f.close(); await other.close(); }
});
