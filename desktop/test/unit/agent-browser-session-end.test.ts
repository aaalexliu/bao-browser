import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { closeRetainedChrome, launchOwnedChrome, launchOwnedChromeEndpoint, pinTestBrowser, pidsForDataDir } from "../../src/launch";
import * as cdpSocket from "../../src/cdp-live/socket";
import { Library } from "../../src/v1/store";
import { loadState, saveState } from "../../src/v1/sync";
import { laneChildEnv } from "../runtime";
import { LIST_TARGETS } from "../support/fake-agent-browser";

const cli = path.resolve(__dirname, "../../src/app/cli.js");
/** The fixture opens browser=copy and its Chrome has only the Default profile. */
const COPY_DEFAULT = 'Browser: Chrome copy, Chrome profile "Default".';
/** Navigates and clicks through Chrome's debugging port, so a fake native can still leave a replayable capture. */
const DRIVE_PAGE = `const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (socket) => {
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  return (method, params, sessionId) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    socket.send(JSON.stringify({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};
const withPage = async (wsUrl, body) => {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });
  const send = call(socket);
  try {
    const { targetInfos } = await send("Target.getTargets");
    const page = targetInfos.find((target) => target.type === "page" && !String(target.url).startsWith("chrome://"));
    if (!page) throw new Error("no page target");
    const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    return await body(send, sessionId);
  } finally { socket.close(); }
};
const drive = async (args) => {
  const wsUrl = args[args.indexOf("--cdp") + 1];
  const at = args.indexOf("--idle-timeout");
  const command = args[at + 2];
  const commandArgs = args.slice(at + 3);
  if (command === "open") {
    const url = commandArgs[0];
    if (!url) throw new Error("open needs a url");
    const navigated = await withPage(wsUrl, (send, sessionId) => send("Page.navigate", { url }, sessionId));
    if (navigated.errorText) throw new Error(navigated.errorText);
    return;
  }
  if (command === "click") {
    const selector = commandArgs[0];
    await withPage(wsUrl, async (send, sessionId) => {
      const box = await send("Runtime.evaluate", {
        expression: "(() => { const el = document.querySelector(" + JSON.stringify(selector) + "); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()",
        returnByValue: true,
      }, sessionId);
      const point = box.result && box.result.value;
      if (!point || point.w <= 0 || point.h <= 0) throw new Error("click target missing");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
    });
    await wait(500);
  }
};
module.exports = { drive };
`;
interface Result { isError?: boolean; content?: { text: string }[]; structuredContent?: Record<string, unknown> }

async function until(read: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await read()) return; await delay(50); }
  throw new Error("session cleanup timed out");
}

async function fixture(blockCommand?: "snapshot" | "close", drivePage = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-session-end-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  const teardown = path.join(root, "teardown");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!fs.existsSync(${JSON.stringify(teardown)}) && args.includes(${JSON.stringify(blockCommand)})) {
  fs.writeFileSync(${JSON.stringify(path.join(root, "native-pending"))}, 'ready');
  setInterval(() => {}, 1000);
} else if (args.includes('fill')) {
  console.error('fixture field missing'); process.exitCode = 7;
} else if (args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  const listed = (left) => listTargets(endpoint.href).then((tabs) => {
    process.stdout.write(JSON.stringify({ data: { tabs: tabs.filter(t => t.type === 'page').map(t => ({ active: true, targetId: t.id })) } }));
  }, (error) => {
    if (left > 1) return new Promise((resolve) => setTimeout(resolve, 50)).then(() => listed(left - 1));
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
  listed(4);
} else if (args.includes('snapshot') && fs.existsSync(${JSON.stringify(path.join(root, "page.txt"))})) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(root, "page.txt"))}, 'utf8'));
}${drivePage ? ` else if (args.includes('open') || args.includes('click')) {
  const { drive } = require(${JSON.stringify(path.join(root, "drive-page.js"))});
  drive(args).then(() => { process.stdout.write('native success\\n'); process.exit(0); }, (error) => {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  });
}` : ""} else process.stdout.write('native success\\n');
`, { mode: 0o700 });
  if (drivePage) await writeFile(path.join(root, "drive-page.js"), DRIVE_PAGE);
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
  // Like an agent, the client sends back the run id from its latest agent_browser result.
  let run: string | undefined;
  return {
    request, send, pid: child.pid, diagnostics: () => stderr, get run() { return run; },
    async call(command: string, args: string[] = [], extra: Record<string, unknown> = {}) {
      const result = await request("tools/call", { name: "agent_browser", arguments: { command, args, ...(command === "open" ? { browser: "copy" } : {}),
        ...(run ? { run_id: run } : {}), ...extra } });
      const structuredRun = result.structuredContent?.run_id;
      const named = typeof structuredRun === "string" && structuredRun ? structuredRun
        : result.content?.map((block) => /^Run (\S+)(?: · \w+)?$/.exec(block.text ?? "")?.[1]).find(Boolean);
      if (named) run = named;
      return result;
    },
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

test("a failed finish does not save a replayable task or repeat the agent's reason", { timeout: 60_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-failed-save-"));
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  await mkdir(home, { recursive: true });
  const server = createServer((_req, res) => {
    res.end("<!doctype html><title>Grocery</title><button data-testid=\"chosen\">Add blueberries</button>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const url = `http://127.0.0.1:${address.port}/`;
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  t.after(async () => {
    await context.close();
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = context.pages()[0] ?? await context.newPage();
  const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
  const session = await context.newCDPSession(page);
  const info = await session.send("Target.getTargetInfo") as { targetInfo: { targetId: string } };
  await session.detach();
  const workflow = new AgentBrowserWorkflow(home, "run-failed-save", async () => ({
    ...endpoint, targetId: info.targetInfo.targetId, targetIds: [info.targetInfo.targetId],
  }));
  const success = { stdout: "", stderr: "", exitCode: 0 };
  await workflow.record("open", [url], "open", async () => {
    await page.goto(url);
    return success;
  }, () => false);
  await workflow.record("click", ['[data-testid="chosen"]'], "click", async () => {
    await page.locator('[data-testid="chosen"]').click();
    return success;
  }, () => false);
  assert.equal(workflow.finish(true), "Not saved as a workflow: the task failed.");
  assert.equal(new Library(home).list().workflows.length, 0);
});

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

test("owned shutdown waits for exact-profile orphan processes to exit", { timeout: 30_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-shutdown-orphan-"));
  const profile = path.join(root, "chrome");
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true });
  const orphan = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`, "--type=renderer"], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>(resolve => orphan.once("exit", () => resolve()));
  const kill = process.kill.bind(process);
  let signalTimer: ReturnType<typeof setTimeout> | undefined;
  t.after(async () => {
    clearTimeout(signalTimer);
    t.mock.restoreAll();
    if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill("SIGKILL");
    await exited;
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    orphan.stdout!.once("data", () => resolve());
    orphan.once("error", reject);
    void exited.then(() => reject(new Error("orphan exited before readiness")));
  });
  let signaled = false;
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === orphan.pid && signal === "SIGKILL") {
      signaled = true;
      // Model a signal that the OS accepts before the process has exited.
      signalTimer = setTimeout(() => kill(pid, signal), 500);
      return true;
    }
    return kill(pid, signal);
  });
  await chrome.close();
  assert.equal(signaled, true, "shutdown must reclaim the orphan");
  assert.equal(pidsForDataDir(profile).length, 0, "close must await process exit, not just signal delivery");
});

test("owned shutdown terminates a stalled exact-profile browser before returning", { timeout: 30_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-shutdown-stalled-"));
  const profile = path.join(root, "chrome");
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true });
  t.after(async () => {
    for (const pid of pidsForDataDir(profile)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await until(() => pidsForDataDir(profile).length === 0);
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  });
  const pids = pidsForDataDir(profile);
  assert.ok(pids.length);
  for (const pid of pids) process.kill(pid, "SIGSTOP");
  await chrome.close();
  assert.equal(pidsForDataDir(profile).length, 0, "close must not succeed while its owned browser is still alive");
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

test("retained reclaim terminates a stalled exact-profile browser before returning", { timeout: 30_000 }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-reclaim-stalled-"));
  const profile = path.join(root, "chrome");
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true });
  t.after(async () => {
    for (const pid of pidsForDataDir(profile)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await until(() => pidsForDataDir(profile).length === 0);
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(cdpSocket, "connectCdp", async () => ({
    async send() { return {}; },
    close() {},
  }));
  const pids = pidsForDataDir(profile);
  assert.ok(pids.length);
  for (const pid of pids) process.kill(pid, "SIGSTOP");
  await closeRetainedChrome(profile);
  assert.equal(pidsForDataDir(profile).length, 0, "reclaim must not succeed while its retained browser is still alive");
});

for (const keepOpen of [false, true]) {
  test(`finish_task finalizes without close or disconnect, honors keep-open=${keepOpen}, and accepts another task`, { timeout: 60_000 }, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    f.library.updateSettings({ keepAgentBrowserOpen: keepOpen, heal: "never" });
    const c = f.start();
    const initialized = await c.request("initialize") as Result & { instructions: string };
    assert.match(initialized.instructions, /finish_task.*before your final answer/);
    const opened = await c.call("open");
    assert.equal(opened.isError, false);
    const copy = await f.copy();
    const runId = f.library.listRuns()[0]!.id;
    assert.equal(opened.content![1]!.text, `Run ${runId}`, "every text result names its run after the sentence");
    assert.equal(c.run, runId);
    assert.equal(f.library.readRun(runId).status, "recording");
    const result = await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run, outcome: "passed", reason: "Verified the task result." } });
    assert.equal(result.isError, false);
    assert.match(result.content![0]!.text, /^Passed: Verified the task result\. \d+ steps? in \d+ s\.$/);
    const receipt = result.structuredContent as { summary: string; workflow: string; run_id: string; status: string; browser: string[] };
    assert.match(receipt.workflow, /^Not saved as a workflow: /);
    assert.deepEqual(receipt.browser, [COPY_DEFAULT]);
    assert.deepEqual(result.content!.map((block) => block.text), [receipt.summary, `Run ${runId} · passed · bao://receipt/${runId}`, receipt.workflow, COPY_DEFAULT],
      "text clients get words only, with the run id to continue and the browser Bao used");
    assert.equal(receipt.run_id, runId);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.summary, result.content![0]!.text);
    assert.equal("receipts" in receipt, false, "the model receipt omits each step's native output");
    const saved = JSON.parse((await c.request("tools/call", { name: "get_run", arguments: { run_id: runId } })).content![0]!.text) as { receipts: { native?: unknown }[] };
    assert.ok(saved.receipts.some((step) => step.native), "get_run still returns the saved receipt");
    assert.equal(f.library.readRun(runId).status, "passed");
    if (keepOpen) assert.ok(pidsForDataDir(copy).length);
    else {
      assert.equal(pidsForDataDir(copy).length, 0);
      await assert.rejects(access(copy), /ENOENT/);
    }
    assert.equal((await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run, outcome: "passed", reason: "Already finished." } })).isError, false);
    assert.equal(f.library.listRuns().length, 1, "finishing again creates no empty run");
    assert.equal((await c.call("open")).isError, false, "the same MCP process accepts a new task");
    assert.notEqual(await f.copy(), copy);
    assert.equal(pidsForDataDir(copy).length, 0, "a new task reclaims a kept window");
    await c.close();
  });
}

test("finish_task after a completed close leaves the prior task unchanged", { timeout: 60_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const runId = f.library.listRuns()[0]!.id;
  assert.equal((await c.call("close")).isError, false);
  const saved = f.library.readRun(runId);
  assert.equal(saved.status, "passed");
  assert.equal(saved.envelope, undefined);
  const result = await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run,
    outcome: "failed", reason: "The requested item was unavailable.",
  } });
  assert.equal(result.isError, false);
  assert.equal(result.content![0]!.text, "No browser task is open.");
  assert.equal(result.content!.length, 1);
  const receipt = result.structuredContent as { outcome: string; run_id?: string };
  assert.equal(receipt.outcome, "no_session");
  assert.equal(receipt.run_id, undefined);
  assert.deepEqual(f.library.readRun(runId), saved, "a later task cannot relabel a fully removed session");
  await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run, outcome: "passed", reason: "A later claim" } });
  assert.deepEqual(f.library.readRun(runId), saved, "repeated finishes leave the prior task unchanged");
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
      const waiting = await c.call("wait_for_owner", ["1"]);
      assert.equal(waiting.isError, false);
      const reply = waiting.structuredContent as { summary: string; outcome: string; instruction: string; browser: string[] };
      assert.equal(reply.outcome, "waiting");
      assert.deepEqual(reply.browser, [COPY_DEFAULT]);
      assert.deepEqual(waiting.content!.map((block) => block.text), [reply.summary, `Run ${f.library.listRuns()[0]!.id} · waiting`, reply.instruction, COPY_DEFAULT],
        "text clients get words, the run id, and the browser Bao used, not the reply's JSON");
      assert.equal(f.library.listRuns()[0]!.status, "needs_human", "waiting does not complete a task");
    }
    const copy = await f.copy();
    const invalid = await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run, outcome: "failed", reason: " " } });
    assert.equal(invalid.isError, true);
    assert.ok(pidsForDataDir(copy).length, "invalid finish leaves the session available");
    const result = await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run,
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
    assert.equal(pidsForDataDir(copy).length, 0, c.diagnostics());
    assert.equal(f.library.list().workflows.length, 0, "failed tasks cannot save a replayable workflow");
    if (outcome === "failed-task") {
      const texts = result.content!.map((block) => block.text);
      const workflow = texts.find((text) => text.startsWith("Not saved as a workflow:"));
      assert.equal(texts.filter((text) => text.includes("The requested item was unavailable")).length, 1, texts.join("\n"));
      assert.equal(workflow, "Not saved as a workflow: command-1 (open): open options cannot be replayed.");
      assert.equal(workflow.includes("The requested item was unavailable"), false);
      assert.equal(workflow.endsWith(".."), false);
      const receipt = result.structuredContent as { reason?: string; workflow?: string; summary?: string };
      assert.equal(receipt.reason, "The requested item was unavailable.");
      assert.equal(receipt.workflow, workflow);
      assert.match(receipt.summary ?? "", /^Failed: The requested item was unavailable\. /);
    }
  });
}

test("a failed finish_task on a saveable open and click says the task failed, once", { timeout: 90_000 }, async (t) => {
  const server = createServer((_req, res) => {
    res.end("<!doctype html><title>Grocery</title><button data-testid=\"chosen\">Add blueberries</button>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  const url = `http://127.0.0.1:${address.port}/`;
  const f = await fixture(undefined, true);
  t.after(async () => {
    try { await f.close(); }
    finally { server.close(); }
  });
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open", [url])).isError, false, c.diagnostics());
  assert.equal((await c.call("click", ['[data-testid="chosen"]'])).isError, false, c.diagnostics());
  const reason = "The page may be a sign-in.";
  const result = await c.request("tools/call", { name: "finish_task", arguments: { run_id: c.run, outcome: "failed", reason } });
  assert.equal(result.isError, false, c.diagnostics());
  const texts = result.content!.map((block) => block.text);
  const workflow = texts.find((text) => text.startsWith("Not saved as a workflow:"));
  assert.equal(workflow, "Not saved as a workflow: the task failed.", "a saveable task must not repeat the agent's reason or end in '..'");
  assert.equal(texts.filter((text) => text.includes(reason)).length, 1, texts.join("\n"));
  assert.match(texts[0] ?? "", /^Failed: The page may be a sign-in\. /);
  const receipt = result.structuredContent as { workflow?: string; reason?: string };
  assert.equal(receipt.workflow, workflow);
  assert.equal(receipt.reason, reason);
  assert.equal(f.library.list().workflows.length, 0);
});

test("a failed open from another chat does not name the run it ended", { timeout: 60_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const ended = c.run!;
  const failed = await c.request("tools/call", { name: "agent_browser", arguments: { command: "open", args: ["http://127.0.0.1/"], browser: "copy", profile: "Profile 9" } });
  assert.equal(failed.isError, true);
  const text = failed.content!.map((block) => block.text).join("\n");
  assert.match(text, /Chrome has no profile "Profile 9"/);
  assert.equal(text.includes(ended), false, text);
  assert.equal(f.library.listRuns().some((run) => run.status === "recording"), false);
});

test("finish_task for a run a newer task ended stays closed while that session is open", { timeout: 90_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const older = c.run!;
  const opened = await c.request("tools/call", { name: "agent_browser", arguments: { command: "open", browser: "copy", args: ["http://127.0.0.1/"] } });
  assert.equal(opened.isError, false, JSON.stringify(opened));
  const newer = opened.content!.map((block) => /^Run (\S+)/.exec(block.text)?.[1]).find(Boolean)!;
  assert.notEqual(newer, older);
  const saved = f.library.readRun(newer);
  const closed = `This run's browser session ended and cannot continue. Report that to the owner. Run ${older} is not Bao's open browser session. The browser now belongs to another task, so stop here.`;
  const late = await c.request("tools/call", { name: "finish_task", arguments: { outcome: "failed", reason: "older chat", run_id: older } });
  assert.equal(late.isError, false);
  assert.deepEqual(late.content!.map((block) => block.text), [closed]);
  assert.equal((late.structuredContent as { outcome: string; reason: string }).outcome, "no_session");
  assert.equal((late.structuredContent as { reason: string }).reason, closed);
  assert.deepEqual(f.library.readRun(newer), saved, "the newer session's run stays");
  assert.equal(f.library.listRuns().find((run) => run.id === newer)?.status, "recording");
  const still = await c.request("tools/call", { name: "agent_browser", arguments: { command: "snapshot", args: [], run_id: newer } });
  assert.equal(still.isError, false, JSON.stringify(still));
  assert.equal(still.content!.some((block) => block.text === `Run ${newer}`), true, JSON.stringify(still.content));
  assert.equal(still.content!.some((block) => block.text.includes(older)), false);
});

test("after the newer task finishes, the older chat's named commands stay closed", { timeout: 90_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const older = c.run!;
  const opened = await c.request("tools/call", { name: "agent_browser", arguments: { command: "open", browser: "copy", args: ["http://127.0.0.1/"] } });
  assert.equal(opened.isError, false, JSON.stringify(opened));
  const newer = opened.content!.map((block) => /^Run (\S+)/.exec(block.text)?.[1]).find(Boolean)!;
  assert.notEqual(newer, older);
  const finished = await c.request("tools/call", { name: "finish_task", arguments: { run_id: newer, outcome: "passed", reason: "Chat B finished." } });
  assert.equal(finished.isError, false);
  const workflow = (finished.structuredContent as { workflow?: string }).workflow;
  assert.match(workflow ?? "", /^(Saved workflow: |Not saved as a workflow: )/);
  const closed = `This run's browser session ended and cannot continue. Report that to the owner. Run ${older} is not Bao's open browser session. The browser now belongs to another task, so stop here.`;
  const runs = f.library.listRuns().length;
  for (const arguments_ of [
    { command: "snapshot", args: [], run_id: older },
    { command: "click", args: ["@e1"], run_id: older },
    { command: "open", args: ["http://127.0.0.1/again"], browser: "copy", run_id: older },
    { command: "wait_for_owner", args: ["40"], run_id: older },
    { command: "close", run_id: older },
  ]) {
    const result = await c.request("tools/call", { name: "agent_browser", arguments: arguments_ });
    assert.equal(result.isError, false, JSON.stringify(result));
    const reply = result.structuredContent as { outcome?: string; instruction?: string; run_id?: string };
    assert.equal(reply.outcome, "closed", arguments_.command);
    assert.equal(reply.instruction, closed, arguments_.command);
    assert.equal(reply.run_id, older);
    const sentence = arguments_.command === "wait_for_owner" ? "This wait ended. This session cannot continue." : "This run ended. This session cannot continue.";
    assert.deepEqual(result.content!.map((block) => block.text), [sentence, `Run ${older} · closed`, closed], arguments_.command);
    assert.equal(result.content!.some((block) => block.text === workflow || block.text.includes(newer)), false);
  }
  const late = await c.request("tools/call", { name: "finish_task", arguments: { outcome: "failed", reason: "older chat", run_id: older } });
  assert.equal(late.isError, false);
  assert.deepEqual(late.content!.map((block) => block.text), [closed]);
  assert.equal((late.structuredContent as { outcome: string }).outcome, "no_session");
  assert.equal(f.library.listRuns().length, runs);
  const fresh = await c.request("tools/call", { name: "agent_browser", arguments: { command: "open", browser: "copy" } });
  assert.equal(fresh.isError, false, JSON.stringify(fresh));
  const started = fresh.content!.map((block) => /^Run (\S+)/.exec(block.text)?.[1]).find(Boolean);
  assert.ok(started && started !== older);
});

test("a wait_for_owner, close, or finish_task whose run_id is not the open session names that run and leaves the open session alone", { timeout: 60_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = f.start();
  await c.request("initialize");
  assert.equal((await c.call("open")).isError, false);
  const open = f.library.listRuns()[0]!;
  const late = await c.request("tools/call", { name: "agent_browser", arguments: { command: "wait_for_owner", args: ["1"], run_id: "run-ended-chat" } });
  assert.equal(late.isError, false);
  const reply = late.structuredContent as { summary: string; outcome: string; instruction: string; browser?: string[]; run_id?: string };
  assert.equal(reply.outcome, "closed");
  assert.equal(reply.summary, "This wait ended. This session cannot continue.");
  const ended = "This run's browser session ended and cannot continue. Report that to the owner. Run run-ended-chat is not Bao's open browser session. The browser now belongs to another task, so stop here.";
  assert.equal(reply.instruction, ended);
  assert.equal(reply.browser, undefined, "the result does not name the open session's browser");
  assert.equal(reply.run_id, "run-ended-chat");
  assert.deepEqual(late.content!.map((block) => block.text), [reply.summary, "Run run-ended-chat · closed", reply.instruction]);
  const close = await c.request("tools/call", { name: "agent_browser", arguments: { command: "close", run_id: "run-ended-chat" } });
  assert.deepEqual(close.content!.map((block) => block.text), ["This run ended. This session cannot continue.", "Run run-ended-chat · closed", ended]);
  const finish = await c.request("tools/call", { name: "finish_task", arguments: { outcome: "failed", reason: "Gave up.", run_id: "run-ended-chat" } });
  assert.equal(finish.isError, false);
  assert.deepEqual(finish.content!.map((block) => block.text), ["Run run-ended-chat is not Bao's open browser session, so finish_task changed nothing."]);
  assert.equal((finish.structuredContent as { outcome: string }).outcome, "no_session");
  for (const [name, args] of [["agent_browser", { command: "wait_for_owner", args: ["1"] }], ["agent_browser", { command: "close" }], ["finish_task", { outcome: "failed", reason: "Gave up." }]] as const) {
    const missing = await c.request("tools/call", { name, arguments: args });
    assert.equal(missing.isError, true);
    const text = missing.content!.map((block) => block.text).join("\n");
    assert.match(text, /^run_id is required on (wait_for_owner|close|finish_task) while a browser session is open\./);
    assert.doesNotMatch(text, new RegExp(open.id), "the refusal does not name the open session's run");
  }
  assert.deepEqual(f.library.readRun(open.id), open, "the open session's run records nothing");
  assert.equal((await c.call("snapshot")).isError, false, "the open session continues");
  await c.close();
});

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
    const opened = await c.call("open");
    const openedText = opened.content?.map((block) => block.text).join("\n") ?? "";
    assert.equal(opened.isError, false, [openedText, c.diagnostics()].filter(Boolean).join("\n"));
    const copy = await f.copy();
    c.send("tools/call", { name: "agent_browser", arguments: { command: ending === "queued-eof" ? "snapshot" : "close", run_id: c.run } });
    await f.pending();
    if (ending === "queued-eof") {
      c.send("tools/call", { name: "agent_browser", arguments: { command: "close", run_id: c.run } });
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
    c.send("tools/call", { name: "agent_browser", arguments: { command: "close", run_id: c.run } });
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

test("MCP find and diff reach the agent result, and finish_task keeps the owner card while shortening the model receipt", { timeout: 60_000 }, async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const page = "- banner\n  - button \"Open search\" [ref=e1]\n- main\n  - link \"Repo 0\" [ref=e10]\n";
  const next = page.replace("Repo 0", "Repo 1");
  await writeFile(path.join(f.home, "..", "page.txt"), page);
  const c = f.start();
  await c.request("initialize", { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } });
  assert.equal((await c.call("open", ["http://127.0.0.1/"])).isError, false);
  const rejected = await c.call("click", ["@e1"], { find: { text: "x" } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content?.map((block) => block.text).join("\n") ?? "", /only accepted on snapshot/);
  const found = await c.call("snapshot", [], { find: { text: "search", role: "button" } });
  assert.equal(found.isError, false);
  const foundText = found.content?.map((block) => block.text).join("\n") ?? "";
  assert.match(foundText, /1 of 4 snapshot lines match text "search" and role button/);
  assert.match(foundText, /button "Open search"/);
  assert.doesNotMatch(foundText, /Repo 0/, "find does not return the rest of the native tree");
  await writeFile(path.join(f.home, "..", "page.txt"), next);
  const changed = await c.call("snapshot", [], { diff: true });
  const changedText = changed.content?.map((block) => block.text).join("\n") ?? "";
  assert.match(changedText, /1 line added \(\+\), 1 removed/);
  assert.match(changedText, /\+ .*Repo 1/);
  assert.doesNotMatch(changedText, /Open search/, "unchanged lines that do not hold the change stay out");
  const runId = c.run!;
  const recorded = f.library.readRun(runId).steps as { native?: { command?: string; results?: { stdout: string }[] } }[];
  assert.equal(recorded.filter((step) => step.native?.command === "snapshot").at(-1)?.native?.results?.[0]?.stdout, next, "the run keeps the full native tree");
  const finished = await c.request("tools/call", { name: "finish_task", arguments: { run_id: runId, outcome: "passed", reason: "Verified the task result." } }) as Result & {
    _meta?: { baoToolCard?: { style: string; caption: string; finish?: { steps: number; reason: string } } };
  };
  assert.equal(finished.isError, false);
  assert.equal(finished._meta?.baoToolCard?.style, "finish");
  assert.equal(finished._meta?.baoToolCard?.caption, finished.content![0]!.text);
  assert.equal(finished._meta?.baoToolCard?.finish?.reason, "Verified the task result.");
  assert.equal(finished.structuredContent?.summary, finished.content![0]!.text);
  assert.equal("receipts" in (finished.structuredContent ?? {}), false);
  assert.equal(JSON.stringify(finished.structuredContent).includes("Repo 1"), false, "the model receipt does not repeat native output");
  const full = JSON.parse((await c.request("tools/call", { name: "get_run", arguments: { run_id: runId } })).content![0]!.text) as { receipts: { native?: { results: { stdout: string }[] } }[] };
  assert.equal(full.receipts.some((step) => step.native?.results.some((result) => result.stdout.includes("Repo 1"))), true, "get_run still returns the saved native output");
});
