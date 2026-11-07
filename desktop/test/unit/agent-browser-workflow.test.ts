import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Library } from "../../src/v1/store";
import type { TrailEvent } from "../../src/v1/interpret";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { UI_EXTENSION, VIEWER_MIME } from "../../src/mcp/viewer";

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
interface Result { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: { command: string; run_id: string; step_id: string } }
const text = (result: Result) => result.content.map((item) => item.text || "").join("\n");

async function fixture(ui = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-workflow-"));
  const home = path.join(root, "library");
  const source = path.join(root, "source");
  await mkdir(path.join(source, "Default"), { recursive: true });
  await writeFile(path.join(source, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic groceries" } } } }));
  await writeFile(path.join(source, "Default", "Preferences"), "{}");
  const actions: { target: string; name: string }[] = [];
  let reordered = false;
  let missing = false;
  let ownerReady = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/owner-ready") { res.end(JSON.stringify(ownerReady)); return; }
    if (url.pathname === "/signin") {
      res.end(`<!doctype html><title>Sign in</title><p>Synthetic owner handoff</p><script>setInterval(async()=>{if(await(await fetch('/owner-ready')).json())location.replace('/')},100)</script>`);
      return;
    }
    if (url.pathname === "/action") {
      actions.push({ target: url.searchParams.get("target")!, name: url.searchParams.get("name")! });
      res.end("ok");
      return;
    }
    const button = (target: string) => missing && target === "chosen" ? "" : `<button data-testid="${target}" onclick="document.querySelector('#result').textContent='Added '+document.querySelector('#name').value;fetch('/action?target=${target}&name='+encodeURIComponent(document.querySelector('#name').value))">${target === "chosen" && reordered ? "Add this item" : "Add blueberries"}</button>`;
    res.end(`<!doctype html><title>Grocery fixture</title>
      ${reordered ? '<button>Unrelated new control</button>' : ''}
      <label>Name <input id="name" onkeydown="if(event.key==='Enter')document.querySelector('#result').textContent='Ready '+this.value"></label>
      ${reordered ? button("chosen") + button("wrong") : button("wrong") + button("chosen")}
      <p id="result">Not added</p><button id="popup" onclick="window.open('/other')">Open popup</button><div id="plain" onclick="this.textContent='Clicked plain'">Plain action</div><div style="height:3000px">Page end</div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "mcp"], {
    env: { ...process.env, HOME: root, BAO_HOME: home, BAO_AGENT_BROWSER: binary, BAO_AGENT_BROWSER_PROFILE_ROOT: source, BAO_HEAL_CURSOR_ACCOUNT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}: ${stderr}`))));
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  const pending = new Map<number, (result: Result) => void>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let split: number;
    while ((split = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, split)) as { id: number; result: Result };
      buffer = buffer.slice(split + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params = {}): Promise<Result> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 60_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = (command: string, args: string[] = []) => request("tools/call", { name: "agent_browser", arguments: { command, args } });
  await request("initialize", ui ? { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } } } : {});
  return {
    root, home, url, actions, call, request, library: new Library(home),
    reorder() { reordered = true; },
    removeChosen() { missing = true; },
    resumeOwner(ready = true) { ownerReady = ready; },
    async disconnect() { child.stdin.end(); await exited; },
    async close() {
      if (child.exitCode === null) await call("close").catch(() => undefined);
      child.stdin.end();
      await exited;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function passed(f: Awaited<ReturnType<typeof fixture>>, command: string, args: string[] = []) {
  const result = await f.call(command, args);
  assert.equal(result.isError, false, text(result));
  return text(result);
}

test("native ref capture saves a discoverable workflow that replays with new inputs after DOM reordering", { skip: !binary, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    await passed(f, "open", [f.url + "?groceries"]);
    const snapshot = await passed(f, "snapshot", ["-i"]);
    const field = /textbox "Name\s*" \[ref=(e\d+)\]/.exec(snapshot)?.[1];
    const buttons = [...snapshot.matchAll(/button "Add blueberries" \[ref=(e\d+)\]/g)];
    assert.ok(field, snapshot);
    assert.equal(buttons.length, 2, snapshot);
    await passed(f, "fill", [`@${field}`, "Ada"]);
    await passed(f, "press", ["Enter"]);
    await passed(f, "click", [`@${buttons[1]![1]}`]);
    assert.match(await passed(f, "snapshot"), /Added Ada/);
    assert.equal(f.library.list().workflows.length, 0, "an unfinished capture is not published");
    const closing = await passed(f, "close");
    assert.match(closing, /Saved workflow:/);
    const workflows = f.library.list().workflows;
    assert.equal(workflows.length, 1, closing);
    const workflow = workflows[0]!;
    assert.equal(workflow.driver, "playwright");
    assert.equal(workflow.replayed, false);
    assert.deepEqual(workflow.steps.map((step) => step.action), ["navigate", "type", "key", "click"]);
    const clicked = workflow.steps.at(-1)!;
    assert.equal(clicked.identity?.testId, "chosen");
    assert.ok(clicked.locators?.some((locator) => locator.kind === "testid" && locator.value === "chosen"));
    assert.doesNotMatch(JSON.stringify(workflow), /@e\d+|data-bao-i|nth-of-type/);
    const input = workflow.inputs[0]!;
    assert.equal(input.default, "Ada");
    const capture = f.library.listRuns()[0]!;
    assert.equal(capture.kind, "capture");
    assert.equal(capture.workflowId, "agent-browser");
    assert.equal(capture.status, "passed");
    const raw = capture.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(raw.find((step) => step.native.command === "click")!.native.args, [`@${buttons[1]![1]}`]);
    assert.ok(raw.find((step) => step.native.command === "click")!.afterShot);
    const trail = f.library.readTrail(workflow.id) as TrailEvent[];
    assert.equal(trail.at(-1)!.toolCallId, raw.find((step) => step.native.command === "click")!.id);
    const search = await f.request("tools/call", { name: "search_workflows", arguments: { query: "Browser task" } });
    assert.match(text(search), new RegExp(workflow.id));
    f.reorder();
    const replay = await f.request("tools/call", { name: "run_workflow", arguments: { id: workflow.id, inputs: { [input.name]: "Grace" } } });
    assert.equal(replay.isError, false, text(replay));
    const outcome = JSON.parse(text(replay)) as { status: string; runId: string; lastGreen: string };
    assert.equal(outcome.status, "ok", text(replay));
    assert.doesNotMatch(outcome.lastGreen, /Not replayed yet/);
    assert.equal(f.library.readRun(outcome.runId).status, "passed");
    assert.deepEqual(f.actions, [{ target: "chosen", name: "Ada" }, { target: "chosen", name: "Grace" }]);
    assert.equal(f.library.listRuns().filter((run) => run.kind !== "capture").length, 1);
    f.removeChosen();
    const missing = await f.request("tools/call", { name: "run_workflow", arguments: { id: workflow.id, inputs: { [input.name]: "Lin" } } });
    assert.equal((JSON.parse(text(missing)) as { status: string }).status, "failed", text(missing));
    assert.deepEqual(f.actions, [{ target: "chosen", name: "Ada" }, { target: "chosen", name: "Grace" }], "a missing recorded target must not click the remaining namesake");
    await passed(f, "close");
    assert.equal(f.library.list().workflows.length, 1, "repeated close does not save another workflow");
  } finally { await f.close(); }
});

test("selecting the active native tab preserves workflow eligibility", { skip: !binary, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    const tabs = await passed(f, "tab", ["list", "--json"]);
    const data = JSON.parse(tabs) as { data: { tabs: { tabId: string; active: boolean }[] } };
    const active = data.data.tabs.find((tab) => tab.active);
    assert.ok(active, tabs);
    await passed(f, "tab", [active.tabId]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    assert.equal(f.library.list().workflows.length, 1);
  } finally { await f.close(); }
});

test("harmless native failures preserve raw failed receipts and save only successful actions", { skip: !binary, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    assert.equal((await f.call("snapshot", ["-s", "#missing"])).isError, true);
    assert.equal((await f.call("click", ["#missing"])).isError, true);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    const workflow = f.library.list().workflows[0]!;
    assert.deepEqual(workflow.steps.map((step) => step.action), ["click"]);
    assert.equal(workflow.steps[0]!.identity?.testId, "chosen");
    const capture = f.library.listRuns()[0]!;
    assert.equal(capture.status, "failed");
    assert.equal((capture.steps as RecordedAgentBrowserCommand[]).filter((step) => step.native.isError).length, 2);
    await passed(f, "open", [f.url]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.equal((await f.call("click", ["#missing"])).isError, true);
    assert.match(await passed(f, "close"), /task ended with a failed action/);
    assert.equal(f.library.list().workflows.length, 1, "an unrecovered action failure must not publish a partial workflow");
  } finally { await f.close(); }
});

test("completed owner handoffs save workflows but unfinished waits do not", { skip: !binary, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    assert.match(await passed(f, "open", [f.url + "signin"]), /halted/);
    f.resumeOwner();
    assert.match(await passed(f, "wait_for_owner", ["5000"]), /ready/);
    await passed(f, "snapshot", ["-i"]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    const workflow = f.library.list().workflows[0]!;
    assert.deepEqual(workflow.steps.map((step) => step.action), ["click"]);
    f.resumeOwner(false);
    assert.match(await passed(f, "open", [f.url + "signin"]), /halted/);
    assert.match(await passed(f, "close"), /owner wait did not finish/);
    assert.equal(f.library.list().workflows.length, 1);
  } finally { await f.close(); }
});

test("finished native captures explain why unsupported actions cannot become workflows", { skip: !binary, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const seen = new Set<string>();
    for (const [command, args, reason] of [
      ["scroll", ["down", "100"], /stateful scroll/],
      ["tab", ["new", f.url], /second tab/],
      ["click", ["#plain"], /no durable target/],
      ["click", ["#popup"], /second tab or popup/],
    ] as const) {
      await passed(f, "open", [f.url]);
      await passed(f, command, [...args]);
      const closing = await passed(f, "close");
      assert.match(closing, /Not saved as a workflow:/);
      assert.match(closing, reason);
      assert.equal(f.library.list().workflows.length, 0);
      const capture = f.library.listRuns().find((run) => !seen.has(run.id))!;
      seen.add(capture.id);
      assert.equal(capture.status, "passed");
      const raw = capture.steps as RecordedAgentBrowserCommand[];
      assert.deepEqual(raw.find((step) => step.native.command === command)!.native.args, [...args]);
      const filename = path.join(f.home, "runs", `${capture.id}.json`);
      assert.ok((JSON.parse(await readFile(filename, "utf8")) as { steps: unknown[] }).steps.length > 0);
    }
    await passed(f, "open", [f.url]);
    const failure = await f.call("fill", []);
    assert.equal(failure.isError, true);
    assert.match(await passed(f, "close"), /Not saved as a workflow:/);
    assert.equal(f.library.list().workflows.length, 0);
    assert.equal(f.library.listRuns().find((run) => !seen.has(run.id))!.status, "failed");
  } finally { await f.close(); }
});

test("native UI closing results retain capture receipt ids beside the workflow notice", { skip: !binary, timeout: 60_000 }, async () => {
  const f = await fixture(true);
  try {
    await passed(f, "open", [f.url]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    const closing = await f.call("close");
    assert.equal(closing.isError, false, text(closing));
    assert.match(closing.content.at(-1)!.text!, /Saved workflow:/);
    const capture = f.library.listRuns()[0]!;
    assert.equal(closing.structuredContent?.command, "close");
    assert.equal(closing.structuredContent?.run_id, capture.id);
    assert.equal(closing.structuredContent?.step_id, (capture.steps as RecordedAgentBrowserCommand[]).at(-1)!.id);
    assert.equal(capture.workflowId, "agent-browser");
    assert.equal(f.library.list().workflows.length, 1);
  } finally { await f.close(); }
});

test("native disconnect finalizes the workflow without adding a close command to its capture", { skip: !binary, timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    await f.disconnect();
    const capture = f.library.listRuns()[0]!;
    assert.equal(capture.status, "passed");
    assert.equal((capture.steps as RecordedAgentBrowserCommand[]).at(-1)!.native.command, "click");
    assert.equal(f.library.list().workflows.length, 1);
  } finally { await f.close(); }
});
