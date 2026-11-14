import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";
import * as sockets from "../../src/cdp-live/socket";
import { AGENT_WAIT_ENDED } from "../../src/v1/stop-copy";
import { Library } from "../../src/v1/store";
import { readStepRecord, runHarPath } from "../../src/engines/step-har";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
const har = Buffer.from(JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "agent-browser", version: "0.41.2" },
    entries: [{ startedDateTime: "2099-01-01T00:00:00.000Z", request: { method: "GET", url: "http://127.0.0.1/api/statement" }, response: { status: 200, content: { mimeType: "application/json", text: "{\"ok\":true}" } } }],
  },
}));

function commandOf(args: string[]): string {
  return args[args.indexOf("--idle-timeout") + 2] ?? "";
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-step-har-proxy-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Profile 2", "Preferences"), "{}");
  await writeFile(path.join(root, "recorded.har"), har);
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]) => {
    const copy = await profiles.copyChromeProfile(options);
    await writeFile(path.join(copy.userDataDir, "DevToolsActivePort"), "12345\n/devtools/browser/proxy-test\n");
    let gone = false;
    return {
      target: { kind: "bao" as const, portFile: path.join(copy.userDataDir, "DevToolsActivePort") },
      closed: new Promise<void>(() => undefined), bytes: copy.bytes, copyMs: copy.copyMs,
      close: async () => { gone = true; await copy.close(); },
      isClosed: () => gone, keepOpen: () => copy.keepOpen(),
    };
  });
  const page = { url: "http://127.0.0.1/", title: "Fixture" };
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string) => {
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Target.getTargetInfo") return { targetInfo: { ...page } };
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "ABC123", url: page.url, title: page.title, type: "page" }] };
      return { data: png.toString("base64") };
    });
    t.mock.method(cdp, "sendUntilProgress", (method: string, params?: Record<string, unknown>, sessionId?: string) => cdp.send(method, params ?? {}, sessionId));
    return cdp;
  });
  const executable = path.join(root, "native");
  const log = path.join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, at: Date.now() }) + '\\n');
const command = args[args.indexOf('--idle-timeout') + 2];
const dead = ${JSON.stringify(path.join(root, "daemon-dead"))};
if (command === 'network' && args.includes('start') && fs.existsSync(${JSON.stringify(path.join(root, "har-start-fail"))})) {
  process.stderr.write('har start failed\\n');
  process.exitCode = 1;
} else if (command === 'network' && args.includes('stop')) {
  if (fs.existsSync(dead)) {
    process.stderr.write('daemon exited\\n');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(args[args.indexOf('stop') + 1], fs.readFileSync(${JSON.stringify(path.join(root, "recorded.har"))}));
    process.stdout.write('har stopped\\n');
  }
} else if (command === 'batch') {
  const step = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
  const item = (words, result) => ({ command: words, error: null, result, success: true });
  process.stdout.write(JSON.stringify([
    item(['console'], { messages: [{ args: [], text: 'read ' + step, type: 'log' }] }),
    item(['console', '--clear'], { cleared: true }),
    item(['errors'], { errors: [{ column: 1, line: 1, text: 'Error: boom ' + step, url: null }] }),
    item(['errors', '--clear'], { cleared: true }), // { cleared: true } is agent-browser 0.41.2's shape; pinned 0.41.0 ignores --clear and returns the errors again, so each step's errors are cumulative until the pin moves to 0.41.2.
  ]));
} else if (command === 'close') {
  fs.writeFileSync(dead, '');
  process.stdout.write('close unchanged\\n');
} else if (command === 'tab' && args.includes('--json') && fs.existsSync(${JSON.stringify(path.join(root, "tab-fail"))})) {
  process.stderr.write('tab list failed\\n');
  process.exitCode = 1;
} else if (command === 'tab' && args.includes('--json') && fs.existsSync(${JSON.stringify(path.join(root, "no-active-tab"))})) {
  process.stdout.write(JSON.stringify({ data: { tabs: [] } }));
} else if (args.includes('fail')) {
  process.stderr.write('native error\\n');
  process.exitCode = 1;
} else if (command === 'tab' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: 'ABC123' }] } }));
} else process.stdout.write(command + ' unchanged\\n');
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  return {
    root, proxy, page,
    calls: async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; at: number }),
    async close() {
      try { await proxy.close(); } catch { /* the test already closed it */ }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a session arms HAR before open and copies the tool file on close", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open the statement page.");
    const runId = f.proxy.activeRunId!;
    await f.proxy.execute("click", ["@e1", "fail"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("close", [], undefined, false, undefined, {}, runId);
    const calls = await f.calls();
    const commands = calls.map((call) => commandOf(call.args));
    assert.ok(commands.indexOf("network") < commands.indexOf("open"));
    assert.ok(calls.some((call) => call.args.includes("har") && call.args.includes("start") && call.args.includes("--content") && call.args.includes("text")));
    const stop = calls.findIndex((call) => call.args.includes("har") && call.args.includes("stop"));
    const close = calls.findIndex((call) => commandOf(call.args) === "close");
    assert.ok(stop >= 0 && stop < close, "export runs while the daemon still holds the recording");
    assert.equal(calls.filter((call) => call.args.includes("har") && call.args.includes("stop")).length, 1);
    assert.deepEqual(await readFile(runHarPath(path.join(f.root, "home"), runId)), har);
    const open = await readStepRecord(path.join(f.root, "home"), runId, "command-1");
    assert.equal(open.why, "Open the statement page.");
    assert.equal(open.command, "open");
    assert.equal(open.waits[0]?.for, "open");
    assert.equal(typeof open.waits[0]?.ms, "number");
    const failed = await readStepRecord(path.join(f.root, "home"), runId, "command-2");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "native error");
    const closed = await readStepRecord(path.join(f.root, "home"), runId, "command-3");
    assert.equal(closed.network.entries.length, 1);
    assert.equal(open.network.entries.length, 0);
    assert.equal(failed.network.entries.length, 0);
  } finally {
    await f.close();
  }
});

test("each step keeps agent-browser's console and errors read at its end, and close and owner waits read none", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    const home = path.join(f.root, "home");
    await f.proxy.execute("click", ["@e1", "fail"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("wait_for_owner", ["50"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("close", [], undefined, false, undefined, {}, runId);
    const batches = (await f.calls()).filter((call) => commandOf(call.args) === "batch");
    assert.equal(batches.length, 2);
    for (const batch of batches) assert.deepEqual(batch.args.slice(batch.args.indexOf("batch")), ["batch", "--json", "console", "console --clear", "errors", "errors --clear"]);
    const open = await readStepRecord(home, runId, "command-1");
    const click = await readStepRecord(home, runId, "command-2");
    const read = (record: { console?: unknown }) => record.console as { command: string[]; success: boolean; result: { messages: { text: string }[] } };
    assert.deepEqual(read(open).command, ["console"]);
    assert.equal(read(open).success, true);
    assert.match(read(open).result.messages[0]!.text, /^read \d+$/);
    assert.match(JSON.stringify(open.errors), /"command":\["errors"\].*"text":"Error: boom /);
    assert.equal(click.status, "failed", "a failed click still keeps its read");
    assert.notEqual(read(click).result.messages[0]!.text, read(open).result.messages[0]!.text, "each step stores its own read");
    for (const id of ["command-3", "command-4"]) {
      const saved = await readStepRecord(home, runId, id);
      assert.equal(saved.console, undefined);
      assert.equal(saved.errors, undefined);
    }
  } finally {
    await f.close();
  }
});

test("a failed HAR start still records the step and does not fail the command", async (t) => {
  const f = await fixture(t);
  try {
    await writeFile(path.join(f.root, "har-start-fail"), "");
    const opened = await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Still open.");
    assert.equal(opened[0]?.exitCode, 0);
    const runId = f.proxy.activeRunId!;
    await f.proxy.execute("close", [], undefined, false, undefined, {}, runId);
    const saved = await readStepRecord(path.join(f.root, "home"), runId, "command-1");
    assert.equal(saved.why, "Still open.");
    assert.equal(saved.network.entries.length, 0);
    await assert.rejects(readFile(runHarPath(path.join(f.root, "home"), runId)));
  } finally {
    await f.close();
  }
});

test("a tab list failure records the click that asked for it", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    await writeFile(path.join(f.root, "tab-fail"), "");
    await assert.rejects(f.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, runId), /tab list failed/);
    const click = await readStepRecord(path.join(f.root, "home"), runId, "command-2");
    assert.equal(click.command, "click");
    assert.equal(click.status, "failed");
    assert.match(click.error ?? "", /tab list failed/);
  } finally {
    await f.close();
  }
});

test("a rejected upload or download argument is the step that failed", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    const home = path.join(f.root, "home");
    await assert.rejects(f.proxy.execute("upload", ["#f", "never.pdf"], undefined, false, undefined, {}, runId), /no file named never\.pdf/);
    await assert.rejects(f.proxy.execute("download", ["@e5", "../statement.pdf"], undefined, false, undefined, {}, runId), /plain file name/);
    const upload = await readStepRecord(home, runId, "command-2");
    const download = await readStepRecord(home, runId, "command-3");
    assert.equal(upload.command, "upload");
    assert.equal(upload.status, "failed");
    assert.match(upload.error ?? "", /never\.pdf/);
    assert.deepEqual(upload.args, ["#f", "never.pdf"]);
    assert.equal(download.command, "download");
    assert.equal(download.status, "failed");
    assert.match(download.error ?? "", /plain file name/);
    assert.deepEqual(download.args, ["@e5", "../statement.pdf"]);
  } finally {
    await f.close();
  }
});

test("a wait starts before a failed tab list spends its timeout", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    await writeFile(path.join(f.root, "tab-fail"), "");
    const started = Date.now();
    await f.proxy.execute("wait_for_owner", ["120"], undefined, false, undefined, {}, runId);
    const waited = Date.now() - started;
    assert.ok(waited >= 100);
    const wait = await readStepRecord(path.join(f.root, "home"), runId, "command-2");
    assert.equal(wait.command, "wait_for_owner");
    assert.equal(wait.waits[0]?.for, "owner");
    assert.ok((wait.waits[0]?.ms ?? 0) >= 100, "the step clock includes the timeout the wait consumed");
  } finally {
    await f.close();
  }
});

test("closing during a sign-in wait writes the ended wait to the step file and the run", async (t) => {
  const f = await fixture(t);
  try {
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    const home = path.join(f.root, "home");
    f.page.title = "Sign in";
    f.page.url = "http://127.0.0.1/login";
    await f.proxy.execute("wait_for_owner", ["80"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("close", [], undefined, false, undefined, {}, runId);
    const saved = await readStepRecord(home, runId, "command-2");
    const run = new Library(home).readRun(runId);
    const step = run.steps.find((item): item is { id: string; status: string; reason?: string } =>
      !!item && typeof item === "object" && (item as { id?: string }).id === "command-2");
    assert.equal(saved.command, "wait_for_owner");
    assert.equal(saved.status, "failed");
    assert.equal(saved.error, AGENT_WAIT_ENDED);
    assert.ok(step);
    assert.equal(step.status, "failed");
    assert.equal(step.reason, AGENT_WAIT_ENDED);
  } finally {
    await f.close();
  }
});
