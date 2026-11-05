import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-test-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Profile 2", "Preferences"), "{}");
  let copiedDir = "";
  t.mock.method(profiles, "openCopiedChrome", async (options: Parameters<typeof profiles.openCopiedChrome>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    copiedDir = copy.userDataDir;
    const portFile = path.join(copiedDir, "DevToolsActivePort");
    await writeFile(portFile, "12345\n/devtools/browser/proxy-test\n");
    return { target: { kind: "bao" as const, portFile }, parkedTargetId: "ABC123", closed: Promise.resolve(), bytes: copy.bytes, copyMs: copy.copyMs, close: copy.close };
  });
  const executable = path.join(root, "native");
  const log = path.join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, env: process.env}) + '\\n');
const command = args[args.indexOf('--idle-timeout') + 2];
if (args.includes('fail')) { process.stdout.write('native failure output\\n'); process.stderr.write('native error\\n'); process.exitCode = 1; }
else process.stdout.write(command === 'tab' ? 't1 Synthetic - http://127.0.0.1/\\n' : command + ' unchanged\\n');
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, directory: "Profile 2", executable });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  return { root, sourceRoot, proxy, calls, copy: () => copiedDir, async close() { await proxy.close(); await rm(root, { recursive: true, force: true }); } };
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

for (const mode of ["native-error", "missing-native"]) {
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
        assert.deepEqual(await f.proxy.execute("close", ["fail"]), [{ stdout: "native failure output\n", stderr: "native error\n", exitCode: 1 }]);
      }
      await assert.rejects(access(copy), /ENOENT/);
      await assert.rejects(access(stateDir), /ENOENT/);
      await assert.rejects(f.proxy.execute("snapshot"), /start agent-browser with open/);
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
