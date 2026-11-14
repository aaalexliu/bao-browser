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
import type { PageState, PageStateEntry } from "../../src/engines/step-page";
import { gunzipSync } from "node:zlib";

async function pageFile(home: string, runId: string, entry: PageStateEntry | undefined): Promise<PageState> {
  assert.ok(entry && "file" in entry, `page read failed: ${entry && "error" in entry ? entry.error : "missing"}`);
  return JSON.parse(gunzipSync(await readFile(path.join(home, "runs", runId, entry.file))).toString("utf8")) as PageState;
}

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
  const cdpCalls: string[] = [];
  const failing = new Set<string>();
  t.mock.method(sockets, "connectCdp", async () => {
    const cdp = new sockets.CdpSocket(new Socket());
    t.mock.method(cdp, "send", async (method: string, params?: Record<string, unknown>) => {
      cdpCalls.push(method);
      if (failing.has(method)) throw new Error(`${method} failed`);
      if (method === "Target.attachToTarget") return { sessionId: "fixture" };
      if (method === "Runtime.evaluate") {
        return String(params?.expression).includes("location.href")
          ? { result: { value: { url: page.url, title: page.title, x: 0, y: 12 } } }
          : { result: { value: 1 } };
      }
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 0, pageY: 12, clientWidth: 800, clientHeight: 600 } };
      if (method === "DOMSnapshot.captureSnapshot") return { documents: [{ documentURL: page.url, nodes: { inputValue: { index: [3], value: [1] } } }], strings: [page.url, "quarterly"] };
      if (method === "Accessibility.getFullAXTree") return { nodes: [{ nodeId: "1", role: { value: "button" }, name: { value: "Upload statement" } }] };
      if (method === "Page.captureSnapshot") return { data: `MHTML ${page.url}` };
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
} else if (command === 'snapshot') {
  process.stdout.write('- button "Upload statement" [ref=e3]\\n- link "Statements" [ref=e4]\\n');
} else if (command === 'get' && args.includes('box')) {
  process.stdout.write(JSON.stringify({ data: { x: 10, y: 20, width: 120, height: 30 } }));
} else if (args.includes('fail')) {
  process.stderr.write('native error\\n');
  process.exitCode = 1;
} else if (command === 'tab' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ data: { tabs: [{ active: true, targetId: 'ABC123' }] } }));
} else process.stdout.write(command + ' unchanged\\n');
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  return {
    root, proxy, page, cdpCalls, failing,
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

test("each step keeps the page before and after, one archive per page, and the element it acted on", async (t) => {
  const f = await fixture(t);
  try {
    const home = path.join(f.root, "home");
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open the statement page.");
    const runId = f.proxy.activeRunId!;
    await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("click", ["@e3"], undefined, false, undefined, {}, runId, undefined, "Upload the statement.");
    f.page.url = "http://127.0.0.1/api/upload";
    await f.proxy.execute("click", ["@e4", "fail"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("close", [], undefined, false, undefined, {}, runId);

    const open = await readStepRecord(home, runId, "command-1");
    assert.equal(open.page?.before, undefined, "the first open has no page before it");
    const opened = await pageFile(home, runId, open.page?.after);
    assert.equal(opened.schema, "bao.page-state/v1");
    assert.equal(opened.url, "http://127.0.0.1/");
    assert.equal(opened.title, "Fixture");
    assert.deepEqual(opened.scroll, { x: 0, y: 12 });
    assert.deepEqual((opened.layout as { cssLayoutViewport: { clientWidth: number } }).cssLayoutViewport.clientWidth, 800);
    assert.deepEqual((opened.dom as { strings: string[] }).strings, ["http://127.0.0.1/", "quarterly"]);
    assert.equal((opened.ax as { nodes: unknown[] }).nodes.length, 1);
    const archive = open.page?.after && "mhtml" in open.page.after ? open.page.after.mhtml : undefined;
    assert.equal(archive, "steps/command-1.after.mhtml.gz");
    assert.equal(gunzipSync(await readFile(path.join(home, "runs", runId, archive!))).toString("utf8"), "MHTML http://127.0.0.1/");

    const read = await readStepRecord(home, runId, "command-2");
    const readBefore = await pageFile(home, runId, read.page?.before);
    assert.equal(readBefore.url, "http://127.0.0.1/");
    assert.equal(readBefore.ax, undefined, "the accessibility tree is read after a step only");
    assert.deepEqual((readBefore.dom as { strings: string[] }).strings, ["http://127.0.0.1/", "quarterly"]);
    assert.equal((await pageFile(home, runId, read.page?.after)).url, "http://127.0.0.1/");
    assert.ok(read.page?.before && !("mhtml" in read.page.before), "a page already archived is not archived again");
    assert.equal(read.target, undefined);

    const click = await readStepRecord(home, runId, "command-3");
    assert.equal(click.why, "Upload the statement.");
    assert.deepEqual(click.target, { ref: "@e3", role: "button", name: "Upload statement", box: { x: 10, y: 20, width: 120, height: 30 } });
    assert.equal(typeof (click.page?.before as { ms: number }).ms, "number");

    const failed = await readStepRecord(home, runId, "command-4");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "native error");
    assert.deepEqual(failed.target, { ref: "@e4", role: "link", name: "Statements", box: { x: 10, y: 20, width: 120, height: 30 } });
    assert.equal((await pageFile(home, runId, failed.page?.before)).url, "http://127.0.0.1/api/upload");
    assert.equal((await pageFile(home, runId, failed.page?.after)).url, "http://127.0.0.1/api/upload");
    assert.equal(failed.page?.before && "mhtml" in failed.page.before ? failed.page.before.mhtml : undefined, "steps/command-4.before.mhtml.gz", "a new page gets its archive on the first read that reaches it");

    const closed = await readStepRecord(home, runId, "command-5");
    assert.equal((await pageFile(home, runId, closed.page?.before)).url, "http://127.0.0.1/api/upload");
    assert.equal(closed.page?.after, undefined, "close leaves no page to read");
  } finally {
    await f.close();
  }
});

test("a flags-first click records the element, not the flag", async (t) => {
  const f = await fixture(t);
  try {
    const home = path.join(f.root, "home");
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    await f.proxy.execute("snapshot", ["-i"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("click", ["--json", "@e3"], undefined, false, undefined, {}, runId);
    await f.proxy.execute("fill", ["--max-output", "9", "@e3", "quarterly"], undefined, false, undefined, {}, runId);
    const click = await readStepRecord(home, runId, "command-3");
    assert.deepEqual(click.target, { ref: "@e3", role: "button", name: "Upload statement", box: { x: 10, y: 20, width: 120, height: 30 } });
    const fill = await readStepRecord(home, runId, "command-4");
    assert.equal(fill.target?.ref, "@e3");
    assert.equal(fill.target?.role, "button");
    assert.equal(fill.target?.name, "Upload statement");
    const boxes = (await f.calls()).filter((call) => commandOf(call.args) === "get" && call.args.includes("box"));
    assert.deepEqual(boxes.map((call) => call.args[call.args.indexOf("box") + 1]), ["@e3", "@e3"]);
  } finally {
    await f.close();
  }
});

test("each hash route keeps its own MHTML archive", async (t) => {
  const f = await fixture(t);
  try {
    const home = path.join(f.root, "home");
    f.page.url = "http://127.0.0.1/#/statements";
    await f.proxy.execute("open", ["http://127.0.0.1/#/statements"], "copy", false, undefined, {}, undefined, undefined, "Open statements.");
    const runId = f.proxy.activeRunId!;
    const statements = await readStepRecord(home, runId, "command-1");
    const statementsArchive = statements.page?.after && "mhtml" in statements.page.after ? statements.page.after.mhtml : undefined;
    assert.equal(statementsArchive, "steps/command-1.after.mhtml.gz");
    assert.equal(gunzipSync(await readFile(path.join(home, "runs", runId, statementsArchive!))).toString("utf8"), "MHTML http://127.0.0.1/#/statements");

    f.page.url = "http://127.0.0.1/#/upload";
    await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    const upload = await readStepRecord(home, runId, "command-2");
    const uploadArchive = upload.page?.before && "mhtml" in upload.page.before ? upload.page.before.mhtml : undefined;
    assert.equal(uploadArchive, "steps/command-2.before.mhtml.gz", "a different fragment is a different page");
    assert.equal(gunzipSync(await readFile(path.join(home, "runs", runId, uploadArchive!))).toString("utf8"), "MHTML http://127.0.0.1/#/upload");

    await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    const again = await readStepRecord(home, runId, "command-3");
    assert.ok(again.page?.before && !("mhtml" in again.page.before), "the same URL, fragment included, is not archived again");

    f.page.url = "http://127.0.0.1/";
    await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    const bare = await readStepRecord(home, runId, "command-4");
    assert.equal(bare.page?.before && "mhtml" in bare.page.before ? bare.page.before.mhtml : undefined, "steps/command-4.before.mhtml.gz", "the URL without that fragment is a different page");
  } finally {
    await f.close();
  }
});

test("a page read that fails is kept as an error and the command still runs", async (t) => {
  const f = await fixture(t);
  try {
    const home = path.join(f.root, "home");
    await f.proxy.execute("open", ["http://127.0.0.1/"], "copy", false, undefined, {}, undefined, undefined, "Open.");
    const runId = f.proxy.activeRunId!;
    f.failing.add("DOMSnapshot.captureSnapshot");
    const read = await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    assert.equal(read[0]?.exitCode, 0);
    f.failing.delete("DOMSnapshot.captureSnapshot");
    f.failing.add("Page.captureSnapshot");
    f.page.url = "http://127.0.0.1/next";
    await f.proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    const broken = await readStepRecord(home, runId, "command-2");
    assert.deepEqual(broken.page?.before && "error" in broken.page.before ? broken.page.before.error : undefined, "DOMSnapshot.captureSnapshot failed");
    assert.equal(broken.status, "passed");
    const noArchive = await readStepRecord(home, runId, "command-3");
    assert.equal(noArchive.page?.before && "mhtmlError" in noArchive.page.before ? noArchive.page.before.mhtmlError : undefined, "Page.captureSnapshot failed");
    assert.equal((await pageFile(home, runId, noArchive.page?.before)).url, "http://127.0.0.1/next");
  } finally {
    await f.close();
  }
});
