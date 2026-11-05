import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-test-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Profile 2", "Preferences"), "{}");
  let copiedDir = "";
  let closeWindow = () => {};
  let closeCount = 0;
  t.mock.method(profiles, "openCopiedChrome", async (options: Parameters<typeof profiles.openCopiedChrome>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    copiedDir = copy.userDataDir;
    const portFile = path.join(copiedDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/proxy-test\n");
    let closedWindow!: () => void;
    const closed = new Promise<void>((resolve) => { closedWindow = resolve; });
    closeWindow = closedWindow;
    const close = async () => { closeCount++; closedWindow(); await copy.close(); };
    return { target: { kind: "bao" as const, portFile }, parkedTargetId: "ABC123", closed, bytes: copy.bytes, copyMs: copy.copyMs, close };
  });
  const executable = path.join(root, "native");
  const log = path.join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, env: process.env}) + '\\n');
const command = args[args.indexOf('--idle-timeout') + 2];
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
else process.stdout.write(command === 'tab' ? 't1 Synthetic - http://127.0.0.1/\\n' : command + ' unchanged\\n');
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, directory: "Profile 2", executable });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return {
    root, sourceRoot, proxy, calls, copy: () => copiedDir, closeWindow: () => closeWindow(), closeCount: () => closeCount,
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

test("proxy forwards argv and native output, attaches to its marked copy, and removes it on close", async (t) => {
  const f = await fixture(t);
  try {
    const source = await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8");
    assert.deepEqual(await f.proxy.execute("open", ["http://127.0.0.1/"]), [
      { stdout: "open unchanged\n", stderr: "", exitCode: 0 },
      { stdout: "t1 Synthetic - http://127.0.0.1/\n", stderr: "", exitCode: 0 },
    ]);
    const text = "spaces 'quotes' \"double\"\nline two";
    assert.deepEqual(await f.proxy.execute("fill", ["@e2", text]), [{ stdout: "fill unchanged\n", stderr: "", exitCode: 0 }]);
    const records = await f.calls();
    assert.deepEqual(records[2]!.args.slice(-3), ["fill", "@e2", text]);
    const flags = records[0]!.args;
    assert.equal(flags[flags.indexOf("--session") + 1], "bao");
    assert.equal(flags[flags.indexOf("--cdp") + 1], "ws://127.0.0.1:12345/devtools/browser/proxy-test");
    assert.equal(flags.includes("--profile"), false);
    assert.equal(flags.includes("--executable-path"), false);
    assert.equal(flags[flags.indexOf("--idle-timeout") + 1], "0");
    const copy = f.copy();
    assert.notEqual(copy, f.sourceRoot);
    const preferences = JSON.parse(await readFile(path.join(copy, "Profile 2", "Preferences"), "utf8")) as { profile: { name: string; avatar_index: number } };
    assert.equal(preferences.profile.name, "Bao copy of Synthetic");
    assert.equal(preferences.profile.avatar_index, 31);
    assert.equal(await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8"), source);
    assert.equal(records[0]!.env.AGENT_BROWSER_SOCKET_DIR, records[2]!.env.AGENT_BROWSER_SOCKET_DIR);
    assert.equal(records[0]!.env.HOME, records[0]!.env.AGENT_BROWSER_SOCKET_DIR);
    assert.equal(records[0]!.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(await f.proxy.execute("close"), [{ stdout: "close unchanged\n", stderr: "", exitCode: 0 }]);
    await assert.rejects(access(copy), /ENOENT/);
    await assert.rejects(access(records[0]!.env.AGENT_BROWSER_SOCKET_DIR!), /ENOENT/);
    await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
    await f.proxy.execute("open");
    assert.notEqual(f.copy(), copy);
  } finally { await f.close(); }
});

test("proxy reports native errors unchanged and leaves the session usable", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open");
    assert.deepEqual(await f.proxy.execute("click", ["fail"]), [{ stdout: "native failure output\n", stderr: "native error\n", exitCode: 1 }]);
    assert.equal((await f.proxy.execute("snapshot", ["-i"]))[0]!.exitCode, 0);
    assert.equal((await f.calls()).filter((call) => call.args.at(-2) === "click").length, 1);
  } finally { await f.close(); }
});

for (const mode of ["native-error", "missing-native", "daemon-error"]) {
  test(`proxy closes its Chrome and removes the copy after ${mode} during close`, async (t) => {
    const f = await fixture(t);
    try {
      await f.proxy.execute("open");
      const copy = f.copy();
      const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
      if (mode === "missing-native") {
        await rm(path.join(f.root, "native"));
        await assert.rejects(f.proxy.close(), /ENOENT/);
      } else {
        assert.deepEqual(await f.proxy.execute("close", [mode === "daemon-error" ? "daemon-fail" : "fail"]), [{ stdout: "native failure output\n", stderr: "native error\n", exitCode: 1 }]);
        if (mode === "daemon-error") await waitFor(async () => !alive(Number(await readFile(path.join(f.root, "daemon.pid"), "utf8"))));
      }
      await assert.rejects(access(copy), /ENOENT/);
      await assert.rejects(access(stateDir), /ENOENT/);
      await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
    } finally { await f.close(); }
  });
}

test("failed copy cleanup retains the session and blocks reopen", async (t) => {
  const f = await fixture(t);
  const openChrome = profiles.openCopiedChrome;
  const failure = new Error("copy deletion failed");
  let cleanup: (() => Promise<void>) | undefined;
  t.mock.method(profiles, "openCopiedChrome", async (options: Parameters<typeof openChrome>[0]) => {
    const chrome = await openChrome(options);
    cleanup = chrome.close;
    return { ...chrome, close: async () => { throw failure; } };
  });
  try {
    await f.proxy.execute("open");
    const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
    await assert.rejects(f.proxy.close(), failure);
    await access(f.copy());
    await access(stateDir);
    const calls = await f.calls();
    await assert.rejects(f.proxy.execute("open"), failure);
    assert.deepEqual(await f.calls(), calls);
  } finally {
    await cleanup?.();
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
  const until = Date.now() + 3000;
  while (!await ready()) {
    assert.ok(Date.now() < until, "fixture did not reach the expected state");
    await delay(10);
  }
}

for (const command of ["open", "click", "close"]) {
  test(`disconnect aborts a hung ${command} and removes only its session`, async (t) => {
    const f = await fixture(t);
    try {
      if (command !== "open") await f.proxy.execute("open");
      const outcome = f.proxy.execute(command, ["hang"]).then(() => undefined, (error: unknown) => error);
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
      await assert.rejects(f.proxy.execute("open"), /disconnected/);
      assert.equal(await readFile(path.join(f.sourceRoot, "Profile 2", "Preferences"), "utf8"), "{}");
    } finally { await f.close(); }
  });
}

test("Chrome closing during native close preserves its result and cleans up once", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open");
    const copy = f.copy();
    const outcome = f.proxy.execute("close", ["wait"]);
    await waitFor(async () => access(path.join(f.root, "command.pid")).then(() => true, () => false));
    f.closeWindow();
    await writeFile(path.join(f.root, "continue"), "");
    assert.deepEqual(await outcome, [{ stdout: "close unchanged\n", stderr: "", exitCode: 0 }]);
    assert.equal(f.closeCount(), 1);
    await assert.rejects(access(copy), /ENOENT/);
    await f.proxy.execute("open");
    assert.notEqual(f.copy(), copy);
  } finally { await f.close(); }
});

for (const duringCommand of [false, true]) {
  test(`closed window releases the copy and allows reopen${duringCommand ? " during a command" : ""}`, async (t) => {
    const f = await fixture(t);
    try {
      await f.proxy.execute("open");
      const copy = f.copy();
      const stateDir = (await f.calls())[0]!.env.AGENT_BROWSER_SOCKET_DIR!;
      const outcome = duringCommand ? f.proxy.execute("click", ["hang"]).catch((error: unknown) => error) : undefined;
      if (duringCommand) await waitFor(async () => access(path.join(f.root, "command.pid")).then(() => true, () => false));
      f.closeWindow();
      await waitFor(async () => access(stateDir).then(() => false, () => true));
      if (outcome) assert.equal((await outcome as Error).name, "AbortError");
      await assert.rejects(access(copy), /ENOENT/);
      assert.equal(f.closeCount(), 1);
      await f.proxy.execute("open");
      assert.notEqual(f.copy(), copy);
      assert.equal((await f.proxy.execute("snapshot"))[0]!.stdout, "snapshot unchanged\n");
      await f.proxy.close();
      assert.equal(f.closeCount(), 2);
    } finally { await f.close(); }
  });
}

test("proxy rejects malformed commands and attempts to replace its fixed session", async (t) => {
  const f = await fixture(t);
  try {
    await assert.rejects(f.proxy.execute("eval", ["1"]), /unknown/);
    await assert.rejects(f.proxy.execute("open", "http://127.0.0.1/"), /array of strings/);
    await assert.rejects(f.proxy.execute("open", [null]), /array of strings/);
    for (const arg of ["--session=other", "--cdp", "--profile", "--headed=false", "--args", "--idle-timeout=10", "--all", "-p"]) {
      await assert.rejects(f.proxy.execute("open", [arg]), /Bao fixes/);
    }
    await assert.rejects(readFile(path.join(f.root, "calls.jsonl")), /ENOENT/);
  } finally { await f.close(); }
});
