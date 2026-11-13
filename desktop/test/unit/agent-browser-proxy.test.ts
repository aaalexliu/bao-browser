import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { ChromeProfileQuestion } from "../../src/engines/browser-pick";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import * as runningChrome from "../../src/extension/running-chrome";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";
import { trapPort } from "../support/trap-port";
import * as profiles from "../../src/engines/chrome-profile-copy";
import * as sockets from "../../src/cdp-live/socket";
import { describeStep } from "../../src/engines/agent-browser-describe";
import { pageShotLine, textToolResult } from "../../src/mcp/tool-card";
import { Library } from "../../src/v1/store";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { scaledMs } from "../runtime";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");

function followSend(t: TestContext, cdp: sockets.CdpSocket): void {
  t.mock.method(cdp, "sendUntilProgress", (method: string, params?: Record<string, unknown>, sessionId?: string) => cdp.send(method, params ?? {}, sessionId));
}

async function fixture(t: TestContext, keepOpen = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-test-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Profile 2", "Preferences"), "{}");
  let copiedDir = "";
  let closeWindow = () => {};
  let closeCount = 0;
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    copiedDir = copy.userDataDir;
    const portFile = path.join(copiedDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/proxy-test\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    let gone = false;
    closeWindow = () => { gone = true; closedWindow(); };
    const close = async () => { closeCount++; closeWindow(); await copy.close(); };
    return { target: { kind: "bao" as const, portFile }, closed, bytes: copy.bytes, copyMs: copy.copyMs, close,
      isClosed: () => gone, keepOpen: () => copy.keepOpen() };
  });
  const targetReads: unknown[] = [];
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string, params?: Record<string, unknown>) => {
      if (method === "Target.getTargetInfo") {
        targetReads.push(params?.targetId);
        return { targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } };
      }
      return method === "Target.attachToTarget" ? { sessionId: "fixture" } : { data: png.toString("base64") };
    });
    followSend(t, cdp);
    return cdp;
  });
  const executable = path.join(root, "native");
  const log = path.join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, env: process.env}) + '\\n');
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'snapshot' && fs.existsSync(${JSON.stringify(path.join(root, "hold-snapshot"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
if (args.includes('hang') || args.includes('daemon-fail')) {
  const daemon = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  daemon.unref();
  fs.writeFileSync(process.env.AGENT_BROWSER_SOCKET_DIR + '/bao.pid', String(daemon.pid));
  fs.writeFileSync(${JSON.stringify(path.join(root, "daemon.pid"))}, String(daemon.pid));
}
if (args.includes('hang')) {
  fs.writeFileSync(${JSON.stringify(path.join(root, "command.pid"))}, String(process.pid));
  setInterval(() => {}, 1000);
}
else if (args.includes('wait')) {
  fs.writeFileSync(${JSON.stringify(path.join(root, "command.pid"))}, String(process.pid));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(path.join(root, "continue"))})) return;
    clearInterval(timer);
    process.stdout.write(command + ' unchanged\\n');
  }, 10);
}
else if (args.includes('fail') || args.includes('daemon-fail')) { process.stdout.write('native failure output\\n'); process.stderr.write('native error\\n'); process.exitCode = 1; }
else if (command === 'download') { fs.writeFileSync(args.at(-1), '%PDF-1.4 fixture'); process.stdout.write('\u2713 Download saved to ' + fs.realpathSync(args.at(-1)) + '\\n'); }
else if (command === 'upload' && !args.slice(args.indexOf('upload') + 2).every((file) => fs.existsSync(file))) { process.stderr.write('\u2717 File not found: ' + args.at(-1) + '\\n'); process.exitCode = 1; }
else if (command === 'snapshot' && fs.existsSync(${JSON.stringify(path.join(root, "page.txt"))})) process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(root, "page.txt"))}, 'utf8'));
else if (command === 'tab' && args.includes('--json') && fs.existsSync(${JSON.stringify(path.join(root, "tab-result.json"))})) {
  const result = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "tab-result.json"))}, 'utf8'));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
else if (command === 'tab' && args.includes('--json')) process.stdout.write(JSON.stringify({data:{tabs:fs.existsSync(${JSON.stringify(path.join(root, "no-active"))})?[]:[{active:true,targetId:'ABC123'}]}}));
else process.stdout.write(command === 'tab' ? 't1 Synthetic - http://127.0.0.1/\\n' : command + ' unchanged\\n');
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable, keepOpen: () => keepOpen });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return {
    root, sourceRoot, proxy, calls, targetReads, copy: () => copiedDir, closeWindow: () => closeWindow(), closeCount: () => closeCount,
    async close() {
      try { await proxy.close(); }
      finally {
        for (const file of ["daemon.pid", "command.pid"]) {
          const pid = Number(await readFile(path.join(root, file), "utf8").catch(() => "0"));
          if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

for (const scenario of [
  { name: "native failure", stdout: "native output", stderr: "native error", exitCode: 2, error: /Native tab list failed \(exit 2\): native error/ },
  { name: "invalid JSON", stdout: "not JSON", error: /Unexpected token/ },
  { name: "null output", stdout: "null", error: /Cannot read properties of null \(reading 'data'\)/ },
  { name: "missing data", stdout: "{}", error: /no active Bao page metadata/ },
  { name: "non-array tabs", stdout: '{"data":{"tabs":{}}}', error: /tabs.find is not a function/ },
  { name: "no active tab", stdout: '{"data":{"tabs":[{"targetId":"OTHER"}]}}', error: /no active Bao page metadata/ },
  { name: "active tab without ID", stdout: '{"data":{"tabs":[{"active":true},{"active":true,"targetId":"ABC123"}]}}', error: /no active Bao page metadata/ },
  { name: "multiple rows", stdout: '{"data":{"tabs":[{"targetId":"OTHER"},{"active":true,"targetId":"ABC123"},{"active":true,"targetId":"LAST"}]}}' },
]) test(`native tab output preserves ${scenario.name}`, { timeout: scaledMs(5000) }, async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    await writeFile(path.join(f.root, "tab-result.json"), JSON.stringify({ stdout: scenario.stdout, stderr: scenario.stderr ?? "", exitCode: scenario.exitCode ?? 0 }));
    f.targetReads.length = 0;
    const command = f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId);
    if (scenario.error) await assert.rejects(command, scenario.error);
    else {
      assert.equal((await command)[0]?.stdout, "snapshot unchanged\n");
      assert.ok(f.targetReads.length > 0);
      assert.deepEqual([...new Set(f.targetReads)], ["ABC123"]);
    }
  } finally { await f.close(); }
});

for (const ending of ["no-active", "missing-target", "disconnect", "abort-send", "dead-socket", "delayed-shutdown", "explicit-close"]) test(`owner wait handles ${ending} without leaving an active prompt`, { timeout: scaledMs(4000) }, async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    if (ending === "no-active") await writeFile(path.join(f.root, "no-active"), "");
    else {
      t.mock.method(sockets, "connectCdp", async () => {
        const cdp = new sockets.CdpSocket(new Socket());
        t.mock.method(cdp, "send", async (method: string) => {
          const page = { targetId: "ABC123", url: "http://127.0.0.1/login", title: "Sign in" };
          if (method === "Target.getTargetInfo") return { targetInfo: page };
          if (method === "Target.attachToTarget") return { sessionId: "fixture" };
          if (method === "Target.getTargets") {
            if (ending === "delayed-shutdown") {
              setTimeout(f.closeWindow, 500);
              throw new Error("CDP disconnected during shutdown");
            }
            if (ending === "missing-target") return { targetInfos: [] };
            if (ending === "dead-socket") {
              cdp.close();
              throw new Error("browser socket closed before launcher cleanup");
            }
            if (ending === "abort-send") {
              setTimeout(() => f.proxy.disconnect(), 10);
              return cdp.disconnected.then(() => { throw new Error("CDP aborted"); });
            }
            if (ending === "disconnect") setTimeout(() => f.proxy.disconnect(), 10);
            return { targetInfos: [page] };
          }
          return {};
        });
        followSend(t, cdp);
        return cdp;
      });
      await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId);
    }
    const result = await f.proxy.execute("wait_for_owner", [ending === "explicit-close" ? "1" : "5000"], undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.equal((JSON.parse(result[0]!.stdout) as { outcome: string }).outcome, ending === "explicit-close" ? "waiting" : "closed");
    if (ending === "explicit-close") await f.proxy.close();
    const library = new Library(path.join(f.root, "home"));
    const saved = library.listRuns()[0]!;
    assert.equal(saved.status, "failed");
    assert.equal(saved.envelope?.status, "failed");
    assert.equal(saved.envelope?.reason, "session_closed");
    if (["no-active", "missing-target", "dead-socket"].includes(ending)) {
      const calls = await f.calls();
      for (const command of ["snapshot", "screenshot", "fill", "press", "scroll", "click", "tab", "open", "wait_for_owner"]) {
        const next = await f.proxy.execute(command, [], undefined, false, undefined, {}, saved.id);
        assert.equal((JSON.parse(next[0]!.stdout) as { outcome: string }).outcome, "closed");
      }
      assert.deepEqual(await f.calls(), calls);
      assert.deepEqual(library.readRun(saved.id), saved);
      await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId);
      assert.deepEqual(library.readRun(saved.id), saved);
    }
  } finally { await f.close(); }
});

for (const failure of ["connect", "metadata", "poll"]) test(`owner wait keeps its handoff through a live ${failure} error until the deadline`, { timeout: scaledMs(4000) }, async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    t.mock.method(sockets, "connectCdp", async () => {
      if (failure === "connect") throw new Error("temporary connection failure");
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        if (method === "Target.getTargetInfo") {
          if (failure === "metadata") throw new Error("temporary metadata failure");
          return { targetInfo: { url: "http://127.0.0.1/login", title: "Sign in" } };
        }
        if (method === "Target.getTargets") throw new Error("temporary target read failure");
        return { sessionId: "fixture" };
      });
      followSend(t, cdp);
      return cdp;
    });
    const result = await f.proxy.execute("wait_for_owner", ["350"], undefined, false, undefined, {}, f.proxy.activeRunId);
    const readWall = failure === "poll";
    const reply = JSON.parse(result[0]!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, readWall ? "waiting" : "recording");
    assert.match(reply.instruction, readWall ? /wait_for_owner/ : /the run is recording/);
    const saved = new Library(path.join(f.root, "home")).listRuns()[0]!;
    assert.equal(saved.status, readWall ? "needs_human" : "recording");
    assert.equal(saved.envelope?.reason, readWall ? "owner_signin" : undefined);
    const step = (saved.steps as RecordedAgentBrowserCommand[]).at(-1)!;
    assert.equal(step.status, "passed");
    assert.equal(step.afterShot, undefined);
    assert.deepEqual(step.native.screenshots, []);
    if (readWall) {
      const calls = await f.calls();
      for (const command of ["snapshot", "screenshot", "fill", "click", "tab"]) {
        const blocked = await f.proxy.execute(command, [], undefined, false, undefined, {}, f.proxy.activeRunId);
        assert.equal((JSON.parse(blocked[0]!.stdout) as { outcome: string }).outcome, "halted");
      }
      assert.deepEqual(await f.calls(), calls);
      await f.proxy.close();
      const closed = new Library(path.join(f.root, "home")).readRun(saved.id);
      assert.equal(closed.status, "failed");
      assert.equal(closed.envelope?.reason, "session_closed");
    }
  } finally { await f.close(); }
});

for (const failure of ["connect", "metadata"] as const) test(`a close during an unfinished ${failure} wait records session_closed`, { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    t.mock.method(sockets, "connectCdp", async () => {
      if (failure === "connect") throw new Error("temporary connection failure");
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        if (method === "Target.getTargetInfo") throw new Error("temporary metadata failure");
        return { sessionId: "fixture" };
      });
      followSend(t, cdp);
      return cdp;
    });
    const runId = f.proxy.activeRunId!;
    const library = new Library(path.join(f.root, "home"));
    const pending = f.proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, runId);
    const until = Date.now() + 2_000;
    let during = library.readRun(runId).status;
    while (during !== "needs_human" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      during = library.readRun(runId).status;
    }
    assert.equal(during, "needs_human");
    await f.proxy.close();
    await pending;
    const saved = library.readRun(runId);
    assert.equal(saved.status, "failed");
    assert.equal(saved.envelope?.reason, "session_closed");
  } finally { await f.close(); }
});

for (const failure of ["connect", "metadata", "poll"]) test(`owner wait resumes in the same run after a temporary ${failure} error`, { timeout: scaledMs(4000) }, async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    let polls = 0;
    let failed = false;
    t.mock.method(sockets, "connectCdp", async () => {
      if (failure === "connect" && !failed) { failed = true; throw new Error("temporary connection failure"); }
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        if (method === "Target.getTargetInfo") {
          if (failure === "metadata" && !failed) { failed = true; throw new Error("temporary metadata failure"); }
          return { targetInfo: polls > 1
            ? { url: "http://127.0.0.1/member", title: "Dashboard" }
            : { url: "http://127.0.0.1/login", title: "Sign in" } };
        }
        if (method === "Target.getTargets") {
          polls++;
          if (failure === "poll" && !failed) { failed = true; throw new Error("one temporary poll error"); }
          return { targetInfos: [{ targetId: "ABC123", url: "http://127.0.0.1/member", title: "Dashboard" }] };
        }
        return { sessionId: "fixture", data: png.toString("base64") };
      });
      followSend(t, cdp);
      return cdp;
    });
    const library = new Library(path.join(f.root, "home"));
    const id = library.listRuns()[0]!.id;
    const result = await f.proxy.execute("wait_for_owner", ["2500"], undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.equal((JSON.parse(result[0]!.stdout) as { outcome: string }).outcome, "ready");
    assert.equal(failed, true);
    assert.ok(polls > 1);
    assert.equal(library.readRun(id).status, "recording");
    assert.equal(library.readRun(id).envelope, undefined);
    assert.equal((await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "snapshot unchanged\n");
    assert.equal(library.listRuns()[0]!.id, id);
  } finally { await f.close(); }
});

test("proxy forwards argv and native output, attaches to its marked copy, and removes it on close", async (t) => {
  const f = await fixture(t);
  try {
    const source = await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8");
    assert.deepEqual(await f.proxy.execute("open", ["http://127.0.0.1/"], "copy"), [
      { stdout: "open unchanged\n", stderr: "", exitCode: 0 },
      { stdout: "t1 Synthetic - http://127.0.0.1/\n", stderr: "", exitCode: 0 },
    ]);
    const text = "spaces 'quotes' \"double\"\nline two";
    assert.deepEqual(await f.proxy.execute("fill", ["@e2", text], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "fill unchanged\n", stderr: "", exitCode: 0 }]);
    const records = await f.calls();
    const filled = records.find((call) => call.args.includes("fill"))!;
    assert.deepEqual(filled.args.slice(-3), ["fill", "@e2", text]);
    const flags = records[0]!.args;
    assert.equal(flags[flags.indexOf("--session") + 1], "bao");
    const cdp = flags[flags.indexOf("--cdp") + 1]!;
    assert.match(cdp, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36}$/, "the agent reaches Chrome through Bao's endpoint, which keeps it behind");
    assert.notEqual(cdp, "ws://127.0.0.1:12345/devtools/browser/proxy-test");
    assert.equal(flags.includes("--profile"), false);
    assert.equal(flags.includes("--executable-path"), false);
    assert.equal(flags[flags.indexOf("--idle-timeout") + 1], "0");
    const copy = f.copy();
    assert.notEqual(copy, f.sourceRoot);
    const preferences = JSON.parse(await readFile(path.join(copy, "Profile 2", "Preferences"), "utf8")) as { profile: { name: string; avatar_index: number } };
    assert.equal(preferences.profile.name, "Bao copy of Synthetic");
    assert.equal(preferences.profile.avatar_index, 31);
    assert.equal(await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8"), source);
    assert.equal(records[0]!.env.AGENT_BROWSER_SOCKET_DIR, filled.env.AGENT_BROWSER_SOCKET_DIR);
    assert.equal(records[0]!.env.HOME, records[0]!.env.AGENT_BROWSER_SOCKET_DIR);
    assert.equal(records[0]!.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "close unchanged\n", stderr: "", exitCode: 0 }]);
    await assert.rejects(access(copy), /ENOENT/);
    await assert.rejects(access(records[0]!.env.AGENT_BROWSER_SOCKET_DIR!), /ENOENT/);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId), /start agent-browser with open/);
    await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId);
    assert.notEqual(f.copy(), copy);
  } finally { await f.close(); }
});

test("snapshot find and diff return short views while the run keeps the full native tree", async (t) => {
  const f = await fixture(t);
  const page = (dialog: string) => `- banner\n  - button "Open search" [ref=e1]\n- main\n  - heading "Repos" [level=1, ref=e2]\n${dialog}  - list\n${Array.from({ length: 40 }, (_, i) => `    - listitem\n      - link "Repo ${i}" [ref=e${i + 10}]\n`).join("")}`;
  const before = page("");
  const after = page(`  - dialog "Search"\n    - combobox "Search or jump to" [ref=e3]\n`);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    await writeFile(path.join(f.root, "page.txt"), before);
    await assert.rejects(f.proxy.execute("click", ["@e1"], undefined, false, undefined, { find: { text: "x" } }, f.proxy.activeRunId), /only accepted on snapshot/);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, { find: {} }, f.proxy.activeRunId), /non-empty text, role, or both/);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, { find: { text: "x" }, diff: true }, f.proxy.activeRunId), /find or diff, not both/);

    const [found] = await f.proxy.execute("snapshot", [], undefined, false, undefined, { find: { text: "search", role: "button" } }, f.proxy.activeRunId);
    assert.equal(found!.stdout, `1 of ${before.trimEnd().split("\n").length} snapshot lines match text "search" and role button. Each is shown with the lines that hold it and everything inside it.\n- banner\n  - button "Open search" [ref=e1]`);
    assert.equal(f.proxy.lastCommand!.step.native.results[0]!.stdout, before, "the run records the full native tree");

    assert.match((await f.proxy.execute("snapshot", [], undefined, false, undefined, { diff: true }, f.proxy.activeRunId))[0]!.stdout, /^No change since the last snapshot/);
    await writeFile(path.join(f.root, "page.txt"), after);
    const [changed] = await f.proxy.execute("snapshot", [], undefined, false, undefined, { diff: true }, f.proxy.activeRunId);
    assert.equal(changed!.stdout, "Changed since the last snapshot: 2 lines added (+), 0 removed (-). Unchanged lines are left out except the ones that hold a change.\n"
      + "  - main\n+   - dialog \"Search\"\n+     - combobox \"Search or jump to\" [ref=e3]");
    assert.match((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, { diff: true }, f.proxy.activeRunId))[0]!.stdout, /^No earlier snapshot with these args in this session, so this is the full snapshot\.\n- banner/);
    assert.equal((await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, after, "a plain snapshot stays the exact native output");
  } finally { await f.close(); }
});

test("session end during startup waits for ownership and removes the new window and run", async (t) => {
  const f = await fixture(t);
  const openChrome = profiles.openCopiedChromeForProxy;
  let started!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof openChrome>[0]) => {
    started();
    await gate;
    return openChrome(options);
  });
  try {
    const opening = f.proxy.execute("open", [], "copy");
    const rejected = assert.rejects(opening, /The agent disconnected/);
    await entered;
    const ending = f.proxy.end();
    resume();
    await rejected;
    await ending;
    assert.equal(f.closeCount(), 1);
    await assert.rejects(access(f.copy()), /ENOENT/);
    assert.equal(new Library(path.join(f.root, "home")).listRuns()[0]!.status, "failed");
  } finally { resume(); await f.close(); }
});

test("queued close during startup overrides an end already keeping the window", async (t) => {
  const f = await fixture(t, true);
  const openChrome = profiles.openCopiedChromeForProxy;
  let started!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof openChrome>[0]) => {
    started();
    await gate;
    return openChrome(options);
  });
  let releaseClose = () => {};
  try {
    const rejected = assert.rejects(f.proxy.execute("open", [], "copy"), /The agent disconnected/);
    await entered;
    const ending = f.proxy.end();
    releaseClose = f.proxy.queueClose();
    resume();
    await rejected;
    await ending;
    assert.equal(f.closeCount(), 1, "close intent must reach the session created during shutdown");
    await assert.rejects(access(f.copy()), /ENOENT/);
    assert.equal((await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
  } finally { releaseClose(); resume(); await f.close(); }
});

for (const timing of ["stop", "release", "retained"] as const) {
  test(`explicit close overrides keep-open at ${timing}`, async (t) => {
    const f = await fixture(t, true);
    const openChrome = profiles.openCopiedChromeForProxy;
    let entered!: () => void;
    let resume!: () => void;
    const releasing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof openChrome>[0]) => {
      const chrome = await openChrome(options);
      return { ...chrome, async keepOpen() {
        await chrome.keepOpen();
        entered();
        if (timing === "release") await gate;
      } };
    });
    let releaseClose = () => {};
    try {
      await f.proxy.execute("open", [], "copy");
      const copy = f.copy();
      const ending = f.proxy.end();
      if (timing === "stop") {
        await new Promise<void>(resolve => setImmediate(() => { releaseClose = f.proxy.queueClose(); resolve(); }));
      } else {
        await releasing;
        if (timing === "retained") await ending;
        releaseClose = f.proxy.queueClose();
      }
      resume();
      await ending;
      assert.equal((await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
      assert.equal(f.closeCount(), 1, "a late close must still own and close the kept window");
      await assert.rejects(access(copy), /ENOENT/);
    } finally { releaseClose(); resume(); await f.close(); }
  });
}

test("proxy reports native errors unchanged and leaves the session usable", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    assert.deepEqual(await f.proxy.execute("click", ["fail"], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "native failure output\n", stderr: "native error\n", exitCode: 1 }]);
    assert.equal((await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
    assert.equal((await f.calls()).filter((call) => call.args.at(-2) === "click").length, 1);
  } finally { await f.close(); }
});

for (const mode of ["native-error", "missing-native", "daemon-error"]) {
  test(`proxy closes its Chrome and removes the copy after ${mode} during close`, async (t) => {
    const f = await fixture(t);
    try {
      await f.proxy.execute("open", [], "copy");
      const copy = f.copy();
      const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
      if (mode === "missing-native") {
        await rm(path.join(f.root, "native"));
        await assert.rejects(f.proxy.close(), /ENOENT/);
      } else {
        assert.deepEqual(await f.proxy.execute("close", [mode === "daemon-error" ? "daemon-fail" : "fail"], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "native failure output\n", stderr: "native error\n", exitCode: 1 }]);
        if (mode === "daemon-error") await waitFor(async () => !alive(Number(await readFile(path.join(f.root, "daemon.pid"), "utf8"))));
      }
      await assert.rejects(access(copy), /ENOENT/);
      await assert.rejects(access(stateDir), /ENOENT/);
      await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId), /start agent-browser with open/);
    } finally { await f.close(); }
  });
}

for (const ending of ["close", "finish_task", "disconnect", "owner-close", "idle"] as const) test(`failed copy cleanup after ${ending} is reported once, is kept on the run, and a later open starts fresh`, async (t) => {
  const f = await fixture(t);
  const openChrome = profiles.openCopiedChromeForProxy;
  let opens = 0;
  let failed = false;
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof openChrome>[0]) => {
    opens++;
    const chrome = await openChrome(options);
    return { ...chrome, close: async () => {
      await chrome.close();
      if (!failed) { failed = true; throw new Error("copy deletion failed"); }
    } };
  });
  try {
    if (ending === "idle") t.mock.timers.enable({ apis: ["setTimeout"] });
    await f.proxy.execute("open", [], "copy");
    const runId = f.proxy.activeRunId!;
    const reported = { message: `Bao could not clean up the browser session of run ${runId}: copy deletion failed` };
    if (ending === "close") await assert.rejects(f.proxy.close(), reported);
    else if (ending === "finish_task") await assert.rejects(f.proxy.finishTask({ outcome: "passed", reason: "task complete" }, f.proxy.activeRunId), reported);
    else if (ending === "disconnect") await assert.rejects(f.proxy.end(), reported);
    else if (ending === "owner-close") f.closeWindow();
    else t.mock.timers.tick(600_000);
    while (f.proxy.hasSession()) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(failed, true);
    assert.equal(new Library(path.join(f.root, "home")).readRun(runId).cleanupError, "copy deletion failed");
    if (ending === "disconnect") return;
    const [opened] = await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId);
    assert.equal(opened!.exitCode, 0, "the failed cleanup does not answer later calls");
    assert.equal(opens, 2);
    assert.notEqual(f.proxy.activeRunId, runId);
  } finally {
    await f.close().catch(() => undefined);
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(ready: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + scaledMs(3000);
  while (!await ready()) {
    assert.ok(Date.now() < until, "fixture did not reach the expected state");
    await delay(10);
  }
}

for (const command of ["open", "click", "close"]) {
  test(`disconnect aborts a hung ${command} and removes only its session`, async (t) => {
    const f = await fixture(t);
    try {
      if (command !== "open") await f.proxy.execute("open", [], "copy");
      const outcome = f.proxy.execute(command, ["hang"], command === "open" ? "copy" : undefined, false, undefined, {}, command === "open" ? undefined : f.proxy.activeRunId).then(() => undefined, (error: unknown) => error);
      await waitFor(async () => access(path.join(f.root, "command.pid")).then(() => true, () => false));
      const copy = f.copy();
      const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
      const daemon = Number(await readFile(path.join(f.root, "daemon.pid"), "utf8"));
      const child = Number(await readFile(path.join(f.root, "command.pid"), "utf8"));
      f.proxy.disconnect();
      assert.equal((await outcome as Error).name, "AbortError");
      await f.proxy.close();
      await waitFor(async () => !alive(daemon) && !alive(child));
      await assert.rejects(access(copy), /ENOENT/);
      await assert.rejects(access(stateDir), /ENOENT/);
      assert.equal(f.closeCount(), 1);
      await assert.rejects(f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId), /disconnected/);
      assert.equal(await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8"), "{}");
    } finally { await f.close(); }
  });
}

test("Chrome closing during native close preserves its result and cleans up once", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    const copy = f.copy();
    const outcome = f.proxy.execute("close", ["wait"], undefined, false, undefined, {}, f.proxy.activeRunId);
    await waitFor(async () => access(path.join(f.root, "command.pid")).then(() => true, () => false));
    f.closeWindow();
    await writeFile(path.join(f.root, "continue"), "");
    assert.deepEqual(await outcome, [{ stdout: "close unchanged\n", stderr: "", exitCode: 0 }]);
    assert.equal(f.closeCount(), 1);
    await assert.rejects(access(copy), /ENOENT/);
    await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId);
    assert.notEqual(f.copy(), copy);
  } finally { await f.close(); }
});

for (const duringCommand of [false, true]) {
  test(`closed window releases the copy and allows reopen${duringCommand ? " during a command" : ""}`, async (t) => {
    const f = await fixture(t);
    try {
      await f.proxy.execute("open", [], "copy");
      const copy = f.copy();
      const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
      const outcome = duringCommand ? f.proxy.execute("click", ["hang"], undefined, false, undefined, {}, f.proxy.activeRunId).catch((error: unknown) => error) : undefined;
      if (duringCommand) await waitFor(async () => access(path.join(f.root, "command.pid")).then(() => true, () => false));
      f.closeWindow();
      await waitFor(async () => access(stateDir).then(() => false, () => true));
      if (outcome) assert.equal((await outcome as Error).name, "AbortError");
      await assert.rejects(access(copy), /ENOENT/);
      assert.equal(f.closeCount(), 1);
      await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId);
      assert.notEqual(f.copy(), copy);
      assert.equal((await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "snapshot unchanged\n");
      await f.proxy.close();
      assert.equal(f.closeCount(), 2);
    } finally { await f.close(); }
  });
}

test("startup persists a pending open before copying and keeps its failure in one finished run", async (t) => {
  const f = await fixture(t);
  const library = new Library(path.join(f.root, "home"));
  const failure = new Error("Chrome launch failed before attachment");
  const openChrome = profiles.openCopiedChromeForProxy;
  t.mock.method(profiles, "openCopiedChromeForProxy", async () => {
    const runs = library.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "recording");
    const [pending] = runs[0]!.steps as RecordedAgentBrowserCommand[];
    assert.equal(pending!.status, "pending");
    assert.equal(pending!.native.command, "open");
    assert.deepEqual(pending!.native.args, ["http://127.0.0.1/"]);
    assert.equal(pending!.endedAt, undefined);
    throw failure;
  });
  try {
    await assert.rejects(f.proxy.execute("open", ["http://127.0.0.1/"], "copy"), (error) => error === failure);
    const runs = library.listRuns();
    assert.equal(runs.length, 1);
    const saved = library.readRun(runs[0]!.id);
    assert.equal(saved.status, "failed");
    assert.equal(saved.pageEngine, "agent-browser");
    assert.equal(saved.steps.length, 1);
    const [step] = saved.steps as RecordedAgentBrowserCommand[];
    assert.equal(step!.status, "failed");
    assert.equal(step!.native.isError, true);
    assert.equal(step!.native.error, failure.message);
    assert.equal(step!.reason, failure.message);
    assert.deepEqual(step!.native.results, []);
    assert.ok(step!.endedAt! >= step!.startedAt);
    assert.equal(step!.afterShot, undefined);
    assert.equal(step!.afterShotError, "Page screenshot unavailable: Chrome launch failed before attachment.");
    assert.equal(step!.failedToStart, true);
    assert.equal(pageShotLine(step), undefined);
    await assert.rejects(access(path.join(library.root, "shots", "runs", saved.id)), /ENOENT/);
    await assert.rejects(access(path.join(f.root, "calls.jsonl")), /ENOENT/);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId), /start agent-browser with open/);
    assert.equal(library.listRuns().length, 1, "rejected commands do not create runs");
    t.mock.method(profiles, "openCopiedChromeForProxy", openChrome);
    assert.equal((await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "open unchanged\n");
    await f.proxy.close();
    assert.equal(library.listRuns().length, 2, "a fresh attempt has its own run");
    assert.deepEqual(library.readRun(saved.id), saved, "retry does not overwrite startup failure");
  } finally { await f.close(); }
});

test("a missing native executable is recorded before Chrome startup", async (t) => {
  const f = await fixture(t);
  try {
    await rm(path.join(f.root, "native"));
    await assert.rejects(f.proxy.execute("open", [], "copy"), /pinned native agent-browser is missing/);
    const [run] = new Library(path.join(f.root, "home")).listRuns();
    assert.equal(run!.status, "failed");
    const [step] = run!.steps as RecordedAgentBrowserCommand[];
    assert.match(step!.reason!, /pinned native agent-browser is missing/);
    assert.equal(step!.status, "failed");
    assert.equal(step!.failedToStart, true);
    assert.equal(pageShotLine(step), undefined);
    assert.equal(f.copy(), "", "no Chrome copy starts");
  } finally { await f.close(); }
});

test("recording write failures preserve the original startup error", async (t) => {
  const f = await fixture(t);
  const failure = new Error("Chrome launch failed");
  t.mock.method(profiles, "openCopiedChromeForProxy", async () => { throw failure; });
  t.mock.method(Library.prototype, "saveRun", () => { throw new Error("disk full"); });
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => { warnings.push(text); return true; });
  try {
    await assert.rejects(f.proxy.execute("open", [], "copy"), (error) => error === failure);
    assert.ok(warnings.some((text) => text.includes("run write")));
    assert.equal(f.copy(), "");
  } finally { await f.close(); }
});

test("proxy saves raw commands, native errors, timing, screenshots, partial runs and one run per session", async (t) => {
  const f = await fixture(t);
  try {
    const library = new Library(path.join(f.root, "home"));
    const opened = await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const partial = library.listRuns()[0]!;
    assert.equal(partial.status, "recording");
    assert.equal(partial.kind, "capture");
    assert.equal(partial.pageEngine, "agent-browser");
    assert.equal(partial.modelCalls, undefined);
    const text = "ghp_syntheticsecretvalue";
    const filled = await f.proxy.execute("fill", ["@e2", text], undefined, false, undefined, {}, f.proxy.activeRunId);
    const failed = await f.proxy.execute("click", ["fail"], undefined, false, undefined, {}, f.proxy.activeRunId);
    const closed = await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId);
    const saved = library.readRun(partial.id);
    assert.equal(saved.status, "failed");
    const steps = saved.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(steps.map((step) => step.native.command), ["open", "fill", "click", "close"]);
    assert.deepEqual(steps.map((step) => step.native.results), [opened, filled, failed, closed]);
    assert.deepEqual(steps[1]!.native.args, ["@e2", text]);
    assert.equal(steps[2]!.native.isError, true);
    for (const step of steps) {
      assert.ok(step.endedAt! >= step.startedAt);
      if (step.native.command === "close") assert.match(step.afterShotError!, /Session closed/);
      else assert.deepEqual(await readFile(path.join(library.root, "shots", "runs", saved.id, step.afterShot!)), png);
    }
    assert.equal(library.list().workflows.length, 0, "recording does not create a workflow");
    await f.proxy.execute("open", [], "copy", false, undefined, {}, f.proxy.activeRunId);
    f.proxy.disconnect();
    await f.proxy.close();
    assert.equal(library.listRuns().length, 2);
    assert.equal(library.listRuns().filter((run) => run.status === "recording").length, 0);
  } finally { await f.close(); }
});

test("recording write and screenshot failures do not change native command results", async (t) => {
  const f = await fixture(t);
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => { warnings.push(text); return true; });
  t.mock.method(Library.prototype, "saveRun", () => { throw new Error("disk full"); });
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } };
      throw new Error("screenshot unavailable");
    });
    followSend(t, cdp);
    return cdp;
  });
  try {
    assert.deepEqual(await f.proxy.execute("open", [], "copy"), [
      { stdout: "open unchanged\n", stderr: "", exitCode: 0 },
      { stdout: "t1 Synthetic - http://127.0.0.1/\n", stderr: "", exitCode: 0 },
    ]);
    assert.deepEqual(await f.proxy.execute("fill", ["#password", "synthetic-password"], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "fill unchanged\n", stderr: "", exitCode: 0 }]);
    assert.deepEqual(await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId), [{ stdout: "close unchanged\n", stderr: "", exitCode: 0 }]);
    assert.ok(warnings.some((text) => text.includes("run write")));
    assert.ok(warnings.some((text) => text.includes("page screenshot")));
    assert.ok(warnings.every((text) => !text.includes("synthetic-password")));
  } finally { await f.close(); }
});

test("missing privacy metadata refuses page input before recording its arguments", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", [], "copy");
    t.mock.method(sockets, "connectCdp", async () => { throw new Error("privacy metadata unavailable"); });
    await assert.rejects(f.proxy.execute("fill", ["#password", "private-owner-value"], undefined, false, undefined, {}, f.proxy.activeRunId), /privacy metadata unavailable/);
    const calls = await f.calls();
    assert.equal(calls.some((call) => call.args.includes("fill")), false);
    assert.doesNotMatch(JSON.stringify(new Library(path.join(f.root, "home")).listRuns()), /private-owner-value/);
  } finally { await f.close(); }
});

test("a stalled recording CDP connection times out without failing the forwarded command", { timeout: scaledMs(60_000) }, async (t) => {
  const f = await fixture(t);
  t.mock.method(sockets, "connectCdp", async () => {
    const socket = new Socket();
    t.mock.method(socket, "write", () => true);
    const cdp = new sockets.CdpSocket(socket);
    const send = cdp.send.bind(cdp);
    t.mock.method(cdp, "send", (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number) => method === "Target.getTargetInfo"
      ? Promise.resolve({ targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } }) : send(method, params, sessionId, timeoutMs));
    followSend(t, cdp);
    return cdp;
  });
  try {
    assert.equal((await f.proxy.execute("open", [], "copy"))[0]!.stdout, "open unchanged\n");
    const run = new Library(path.join(f.root, "home")).listRuns()[0]!;
    assert.match((run.steps as RecordedAgentBrowserCommand[])[0]!.afterShotError ?? "", /^Page screenshot unavailable: /);
    assert.equal((await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.stdout, "close unchanged\n");
  } finally { await f.close(); }
});

test("proxy rejects malformed commands and attempts to replace its fixed session", async (t) => {
  const f = await fixture(t);
  try {
    await assert.rejects(f.proxy.execute("eval", ["1"]), /unknown/);
    await assert.rejects(f.proxy.execute("open", "http://127.0.0.1/"), /array of strings/);
    await assert.rejects(f.proxy.execute("open", [null], undefined, false, undefined, {}, f.proxy.activeRunId), /array of strings/);
    for (const arg of ["--session=other", "--cdp", "--profile", "--headed=false", "--args", "--idle-timeout=10", "--all", "-p", "--download-path", "--download-path=/tmp"]) {
      await assert.rejects(f.proxy.execute("open", [arg], undefined, false, undefined, {}, f.proxy.activeRunId), /Bao fixes/);
    }
    await assert.rejects(readFile(path.join(f.root, "calls.jsonl")), /ENOENT/);
  } finally { await f.close(); }
});

test("on a copy, a download lands in the run's downloads folder, an upload takes it by name, and the run keeps only file names", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const runId = f.proxy.activeRunId!;
    const downloads = path.join(f.root, "home", "downloads", runId);
    const saved = path.join(downloads, "statement.pdf");
    const [download] = await f.proxy.execute("download", ["@e5", "statement.pdf"], undefined, false, undefined, {}, runId);
    assert.equal(download!.exitCode, 0, download!.stderr);
    assert.match(download!.stdout, /Download saved to \/.*\/statement\.pdf\n$/, "the agent reads the native output with the full path");
    assert.equal(f.proxy.savedFile, saved);
    assert.equal(await readFile(saved, "utf8"), "%PDF-1.4 fixture");
    assert.equal((await f.proxy.execute("download", ["@e5", "statement.pdf"], undefined, false, undefined, {}, runId))[0]!.exitCode, 0);
    assert.equal(f.proxy.savedFile, path.join(downloads, "statement (2).pdf"), "a second download keeps the first file");
    const [upload] = await f.proxy.execute("upload", ["input[type=file]", "statement.pdf"], undefined, false, undefined, {}, runId);
    assert.equal(upload!.exitCode, 0, upload!.stderr);
    assert.equal(f.proxy.savedFile, undefined);
    const [missing] = await f.proxy.execute("upload", ["#f", path.join(f.root, "gone", "w2.pdf")], undefined, false, undefined, {}, runId);
    assert.equal(missing!.exitCode, 1);
    assert.ok(missing!.stderr.includes(path.join(f.root, "gone", "w2.pdf")), "the agent reads the native error with its own path");
    await assert.rejects(f.proxy.execute("upload", ["#f", "never.pdf"], undefined, false, undefined, {}, runId), /downloaded no file named never\.pdf/);
    await assert.rejects(f.proxy.execute("download", ["@e5", "../statement.pdf"], undefined, false, undefined, {}, runId), /plain file name/);

    const calls = (await f.calls()).map((call) => call.args.slice(call.args.indexOf("--idle-timeout") + 2));
    assert.deepEqual(calls.filter((args) => args[0] === "download" || args[0] === "upload"), [
      ["download", "@e5", saved], ["download", "@e5", path.join(downloads, "statement (2).pdf")],
      ["upload", "input[type=file]", saved], ["upload", "#f", path.join(f.root, "gone", "w2.pdf")],
    ]);
    const stored = await readFile(path.join(f.root, "home", "runs", `${runId}.json`), "utf8");
    for (const folder of [downloads, await realpath(downloads), path.join(f.root, "gone")]) assert.ok(!stored.includes(folder), `the run file does not name ${folder}`);
    const steps = new Library(path.join(f.root, "home")).readRun(runId).steps as unknown as RecordedAgentBrowserCommand[];
    assert.deepEqual(steps.slice(1).map((step) => [step.caption.text, step.summary?.text, step.native.args]), [
      ["Download statement.pdf", 'Downloaded "statement.pdf".', ["@e5", "statement.pdf"]],
      ["Download statement (2).pdf", 'Downloaded "statement (2).pdf".', ["@e5", "statement (2).pdf"]],
      ["Upload statement.pdf", 'Uploaded "statement.pdf".', ["input[type=file]", "statement.pdf"]],
      ["Upload w2.pdf", 'Could not upload "w2.pdf".', ["#f", "w2.pdf"]],
    ]);
    assert.equal(steps.at(-1)!.summary?.error, "\u2717 File not found: w2.pdf");
  } finally { await f.close(); }
});

test("upload and download through the Bao extension are refused before anything runs", async (t) => {
  const f = await fixture(t);
  try {
    const relay = {
      get isOpen() { return true; }, disconnected: new Promise<void>(() => {}), close() {},
      async send(method: string) {
        if (method === "Target.createTarget") return { targetId: "task" };
        if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } };
        if (method === "Target.attachToTarget") return { sessionId: "task" };
        return { data: png.toString("base64") };
      },
      sendUntilProgress(this: { send: (method: string) => Promise<unknown> }, method: string) { return this.send(method); },
    } as unknown as sockets.CdpSocket;
    t.mock.method(runningChrome, "openRunningChrome", async () => ({ endpoint: { port: await trapPort(), browserPath: "/devtools/browser/relay" }, cdp: relay,
      closed: relay.disconnected, isClosed: () => false, detach: () => undefined }));
    const proxy = new AgentBrowserProxy({ home: path.join(f.root, "relay-home"), sourceRoot: f.sourceRoot, executable: path.join(f.root, "native"), extensionRoute: () => true });
    try {
      assert.equal((await proxy.execute("open", ["http://127.0.0.1/"], "current"))[0]!.exitCode, 0);
      const before = (await f.calls()).length;
      for (const [command, args] of [["download", ["@e5", "statement.pdf"]], ["upload", ["#f", "/tmp/w2.pdf"]]] as const) {
        await assert.rejects(proxy.execute(command, [...args], undefined, false, undefined, {}, proxy.activeRunId), /not the Bao extension/);
      }
      assert.equal((await f.calls()).length, before, "nothing reached the native CLI");
      assert.deepEqual((new Library(path.join(f.root, "relay-home")).listRuns()[0]!.steps as unknown as RecordedAgentBrowserCommand[]).map((step) => step.native.command), ["open"]);
    } finally { await proxy.end(); }
  } finally { await f.close(); }
});

test("several Chrome profiles and no named one open nothing and record no run; an unknown name lists the valid ones", async (t) => {
  const f = await fixture(t);
  try {
    await chromeProfiles(f.sourceRoot, { Default: { name: "Alex", user_name: "alex@example.test" }, "Profile 2": { name: "Synthetic" } });
    const question = await f.proxy.execute("open", ["http://127.0.0.1/"], "copy").then(() => undefined, (error: unknown) => error);
    assert.ok(question instanceof ChromeProfileQuestion);
    assert.deepEqual(question.profiles.map((profile) => profile.directory), ["Default", "Profile 2"]);
    await assert.rejects(f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, "Profile 9", {}, f.proxy.activeRunId),
      /Chrome has no profile "Profile 9" in .*\. Choose one of: "Default" \(Alex, alex@example\.test\); "Profile 2" \(Synthetic\)\./);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, "Default", {}, f.proxy.activeRunId), /profile is only accepted on open/);
    assert.equal(f.copy(), "", "no copy started");
    assert.deepEqual(new Library(path.join(f.root, "home")).listRuns(), [], "no run recorded");
    assert.equal(f.proxy.hasSession(), false);
    assert.equal((await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, "Profile 2", {}, f.proxy.activeRunId))[0]!.exitCode, 0);
    assert.match(f.proxy.pickLines[0]!, /^Browser: Chrome copy, named by the agent\. Chrome app: .+\. User data: .+, a copy of Chrome profile "Profile 2" \(Synthetic\) in .+, named by the agent\.$/);
    await assert.rejects(f.proxy.execute("open", ["http://127.0.0.1/"], undefined, false, "Default", {}, f.proxy.activeRunId), /close the current session before choosing a different Chrome profile/);
    const run = new Library(path.join(f.root, "home")).listRuns()[0]!;
    assert.deepEqual(run.browser && { route: run.browser.route, why: run.browser.why, profile: run.browser.route === "extension" ? undefined : run.browser.profile?.directory },
      { route: "copy", why: "named by the agent", profile: "Profile 2" });
  } finally { await f.close(); }
});

test("a copy that stops for sign-in names the Running Chrome fallback on the same profile, and that open says it is the fallback", async (t) => {
  const f = await fixture(t);
  try {
    t.mock.method(sockets, "connectCdp", async () => {
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        const page = { targetId: "ABC123", url: "http://127.0.0.1/login", title: "Confirm your account" };
        if (method === "Target.getTargetInfo") return { targetInfo: page };
        if (method === "Target.attachToTarget") return { sessionId: "fixture" };
        if (method === "Target.getTargets") return { targetInfos: [page] };
        return {};
      });
      followSend(t, cdp);
      return cdp;
    });
    const [halted] = await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const reply = JSON.parse(halted!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "halted");
    assert.ok(reply.instruction.endsWith(" If the sign-in or check does not clear in the Chrome copy, the fallback is the owner's running Chrome over remote debugging on the same Chrome profile \"Profile 2\". "
      + `To take it, call agent_browser with {"command":"close","run_id":"${f.proxy.activeRunId}"}, then with {"command":"open","args":["http://127.0.0.1/"],"browser":"current","profile":"Profile 2"}. Bao does not switch on its own.`), reply.instruction);
    const [waiting] = await f.proxy.execute("wait_for_owner", ["1"], undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.match((JSON.parse(waiting!.stdout) as { instruction: string }).instruction, /the fallback is the owner's running Chrome/);
    await f.proxy.execute("close", [], undefined, false, undefined, {}, f.proxy.activeRunId);

    fakeTaskTab(t);
    let detached = false;
    const owner = {
      get isOpen() { return !detached; }, disconnected: new Promise<void>(() => {}), close() { detached = true; },
      async send(method: string) {
        if (method === "Target.createTarget") return { targetId: "task" };
        if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } };
        if (method === "Target.attachToTarget") return { sessionId: "task" };
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: "task" }] };
        return {};
      },
      sendUntilProgress(this: { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> }, method: string, params?: Record<string, unknown>, sessionId?: string) {
        return this.send(method, params ?? {}, sessionId);
      },
    } as unknown as sockets.CdpSocket;
    t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root: f.sourceRoot,
      endpoint: { port: await trapPort(), browserPath: "/devtools/browser/owner" }, cdp: owner, closed: owner.disconnected, isClosed: () => detached, detach: () => owner.close() }));
    assert.equal((await f.proxy.execute("open", ["http://127.0.0.1/"], "current", false, "Profile 2", {}, f.proxy.activeRunId))[0]!.exitCode, 0);
    assert.equal(f.proxy.pickLines[0], `Browser: Running Chrome over remote debugging, fallback after a sign-in wall. Chrome app: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome. User data: ${f.sourceRoot}. Profile: "Profile 2" (Synthetic) in ${f.sourceRoot}, named by the agent. Bao's task tab opened in the background.`);
    const runs = new Library(path.join(f.root, "home")).listRuns();
    assert.deepEqual(runs.map((run) => run.browser?.why).sort(), ["fallback after a sign-in wall", "named by the agent"]);
  } finally { await f.close(); }
});

/** The owner's running Chrome over remote debugging, with Bao's task tab already open in "Profile 2". */
function fakeOwnerChrome(t: TestContext, root: string) {
  fakeTaskTab(t);
  let detached = false;
  const owner = {
    get isOpen() { return !detached; }, disconnected: new Promise<void>(() => {}), close() { detached = true; },
    async send(method: string) {
      if (method === "Target.createTarget") return { targetId: "task" };
      if (method === "Target.getTargetInfo") return { targetInfo: { url: "http://127.0.0.1/", title: "Fixture" } };
      if (method === "Target.attachToTarget") return { sessionId: "task" };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "task" }] };
      return {};
    },
    sendUntilProgress(this: { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown> }, method: string, params?: Record<string, unknown>, sessionId?: string) {
      return this.send(method, params ?? {}, sessionId);
    },
  } as unknown as sockets.CdpSocket;
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root,
    endpoint: { port: await trapPort(), browserPath: "/devtools/browser/owner" }, cdp: owner, closed: owner.disconnected, isClosed: () => detached, detach: () => owner.close() }));
}

test("a click stop names the page before the wall on the holding line and after the owner closes the window", async (t) => {
  const f = await fixture(t);
  try {
    let page = { targetId: "ABC123", url: "http://127.0.0.1/article", title: "Article" };
    let windowGone = false;
    t.mock.method(sockets, "connectCdp", async () => {
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        if (method === "Target.getTargetInfo") return { targetInfo: page };
        if (method === "Target.attachToTarget") return { sessionId: "fixture" };
        if (method === "Target.getTargets") return { targetInfos: windowGone ? [] : [page] };
        return { data: png.toString("base64") };
      });
      followSend(t, cdp);
      return cdp;
    });
    assert.equal((await f.proxy.execute("open", ["http://127.0.0.1/article"], "copy"))[0]!.exitCode, 0);
    page = { targetId: "ABC123", url: "http://127.0.0.1/menu", title: "Menu" };
    assert.equal((await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, f.proxy.activeRunId))[0]!.exitCode, 0);
    page = { targetId: "ABC123", url: "http://127.0.0.1/login", title: "Sign in" };
    const [halted] = await f.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, f.proxy.activeRunId);
    const holding = JSON.parse(halted!.stdout) as { outcome: string; instruction: string };
    const menu = '"args":["http://127.0.0.1/menu"]';
    assert.equal(holding.outcome, "halted");
    assert.ok(holding.instruction.includes(menu), holding.instruction);
    assert.ok(!holding.instruction.includes("/article"), holding.instruction);
    assert.ok(!holding.instruction.includes("/login"), holding.instruction);
    windowGone = true;
    const [closed] = await f.proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, f.proxy.activeRunId);
    const reply = JSON.parse(closed!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "closed");
    assert.ok(reply.instruction.includes(menu), reply.instruction);
    assert.ok(!reply.instruction.includes("/article"), reply.instruction);
    assert.ok(!reply.instruction.includes("/login"), reply.instruction);
    const [later] = await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId);
    const again = JSON.parse(later!.stdout) as { outcome: string; instruction: string };
    assert.equal(again.outcome, "closed");
    assert.ok(again.instruction.includes(menu), again.instruction);
    assert.ok(!again.instruction.includes("/article"), again.instruction);
  } finally { await f.close(); }
});

test("a wall that clears before finish_task is not a fallback; every wait_for_owner and later result names the fallback or the route", async (t) => {
  const f = await fixture(t);
  try {
    let signedIn = false;
    t.mock.method(sockets, "connectCdp", async () => {
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        const page = signedIn ? { targetId: "ABC123", url: "http://127.0.0.1/home", title: "Home" } : { targetId: "ABC123", url: "http://127.0.0.1/login", title: "Confirm your account" };
        if (method === "Target.getTargetInfo") return { targetInfo: page };
        if (method === "Target.attachToTarget") return { sessionId: "fixture" };
        if (method === "Target.getTargets") return { targetInfos: [page] };
        return { data: png.toString("base64") };
      });
      followSend(t, cdp);
      return cdp;
    });
    const [halted] = await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    assert.equal((JSON.parse(halted!.stdout) as { outcome: string }).outcome, "halted");
    signedIn = true;
    const [ready] = await f.proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, f.proxy.activeRunId);
    const reply = JSON.parse(ready!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "ready");
    assert.ok(reply.instruction.endsWith('then with {"command":"open","args":["http://127.0.0.1/"],"browser":"current","profile":"Profile 2"}. Bao does not switch on its own.'), reply.instruction);
    assert.deepEqual(f.proxy.pickLines, ['Browser: Chrome copy, Chrome profile "Profile 2".']);
    await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, f.proxy.activeRunId);
    assert.deepEqual(f.proxy.pickLines, ['Browser: Chrome copy, Chrome profile "Profile 2".']);
    assert.ok(await f.proxy.finishTask({ outcome: "passed", reason: "signed in" }, f.proxy.activeRunId));
    assert.deepEqual(f.proxy.pickLines, ['Browser: Chrome copy, Chrome profile "Profile 2".']);

    fakeOwnerChrome(t, f.sourceRoot);
    assert.equal((await f.proxy.execute("open", ["http://127.0.0.1/"], "current", false, "Profile 2", {}, f.proxy.activeRunId))[0]!.exitCode, 0);
    assert.match(f.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, named by the agent\. /);
  } finally { await f.close(); }
});

test("an open that fails names the route, Chrome app, and profile folder Bao tried", async (t) => {
  const f = await fixture(t);
  try {
    t.mock.method(currentChrome, "openCurrentChrome", async () => { throw new Error("Could not open Chrome's debugging port"); });
    await assert.rejects(f.proxy.execute("open", ["http://127.0.0.1/"], "current", false, "Profile 2"), /Could not open Chrome's debugging port/);
    assert.equal(f.proxy.pickLines.length, 1);
    assert.match(f.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, named by the agent, did not open\. Chrome app: .+\. Profile: "Profile 2" in (.+)\.$/);
    assert.ok(f.proxy.pickLines[0]!.endsWith(`Profile: "Profile 2" in ${f.sourceRoot}.`));
    await assert.rejects(f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, "Profile 9", {}, f.proxy.activeRunId), /Chrome has no profile "Profile 9"/);
    assert.ok(f.proxy.pickLines[0]!.startsWith("Browser: Chrome copy, named by the agent, did not open. Chrome app: "), f.proxy.pickLines[0]);
    assert.ok(f.proxy.pickLines[0]!.endsWith(`Profile: "Profile 9" in ${f.sourceRoot}.`));
  } finally { await f.close(); }
});

test("an open with no run id ends the open run and starts its own, and the older chat's later calls change nothing", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const older = f.proxy.activeRunId!;
    const sent = (await f.calls()).length;
    const stale = await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, "run-stale");
    assert.equal((JSON.parse(stale[0]!.stdout) as { outcome: string }).outcome, "closed");
    assert.match(stale[0]!.stdout, /The browser now belongs to another task, so stop here/);
    assert.equal((await f.calls()).length, sent, "a stale snapshot sends no native command");
    await assert.rejects(f.proxy.execute("click", ["@e1"]), /run_id is required on click while a browser session is open/);
    assert.equal(await f.proxy.finishTask({ outcome: "failed", reason: "older chat" }, "run-stale"), undefined);
    assert.equal(f.proxy.activeRunId, older, "a stale finish_task leaves the open run");
    await f.proxy.execute("open", ["http://127.0.0.1/next"], "copy");
    const newer = f.proxy.activeRunId!;
    assert.notEqual(newer, older);
    assert.equal(new Library(path.join(f.root, "home")).readRun(older).envelope?.reason, "A newer task opened, so Bao ended this session.");
    const refused = await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, older);
    assert.equal((JSON.parse(refused[0]!.stdout) as { outcome: string }).outcome, "closed");
    assert.match(refused[0]!.stdout, new RegExp(`Run ${older} is not Bao's open browser session`));
    assert.equal(f.proxy.activeRunId, newer, "the older chat's next call does not take the new run");
    assert.equal((await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, newer))[0]!.stdout, "snapshot unchanged\n");
  } finally { await f.close(); }
});

test("an open that names a run a newer task ended leaves the open session alone", async (t) => {
  const f = await fixture(t);
  const library = new Library(path.join(f.root, "home"));
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const older = f.proxy.activeRunId!;
    await f.proxy.execute("open", ["http://127.0.0.1/next"], "copy");
    const newer = f.proxy.activeRunId!;
    assert.notEqual(newer, older);
    const runs = library.listRuns().length;
    const sent = (await f.calls()).length;
    const opened = await f.proxy.execute("open", ["http://127.0.0.1/again"], "copy", false, undefined, {}, older);
    const reply = JSON.parse(opened[0]!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "closed");
    assert.equal(reply.instruction, `This run's browser session ended and cannot continue. Report that to the owner. Run ${older} is not Bao's open browser session. The browser now belongs to another task, so stop here.`);
    assert.equal(f.proxy.activeRunId, newer, "chat A's open does not take chat B's session");
    assert.equal(f.proxy.hasSession(), true);
    assert.equal(library.listRuns().length, runs, "naming the ended run starts no new run");
    assert.equal((await f.calls()).length, sent, "naming the ended run sends no native command");
    assert.equal(f.proxy.lastWorkflowOutcome, undefined);
    assert.equal(library.readRun(older).envelope?.reason, "A newer task opened, so Bao ended this session.");
    assert.equal((await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, newer))[0]!.stdout, "snapshot unchanged\n");
  } finally { await f.close(); }
});

test("after the newer task finishes, a command that names the ended run stays closed and changes nothing", async (t) => {
  const f = await fixture(t);
  const library = new Library(path.join(f.root, "home"));
  const closedFor = (runId: string) => `This run's browser session ended and cannot continue. Report that to the owner. Run ${runId} is not Bao's open browser session. The browser now belongs to another task, so stop here.`;
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const older = f.proxy.activeRunId!;
    await f.proxy.execute("open", ["http://127.0.0.1/next"], "copy");
    const newer = f.proxy.activeRunId!;
    assert.notEqual(newer, older);
    assert.equal(await f.proxy.finishTask({ outcome: "passed", reason: "chat B finished" }, newer), newer);
    assert.equal(f.proxy.hasSession(), false);
    assert.match(f.proxy.lastWorkflowOutcome ?? "", /^(Saved workflow: |Not saved as a workflow: )/);
    const runs = library.listRuns().length;
    const sent = (await f.calls()).length;
    const closed = closedFor(older);
    for (const [command, args] of [["snapshot", []], ["click", ["@e1"]], ["open", ["http://127.0.0.1/again"]], ["wait_for_owner", ["40"]], ["close", []]] as const) {
      const result = await f.proxy.execute(command, [...args], undefined, false, undefined, {}, older);
      const reply = JSON.parse(result[0]!.stdout) as { outcome: string; instruction: string };
      assert.equal(reply.outcome, "closed", command);
      assert.equal(reply.instruction, closed, command);
      assert.equal(f.proxy.lastWorkflowOutcome, undefined, command);
      assert.equal(f.proxy.hasSession(), false, command);
      assert.equal(f.proxy.refused?.runId, older, command);
    }
    assert.equal(await f.proxy.finishTask({ outcome: "failed", reason: "older chat" }, older), undefined);
    assert.equal(f.proxy.refused?.runId, older);
    assert.equal(f.proxy.hasSession(), false);
    assert.equal((await f.calls()).length, sent, "naming the ended run sends no native command");
    assert.equal(library.listRuns().length, runs, "naming the ended run records no new run");
    assert.equal(library.readRun(newer).envelope?.reason, "chat B finished");
    const started = await f.proxy.execute("open", ["http://127.0.0.1/fresh"], "copy");
    assert.equal(started[0]!.exitCode, 0);
    const fresh = f.proxy.activeRunId!;
    assert.notEqual(fresh, older);
    assert.equal(f.proxy.hasSession(), true);
    await f.proxy.finishTask({ outcome: "passed", reason: "fresh task" }, fresh);
    const other = await f.proxy.execute("open", ["http://127.0.0.1/other"], "copy", false, undefined, {}, "run-not-ended-by-newer");
    assert.equal(other[0]!.exitCode, 0);
    assert.notEqual(f.proxy.activeRunId, older);
    assert.notEqual(f.proxy.activeRunId, "run-not-ended-by-newer");
  } finally { await f.close(); }
});

test("a wait_for_owner on a normal page shows needs_human while it waits, then recording, so finish_task keeps the caller's outcome", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const runId = f.proxy.activeRunId!;
    const library = new Library(path.join(f.root, "home"));
    const pending = f.proxy.execute("wait_for_owner", ["250"], undefined, false, undefined, {}, runId);
    const deadline = Date.now() + 2_000;
    let during = library.readRun(runId).status;
    while (during !== "needs_human" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      during = library.readRun(runId).status;
    }
    const [waiting] = await pending;
    const reply = JSON.parse(waiting!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "recording");
    assert.match(reply.instruction, /the run is recording/);
    const card = describeStep({ command: "wait_for_owner", args: ["250"], results: [waiting!] });
    assert.match(card.text, /recording/);
    const shown = textToolResult([waiting!], card.text, [], [], runId);
    assert.match(shown.content.map((block) => block.text).join("\n"), new RegExp(`Run ${runId} · recording`));
    assert.equal(during, "needs_human", "the app shows the run as needing the owner while the agent waits");
    assert.equal(library.readRun(runId).status, "recording", "a page that is not a wall leaves needs_human when the wait ends");
    const clicksBefore = (await f.calls()).filter((call) => call.args.at(-2) === "click").length;
    const [clicked] = await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, runId);
    assert.equal(clicked!.stdout, "click unchanged\n");
    assert.equal(clicked!.exitCode, 0);
    assert.equal((await f.calls()).filter((call) => call.args.at(-2) === "click").length, clicksBefore + 1);
    assert.equal(library.readRun(runId).status, "recording");
    assert.equal(await f.proxy.finishTask({ outcome: "passed", reason: "The page was already open." }, runId), runId);
    assert.equal(library.readRun(runId).status, "passed");
    assert.equal(library.readRun(runId).envelope?.reason, "The page was already open.");
  } finally { await f.close(); }
});

test("a copy session reads the wall snapshot before the run needs the owner, and none during the wait", { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  try {
    await writeFile(path.join(f.root, "page.txt"), `- dialog "Verify it's you"\n  - StaticText "Enter the verification code we sent"\n  - textbox "Enter code" [ref=e1]\n`);
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const runId = f.proxy.activeRunId!;
    await writeFile(path.join(f.root, "hold-snapshot"), "");
    const library = new Library(path.join(f.root, "home"));
    const snapshots = async () => (await f.calls()).filter((call) => call.args[call.args.indexOf("--idle-timeout") + 2] === "snapshot").length;
    const before = await snapshots();
    const waiting = f.proxy.execute("wait_for_owner", ["80"], undefined, false, undefined, {}, runId);
    const until = Date.now() + 1500;
    let seenBeforeNeeds = false;
    let duringSnaps = before;
    while (Date.now() < until) {
      const status = library.readRun(runId).status;
      const snaps = await snapshots();
      if (snaps > before && status === "recording") seenBeforeNeeds = true;
      if (status === "needs_human") { duringSnaps = snaps; break; }
      await delay(5);
    }
    assert.equal(seenBeforeNeeds, true, "the wall snapshot runs while the run is still recording");
    assert.equal(library.readRun(runId).status, "needs_human");
    assert.equal(duringSnaps, before + 1, "the wait starts after that one snapshot");
    const [waited] = await waiting;
    assert.equal((JSON.parse(waited!.stdout) as { outcome: string }).outcome, "waiting");
    assert.equal(await snapshots(), duringSnaps, "no native snapshot runs during the wait");
  } finally { await f.close(); }
});

test("closing the window during the wall snapshot returns closed, not an error", { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  try {
    await writeFile(path.join(f.root, "page.txt"), `- dialog "Verify it's you"\n  - StaticText "Enter the verification code we sent"\n  - textbox "Enter code" [ref=e1]\n`);
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const runId = f.proxy.activeRunId!;
    await writeFile(path.join(f.root, "hold-snapshot"), "");
    const waiting = f.proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, runId);
    const until = Date.now() + 1500;
    let pending = false;
    while (Date.now() < until) {
      const calls = await f.calls().catch(() => []);
      if (calls.some((call) => call.args[call.args.indexOf("--idle-timeout") + 2] === "snapshot")) { pending = true; break; }
      await delay(5);
    }
    assert.equal(pending, true, "the wall snapshot is still running");
    f.closeWindow();
    const [closed] = await waiting;
    assert.equal((JSON.parse(closed!.stdout) as { outcome: string }).outcome, "closed");
    assert.match(closed!.stdout, /The owner closed the Bao window/);
    const saved = new Library(path.join(f.root, "home")).readRun(runId);
    assert.equal(saved.status, "failed");
    assert.equal(saved.envelope?.reason, "session_closed");
  } finally { await f.close(); }
});

test("a snapshot sign-in dialog stays waiting at the deadline, with the fallback, and the next click does not run", async (t) => {
  const f = await fixture(t);
  try {
    await writeFile(path.join(f.root, "page.txt"), `- dialog "Verify it's you"\n  - StaticText "Enter the verification code we sent"\n  - textbox "Enter code" [ref=e1]\n`);
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const runId = f.proxy.activeRunId!;
    const [waited] = await f.proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, runId);
    const reply = JSON.parse(waited!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "waiting");
    assert.equal(f.proxy.ownerPage?.url, "http://127.0.0.1/");
    assert.equal(f.proxy.ownerPage?.title, "Fixture", "the page URL and title are not a wall; the snapshot is");
    assert.ok(reply.instruction.includes(`{"command":"close","run_id":"${runId}"}`), reply.instruction);
    assert.ok(reply.instruction.includes('"browser":"current"'), reply.instruction);
    assert.ok(reply.instruction.includes("Bao does not switch on its own."), reply.instruction);
    const sent = (await f.calls()).length;
    const [blocked] = await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, runId);
    assert.equal((JSON.parse(blocked!.stdout) as { outcome: string }).outcome, "halted");
    assert.equal((await f.calls()).length, sent, "a snapshot dialog deadline does not let the next click run");
    assert.equal(new Library(path.join(f.root, "home")).readRun(runId).status, "needs_human");
  } finally { await f.close(); }
});

test("a wall wait at its deadline still returns waiting and the next click does not run", async (t) => {
  const f = await fixture(t);
  try {
    t.mock.method(sockets, "connectCdp", async () => {
      const cdp = new sockets.CdpSocket(new Socket());
      t.mock.method(cdp, "send", async (method: string) => {
        const page = { targetId: "ABC123", url: "http://127.0.0.1/login", title: "Sign in" };
        if (method === "Target.getTargetInfo") return { targetInfo: page };
        if (method === "Target.getTargets") return { targetInfos: [page] };
        if (method === "Target.attachToTarget") return { sessionId: "fixture" };
        return { data: png.toString("base64") };
      });
      followSend(t, cdp);
      return cdp;
    });
    await f.proxy.execute("open", ["http://127.0.0.1/login"], "copy");
    const runId = f.proxy.activeRunId!;
    const [waited] = await f.proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, runId);
    const reply = JSON.parse(waited!.stdout) as { outcome: string };
    assert.equal(reply.outcome, "waiting");
    const sent = (await f.calls()).length;
    const [blocked] = await f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, runId);
    assert.equal((JSON.parse(blocked!.stdout) as { outcome: string }).outcome, "halted");
    assert.equal((await f.calls()).length, sent, "a wall deadline does not let the next click run");
    assert.equal(new Library(path.join(f.root, "home")).readRun(runId).status, "needs_human");
  } finally { await f.close(); }
});

test("finish_task with keep-open drops the session and a later close leaves the window open", async (t) => {
  const f = await fixture(t, true);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy");
    const kept = f.proxy.activeRunId!;
    assert.equal(await f.proxy.finishTask({ outcome: "passed", reason: "Keep the window." }, kept), kept);
    assert.equal(f.proxy.hasSession(), false);
    assert.equal(f.closeCount(), 0);
    await assert.rejects(f.proxy.execute("snapshot", [], undefined, false, undefined, {}, kept), /start agent-browser with open/);
    const [waited] = await f.proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, kept);
    const reply = JSON.parse(waited!.stdout) as { outcome: string; instruction: string };
    assert.equal(reply.outcome, "closed");
    assert.equal(reply.instruction.includes("The owner closed the Bao window"), false);
    assert.equal(await f.proxy.finishTask({ outcome: "passed", reason: "again" }), undefined);
    const [closed] = await f.proxy.execute("close", [], undefined, false, undefined, {}, kept);
    assert.equal(closed!.stdout, "");
    assert.equal(closed!.exitCode, 0);
    assert.equal(f.closeCount(), 0, "a close with the kept run id leaves the window open");
    const [opened] = await f.proxy.execute("open", ["http://127.0.0.1/next"], "copy");
    assert.equal(opened!.exitCode, 0);
    assert.notEqual(f.proxy.activeRunId, kept);
    assert.equal(f.closeCount(), 0, "a later open does not close the kept window");
  } finally { await f.close(); }
});
