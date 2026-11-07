import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeRetainedChrome, launchOwnedChromeEndpoint, pinTestBrowser, pidsForDataDir } from "../../src/launch";
import * as cdpSocket from "../../src/cdp-live/socket";
import { Library } from "../../src/v1/store";
import { loadState, saveState } from "../../src/v1/sync";
import { laneChildEnv } from "../runtime";

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
  const teardown = path.join(root, "teardown");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!fs.existsSync(${JSON.stringify(teardown)}) && args.includes(${JSON.stringify(blockCommand)})) {
  fs.writeFileSync(${JSON.stringify(path.join(root, "native-pending"))}, 'ready');
  setInterval(() => {}, 1000);
} else if (args.includes('fill')) {
  console.error('fixture field missing'); process.exitCode = 7;
} else if (args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  fetch('http://' + endpoint.host + '/json/list').then(r => r.json()).then(tabs => {
    process.stdout.write(JSON.stringify({ data: { tabs: tabs.filter(t => t.type === 'page').map(t => ({ active: true, targetId: t.id })) } }));
  });
} else process.stdout.write('native success\\n');
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, BAO_HOME: home,
    BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_TEST_BROWSER: pinTestBrowser(), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
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
    start(agent = false, group = false) { const c = client(env, agent, group); clients.push(c); return c; },
    async copy() {
      const entries = await readdir(copies);
      assert.equal(entries.length, 1);
      return path.join(copies, entries[0]!);
    },
    async close() {
      library.updateSettings({ keepAgentBrowserOpen: false });
      await writeFile(teardown, "ready");
      for (const c of clients) await c.close();
      if ((await readdir(copies).catch(() => [])).length) {
        const cleanup = client(env, false, false);
        try {
          await cleanup.request("initialize");
          assert.equal((await cleanup.call("open")).isError, false);
          assert.equal((await cleanup.call("close")).isError, false);
        } finally { await cleanup.close(); }
      }
      for (const name of await readdir(copies).catch(() => [])) {
        const copy = path.join(copies, name);
        await closeRetainedChrome(copy);
        await until(() => pidsForDataDir(copy).length === 0);
      }
      await rm(copies, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function client(env: NodeJS.ProcessEnv, agent: boolean, group: boolean) {
  // Exiting this parent closes the MCP pipe, just as a real agent exiting does.
  const parent = `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath, [${JSON.stringify(cli)}, 'mcp'], {stdio:['pipe','inherit','inherit']});
    process.stdin.on('data', chunk=>c.stdin.write(chunk));
    process.stdin.on('end', ()=>process.exit(0));`;
  const child = spawn(process.execPath, agent ? ["-e", parent] : [cli, "mcp"], { env, detached: group, stdio: ["pipe", "pipe", "pipe"] });
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
    request, send, pid: child.pid,
    call: (command: string, args: string[] = []) => request("tools/call", { name: "agent_browser", arguments: { command, args } }),
    async close() { if (child.exitCode === null && child.signalCode === null) child.stdin.end(); await exited; },
    async stop() { child.kill("SIGTERM"); await exited; },
    async interruptGroup(signal: "SIGINT" | "SIGTERM" | "SIGHUP", repeat: boolean) {
      assert.ok(group && child.pid);
      process.kill(-child.pid, signal);
      if (repeat) {
        await delay(10);
        try { process.kill(-child.pid, signal); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // macOS can report EPERM while an exited group leader awaits reaping.
          const alreadyExited = code === "EPERM" && await Promise.race([
            exited.then(() => true), delay(1000).then(() => false),
          ]);
          if (code !== "ESRCH" && !alreadyExited) throw error;
        }
      }
      await exited;
    },
  };
}

if (process.env.BAO_SESSION_END_FAILURE_PROBE) {
  test("kept-copy failure probe", { timeout: 60_000 }, async (t) => {
    const f = await fixture("close");
    t.after(async () => {
      try {
        await f.close();
      } finally {
        const entries = await readdir(f.copies).catch(() => []);
        const remainingPids = entries.flatMap(name => pidsForDataDir(path.join(f.copies, name)));
        if (entries.length) {
          const recovery = f.start();
          try {
            await recovery.request("initialize");
            assert.equal((await recovery.call("open")).isError, false);
          } finally { await recovery.close(); }
          await f.close();
        }
        await writeFile(process.env.BAO_SESSION_END_FAILURE_RECEIPT!, JSON.stringify({ entries, remainingPids }));
      }
    });
    f.library.updateSettings({ keepAgentBrowserOpen: true });
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    await c.close();
    assert.ok(pidsForDataDir(copy).length > 0);
    assert.fail("kept-copy-body-marker");
  });
} else {
  test("fixture teardown preserves body failures and reclaims kept copies", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bao-session-end-failure-"));
    try {
      const receipt = path.join(root, "body.json");
      const env: NodeJS.ProcessEnv = { ...laneChildEnv("hermetic", process.env),
        BAO_SESSION_END_FAILURE_PROBE: "1", BAO_SESSION_END_FAILURE_RECEIPT: receipt };
      delete env.NODE_TEST_CONTEXT;
      const result = await new Promise<{ code: number | string | null | undefined; output: string }>((resolve) => {
        execFile(process.execPath, ["--test", "--test-isolation=process", "--test-reporter=tap",
          "--test-name-pattern=^kept-copy failure probe$", __filename], { env, timeout: 90_000 }, (error, stdout, stderr) => {
          resolve({ code: error?.code, output: stdout + stderr });
        });
      });
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /kept-copy-body-marker/);
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { entries: [], remainingPids: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("retained-profile reclaim removes orphan renderers only for its exact profile", { timeout: 30_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-orphan-reclaim-"));
  const executable = path.join(root, "chrome-renderer.cjs");
  await writeFile(executable, "setInterval(() => {}, 1000); console.log('ready');");
  const children: { child: ReturnType<typeof spawn>; exited: Promise<void> }[] = [];
  t.after(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ exited }) => exited));
    await rm(root, { recursive: true, force: true });
  });
  const profile = path.join(root, "profile");
  const unrelated = path.join(root, "profile-other");
  for (const directory of [profile, profile, unrelated]) {
    const child = spawn(process.execPath, [executable, `--user-data-dir=${directory}`, "--type=renderer"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    children.push({ child, exited });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
      void exited.then(() => reject(new Error("fixture renderer exited before readiness")));
    });
  }
  assert.equal(pidsForDataDir(profile).length, 2);
  await closeRetainedChrome(profile);
  await Promise.all(children.slice(0, 2).map(({ exited }) => exited));
  assert.equal(pidsForDataDir(profile).length, 0);
  assert.equal(children[2]!.child.exitCode, null);
  assert.equal(children[2]!.child.signalCode, null, "a different profile is never signaled");
});

test("retained reclaim terminates its exact browser even when CDP acknowledges close without exiting", { timeout: 30_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-reclaim-ack-"));
  const profile = path.join(root, "chrome");
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true });
  t.after(async () => { await chrome.close(); await rm(root, { recursive: true, force: true }); });
  let acknowledged = false;
  t.mock.method(cdpSocket, "connectCdp", async () => ({
    async send(method: string) { assert.equal(method, "Browser.close"); acknowledged = true; return {}; },
    close() {},
  }));
  assert.ok(pidsForDataDir(profile).length);
  await closeRetainedChrome(profile);
  assert.equal(acknowledged, true);
  assert.equal(pidsForDataDir(profile).length, 0, "a close acknowledgement is not proof that Chrome exited");
});

for (const keepOpen of [false, true]) {
  test(`finish_task finalizes without close or disconnect, honors keep-open=${keepOpen}, and accepts another task`, { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    f.library.updateSettings({ keepAgentBrowserOpen: keepOpen, heal: "never" });
    const c = f.start();
    const initialized = await c.request("initialize") as Result & { instructions: string };
    assert.match(initialized.instructions, /finish_task.*before your final answer/);
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    const runId = f.library.listRuns()[0]!.id;
    assert.equal(f.library.readRun(runId).status, "recording");
    const result = await c.request("tools/call", { name: "finish_task", arguments: { outcome: "passed", reason: "Verified the task result." } });
    assert.equal(result.isError, false);
    const receipt = JSON.parse(result.content![0]!.text) as { run_id: string; status: string };
    assert.equal(receipt.run_id, runId);
    assert.equal(receipt.status, "passed");
    assert.equal(f.library.readRun(runId).status, "passed");
    if (keepOpen) assert.ok(pidsForDataDir(copy).length);
    else {
      assert.equal(pidsForDataDir(copy).length, 0);
      await assert.rejects(access(copy), /ENOENT/);
    }
    assert.equal((await c.request("tools/call", { name: "finish_task", arguments: { outcome: "passed", reason: "Already finished." } })).isError, false);
    assert.equal(f.library.listRuns().length, 1, "finishing again creates no empty run");
    assert.equal((await c.call("open")).isError, false, "the same MCP process accepts a new task");
    assert.notEqual(await f.copy(), copy);
    assert.equal(pidsForDataDir(copy).length, 0, "a new task reclaims a kept window");
    await c.close();
  });
}

test("finish_task after close records the checked outcome once", { timeout: 60_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const runId = f.library.listRuns()[0]!.id;
  assert.equal((await c.call("close")).isError, false);
  assert.equal(f.library.readRun(runId).status, "passed");
  assert.equal(f.library.readRun(runId).envelope, undefined);
  const result = await c.request("tools/call", { name: "finish_task", arguments: {
    outcome: "failed", reason: "The requested item was unavailable.",
  } });
  assert.equal(result.isError, false);
  const receipt = JSON.parse(result.content![0]!.text) as { run_id: string; status: string };
  assert.equal(receipt.run_id, runId);
  assert.equal(receipt.status, "failed");
  const saved = f.library.readRun(runId);
  assert.equal(saved.status, "failed");
  assert.equal(saved.envelope?.reason, "The requested item was unavailable.");
  await c.request("tools/call", { name: "finish_task", arguments: { outcome: "passed", reason: "A later claim" } });
  assert.deepEqual(f.library.readRun(runId), saved, "an explicit task outcome cannot be overwritten");
  assert.equal(f.library.listRuns().length, 1);
});

for (const outcome of ["failed-task", "failed-command", "owner-wait"] as const) {
  test(`finish_task records the checked outcome for ${outcome}`, { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    if (outcome === "failed-command") assert.equal((await c.call("fill", ["#missing", "Ada"])).isError, true);
    if (outcome === "owner-wait") {
      assert.equal((await c.call("wait_for_owner", ["1"])).isError, false);
      assert.equal(f.library.listRuns()[0]!.status, "needs_human", "waiting does not complete a task");
    }
    const copy = await f.copy();
    const invalid = await c.request("tools/call", { name: "finish_task", arguments: { outcome: "failed", reason: " " } });
    assert.equal(invalid.isError, true);
    assert.ok(pidsForDataDir(copy).length, "invalid finish leaves the session available");
    const result = await c.request("tools/call", { name: "finish_task", arguments: {
      outcome: outcome === "failed-task" ? "failed" : "passed", reason: "The requested item was unavailable.",
    } });
    assert.equal(result.isError, false);
    const run = f.library.listRuns()[0]!;
    assert.equal(run.status, outcome === "failed-command" ? "passed" : "failed");
    assert.ok(run.envelope?.reason, "every completion has a reason");
    if (outcome !== "owner-wait") assert.equal(run.envelope?.reason, "The requested item was unavailable.");
    if (outcome === "failed-command") {
      const steps = f.library.readRun(run.id).steps as unknown as { status: string }[];
      assert.ok(steps.some(step => step.status === "failed"), "recovered command errors remain in the receipt");
    }
    assert.equal(pidsForDataDir(copy).length, 0);
    assert.equal(f.library.list().workflows.length, 0, "failed tasks cannot save a replayable workflow");
  });
}

test("an untouched MCP client disconnect creates no recording run", { timeout: 30_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  await c.close();
  assert.deepEqual(f.library.listRuns(), []);
});

for (const ending of ["queued-eof", "active-signal"] as const) {
  test(`explicit close overrides keep-open during ${ending}`, { timeout: 60_000 }, async (t) => {
    const f = await fixture(ending === "queued-eof" ? "snapshot" : "close");
    t.after(() => f.close());
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
  });
}

for (const ending of ["agent-exit", "disconnect", "signal"] as const) {
  test(`${ending} closes the marked Chrome, removes its copy, finishes the run and allows another open`, { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
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
  });
}

for (const [signal, repeat] of [["SIGINT", false], ["SIGTERM", false], ["SIGHUP", false], ["SIGINT", true], ["SIGTERM", true]] as const) {
  for (const keepOpen of [false, true]) {
    test(`terminal group ${signal}${repeat ? " twice" : ""} respects keep-open=${keepOpen}`, { timeout: 60_000 }, async (t) => {
      const f = await fixture();
      t.after(() => f.close());
      f.library.updateSettings({ keepAgentBrowserOpen: keepOpen });
      const c = f.start(false, true);
      await c.request("initialize");
      assert.equal((await c.call("open")).isError, false);
      const copy = await f.copy();
      const groups = execFileSync("ps", ["-o", "pgid=", "-p", pidsForDataDir(copy).join(",")], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
      assert.equal(groups.includes(c.pid!), !keepOpen, "only keep-open at launch may detach Chrome from the MCP group");
      await c.interruptGroup(signal, repeat);
      if (keepOpen) {
        await delay(250);
        assert.ok(pidsForDataDir(copy).length > 0, "terminal signals must not reach a kept Chrome");
        const lease = JSON.parse(await readFile(path.join(copy, "lease.json"), "utf8")) as { retained?: boolean };
        assert.equal(lease.retained, true);
      } else {
        await until(() => pidsForDataDir(copy).length === 0);
        await assert.rejects(access(copy), /ENOENT/);
      }
      assert.equal(f.library.listRuns()[0]!.status, "passed");
    });
  }
}

test("a stopped MCP cleans up its proxy even while a catalog request is stuck", { timeout: 45_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let received!: () => void;
  const requested = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((req) => { req.resume(); received(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  saveState(f.home, { ...loadState(f.home), server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture" });
  try {
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    c.send("tools/call", { name: "search_workflows", arguments: {} });
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
  }
});

test("close near the stop deadline closes a retained window before a queued catalog call finishes", { timeout: 45_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
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
  saveState(f.home, { ...loadState(f.home), server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture" });
  try {
    f.library.updateSettings({ keepAgentBrowserOpen: true });
    const c = f.start();
    await c.request("initialize");
    assert.equal((await c.call("open")).isError, false);
    const copy = await f.copy();
    c.send("tools/call", { name: "search_workflows", arguments: {} });
    await requested;
    const stopped = c.stop();
    await until(async () => {
      const contents = await readFile(path.join(copy, "lease.json"), "utf8");
      try { return (JSON.parse(contents) as { retained?: unknown }).retained === true; }
      catch (error) {
        // keepOpen rewrites the lease while this assertion polls it.
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    });
    await delay(11_500);
    c.send("tools/call", { name: "agent_browser", arguments: { command: "close" } });
    await until(() => access(copy).then(() => false, () => true));
    assert.equal(pidsForDataDir(copy).length, 0);
    reply?.();
    await stopped;
  } finally {
    reply?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("keep-open finishes the run and the next session reclaims only that home's retained window", { timeout: 60_000 }, async (t) => {
  let other: Awaited<ReturnType<typeof fixture>> | undefined;
  const f = await fixture();
  t.after(async () => {
    const results = await Promise.allSettled([f.close(), other?.close()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, "Session fixture cleanup failed");
  });
  other = await fixture();
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
  const remaining = pidsForDataDir(copy);
  const commands = remaining.map((pid) => {
    try { return execFileSync("ps", ["-o", "pid=,ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim(); }
    catch { return `${pid} exited`; }
  });
  assert.equal(remaining.length, 0, `kept Chrome must exit before refresh: ${commands.join("; ")}`);
  await assert.rejects(access(copy), /ENOENT/);
  assert.notEqual(await f.copy(), copy);
  assert.ok(pidsForDataDir(unrelatedCopy).length, "another Bao home stays open");
  const freshCopy = await f.copy();
  assert.equal((await next.call("close")).isError, false, "explicit close overrides keep-open");
  assert.equal((await next.call("close")).isError, false, "explicit close is idempotent");
  await assert.rejects(access(freshCopy), /ENOENT/);
  await next.close();
});
