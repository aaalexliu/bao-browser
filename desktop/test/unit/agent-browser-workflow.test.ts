import { stepTarget, locatorValue, stepCheck, stepLocators } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { baoDriver, snapshotRefs } from "../helpers/driver";
import { baoFixtureEnv, syntheticChromeProfile } from "../helpers/fixtures";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Library } from "../../src/v1/store";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { UI_EXTENSION, VIEWER_MIME } from "../../src/mcp/viewer";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { launchOwnedChrome } from "../../src/launch";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
import { replayRefusal, CDP_LIVE_SERVER_REFUSAL } from "../../src/cdp-live/launch-guard";
import { scaledMs } from "../runtime";

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
const STATEMENT = "%PDF-1.4 synthetic statement";
const VIEWED = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
interface Result { content: { type: string; text?: string }[]; isError: boolean; structuredContent?: { command: string; run_id: string; step_id: string } }
const text = (result: Result) => result.content.map((item) => item.text || "").join("\n");

async function fixture(ui = false) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-workflow-"));
  const home = path.join(root, "library");
  const source = path.join(root, "source");
  await syntheticChromeProfile(source, { name: "Synthetic groceries" });
  const actions: { target: string; name: string }[] = [];
  const uploads: { name: string; body: string }[] = [];
  let reordered = false;
  let missing = false;
  let ownerReady = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/unnamed") {
      res.end(`<!doctype html><title>Account room</title><h1>Account room</h1><button id="continue">Continue</button> <button id="unnamed" style="width:36px;height:20px" onclick="document.querySelector('#result').textContent='Done'"></button><p id="result">Ready</p>`);
      return;
    }
    if (url.pathname === "/checkbox") {
      res.end(`<!doctype html><title>Preferences</title><h1>Preferences</h1><input type="checkbox" style="display:block;margin:24px 0 0 24px;width:16px;height:16px">`);
      return;
    }
    if (url.pathname === "/stores") {
      const content = url.searchParams.has("interactive")
        ? '<button data-testid="store-button" onclick="document.querySelector(\'#selected\').textContent=\'Selected B\'"><span id="store-b">Store B</span></button>'
        : '<div onclick="document.querySelector(\'#selected\').textContent=\'Selected A\'">Store A</div><div id="store-b" onclick="document.querySelector(\'#selected\').textContent=\'Selected B\'">Store B</div>';
      const container = url.searchParams.has("testid") ? 'data-testid="stores"' : 'role="dialog" aria-label="Choose a store"';
      res.end(`<!doctype html><title>Stores</title><div ${container}>${content}</div><p id="selected">No store selected</p>`);
      return;
    }
    if (url.pathname === "/statement.pdf" || url.pathname === "/view.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", ...url.pathname === "/statement.pdf" ? { "content-disposition": "attachment; filename=server-name.pdf" } : {} });
      res.end(url.pathname === "/view.pdf" ? VIEWED : STATEMENT);
      return;
    }
    if (url.pathname === "/uploaded") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => { uploads.push({ name: url.searchParams.get("name")!, body }); res.end("ok"); });
      return;
    }
    if (url.pathname === "/files") {
      res.end(`<!doctype html><title>Statements</title><a id="dl" href="/statement.pdf" download>Get statement</a>
        <a id="newtab" href="/view.pdf" target="_blank">October statement</a> <a id="same" href="/view.pdf">View statement</a>
        <button onclick="document.querySelector('#hidden').click()">Upload Statement</button>
        <input id="hidden" type="file" accept="application/pdf" style="display:none" onchange="const f=this.files[0];f.text().then(t=>fetch('/uploaded?name='+encodeURIComponent(f.name),{method:'POST',body:t}))">`);
      return;
    }
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
      <label>Name <input id="name" oninput="document.querySelector('#count').textContent=this.value.length+' results'" onkeydown="if(event.key==='Enter')document.querySelector('#result').textContent='Ready '+this.value"></label>
      <p id="count">0 results</p>
      ${reordered ? button("chosen") + button("wrong") : button("wrong") + button("chosen")}
      <p id="result">Not added</p><button id="popup" onclick="window.open('/other')">Open popup</button><div id="plain" onclick="this.textContent='Clicked plain'">Plain action</div><div style="height:3000px">Page end</div>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const driver = baoDriver<Result>({
    ...baoFixtureEnv({ user: root, library: home, profiles: source }),
    BAO_AGENT_BROWSER: binary,
  });
  const { request } = driver;
  // Like an agent, the fixture sends back the run id from its latest agent_browser result.
  let run: string | undefined;
  const call = async (command: string, args: string[] = []) => {
    const result = await driver.tool("agent_browser", { command, args, ...(command === "open" ? { browser: "copy" } : {}),
      ...(run ? { run_id: run } : {}) });
    run = result.structuredContent?.run_id ?? result.content.map((block) => /^Run (\S+)(?: · \w+)?$/.exec(block.text ?? "")?.[1]).find(Boolean) ?? run;
    return result;
  };
  await driver.initialize(ui ? { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } } } : {});
  return {
    root, home, url, actions, uploads, call, request, library: new Library(home),
    reorder() { reordered = true; },
    removeChosen() { missing = true; },
    resumeOwner(ready = true) { ownerReady = ready; },
    async closeWindow() {
      const namespace = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 20);
      const copies = path.join(tmpdir(), `bao-profile-copies-${namespace}`);
      const [copy] = await readdir(copies);
      assert.ok(copy);
      const endpoint = await readDevToolsActivePort(path.join(copies, copy, "DevToolsActivePort"));
      const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
      try { await cdp.send("Browser.close"); }
      finally { cdp.close(); }
    },
    disconnect: driver.close,
    async close() {
      await call("close").catch(() => undefined);
      await driver.close();
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

test("a failed action with only viewport movement stays saveable after retry", { timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const profile = path.join(f.root, "effect-profile");
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  try {
    const page = context.pages()[0]!;
    const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const workflow = new AgentBrowserWorkflow(f.home, "run-viewport", async () => ({
      ...endpoint, targetId: targetInfo.targetId, targetIds: [targetInfo.targetId],
    }));
    const success = { stdout: "", stderr: "", exitCode: 0 };
    await workflow.record("open", [f.url], "open", async () => {
      await page.goto(f.url);
      return success;
    }, () => false);
    const target = page.locator('[data-testid="chosen"]');
    const before = await target.boundingBox();
    await workflow.record("click", ["#missing"], "failed", async () => {
      await page.evaluate(() => window.scrollTo(0, 600));
      return { stdout: "", stderr: "Target not found", exitCode: 1 };
    }, () => false);
    const after = await target.boundingBox();
    assert.ok(before && after);
    assert.notEqual(after.y, before.y, "the failed action changed viewport geometry");
    await workflow.record("click", ['[data-testid="chosen"]'], "retry", async () => {
      await target.click();
      return success;
    }, () => false);
    assert.match(workflow.finish(), /Saved workflow:/);
    const saved = f.library.list().workflows[0]!;
    assert.deepEqual(saved.steps.map((step) => step.action), ["click"]);
    assert.equal(locatorValue(stepTarget(saved.steps[0]), "testid"), "chosen");
  } finally {
    await context.close();
    await f.close();
  }
});

test("an unnamed recorded click keeps the plain caption", { timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const profile = path.join(f.root, "unnamed-profile");
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  try {
    const page = context.pages()[0]!;
    const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const workflow = new AgentBrowserWorkflow(f.home, "run-unnamed", async () => ({
      ...endpoint, targetId: targetInfo.targetId, targetIds: [targetInfo.targetId],
    }));
    const success = { stdout: "", stderr: "", exitCode: 0 };
    await workflow.record("open", [f.url + "unnamed"], "open", async () => {
      await page.goto(f.url + "unnamed");
      return success;
    }, () => false);
    await workflow.record("click", ["#unnamed"], "click", async () => {
      await page.locator("#unnamed").click();
      return success;
    }, () => false);
    assert.match(workflow.finish(), /Saved workflow:/);
    const saved = f.library.list().workflows[0]!;
    assert.equal(saved.steps[0]!.caption.text, "Click the button");
    assert.equal(saved.steps[0]!.caption.citation, undefined);
    assert.equal(locatorValue(stepTarget(saved.steps[0]), "css"), "#unnamed");
    assert.equal((stepLocators(saved.steps[0]) ?? []).some((locator) => locator.kind === "anchor"), false);
    assert.equal(await page.locator("#result").innerText(), "Done");
  } finally {
    await context.close();
    await f.close();
  }
});

test("an unnamed checkbox with only a nearby anchor is not saved", { timeout: scaledMs(30_000) }, async () => {
  const f = await fixture();
  const profile = path.join(f.root, "checkbox-profile");
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  try {
    const page = context.pages()[0]!;
    const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const workflow = new AgentBrowserWorkflow(f.home, "run-checkbox", async () => ({
      ...endpoint, targetId: targetInfo.targetId, targetIds: [targetInfo.targetId],
    }));
    const success = { stdout: "", stderr: "", exitCode: 0 };
    const box = page.locator('input[type="checkbox"]');
    await workflow.record("open", [f.url + "checkbox"], "open", async () => {
      await page.goto(f.url + "checkbox");
      return success;
    }, () => false);
    await workflow.record("click", ["input[type=checkbox]"], "click", async () => {
      await box.click();
      return success;
    }, () => false);
    assert.equal(await box.isChecked(), true);
    assert.match(workflow.finish(), /an action had no durable target/);
    assert.equal(f.library.list().workflows.length, 0);
  } finally {
    await context.close();
    await f.close();
  }
});

test("native ref capture saves a discoverable workflow that replays with new inputs after DOM reordering", { skip: !binary, timeout: scaledMs(120_000) }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    await passed(f, "open", [f.url + "?groceries"]);
    const snapshot = await passed(f, "snapshot", ["-i"]);
    const [field] = snapshotRefs(snapshot, /textbox "Name\s*"/);
    const buttons = snapshotRefs(snapshot, /button "Add blueberries"/);
    assert.ok(field, snapshot);
    assert.equal(buttons.length, 2, snapshot);
    await passed(f, "fill", [`@${field}`, "Ada"]);
    await passed(f, "press", ["Enter"]);
    await passed(f, "click", [`@${buttons[1]!}`]);
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
    assert.equal(locatorValue(stepTarget(clicked), "testid"), "chosen");
    assert.ok(stepLocators(clicked)?.some((locator) => locator.kind === "testid" && locator.value === "chosen"));
    assert.doesNotMatch(JSON.stringify(workflow), /@e\d+|data-bao-i|nth-of-type/);
    const input = workflow.inputs[0]!;
    assert.equal(input.default, "Ada");
    const capture = f.library.listRuns()[0]!;
    assert.equal(capture.kind, "capture");
    assert.equal(capture.workflowId, "agent-browser");
    assert.equal(capture.status, "passed");
    const raw = capture.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(raw.find((step) => step.native.command === "click")!.native.args, [`@${buttons[1]!}`]);
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

test("native clicks never substitute a structural ancestor for an unaddressable target", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
  const f = await fixture();
  try {
    for (const suffix of ["stores", "stores?testid"]) {
      await passed(f, "open", [f.url + suffix]);
      await passed(f, "click", ["#store-b"]);
      assert.match(await passed(f, "snapshot"), /Selected B/);
      assert.match(await passed(f, "close"), /an action had no durable target/);
      assert.equal(f.library.list().workflows.length, 0);
    }
    await passed(f, "open", [f.url + "stores?interactive"]);
    await passed(f, "click", ["#store-b"]);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    const workflow = f.library.list().workflows[0]!;
    assert.equal(locatorValue(stepTarget(workflow.steps[0]), "testid"), "store-button");
    const replay = await f.request("tools/call", { name: "run_workflow", arguments: { id: workflow.id } });
    assert.equal((JSON.parse(text(replay)) as { status: string }).status, "ok", text(replay));
  } finally { await f.close(); }
});

test("a locator-less element postcondition fails the save", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-element-check-"));
  try {
    const workflow = interpret([{
      id: "expect",
      ts: 1,
      kind: "act",
      op: "verify",
      performed: false,
      identity: { surface: "dom", role: "button", path: [] },
    }], { id: "wf-element", name: "Element check", startUrl: "https://example.test/" });
    const step = workflow.steps[0];
    assert.ok(step);
    assert.equal(step.action, "verify");
    const check = stepCheck(step);
    assert.equal(check?.kind, "element");
    assert.equal(check && "locators" in check ? check.locators.length : 1, 0);
    assert.throws(() => new Library(home).save(workflow), /check /);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("trial replay accepts only an explicit playwright driver and still refuses retired drivers", () => {
  for (const extensionLinked of [false, true]) {
    const context = { extensionLinked, pageEngine: "agent-browser" as const };
    assert.equal(replayRefusal("playwright", context), null);
    for (const driver of [undefined, null, "extension"]) {
      assert.equal(replayRefusal(driver, context), "pass-through sessions do not support saved workflow replay");
    }
    assert.equal(replayRefusal("cdp-live", context), CDP_LIVE_SERVER_REFUSAL);
  }
});

test("trial engine finds and replays a saved search fill with a different result count", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
  const f = await fixture();
  try {
    f.library.updateSettings({ pageEngine: "agent-browser", chromeProfile: "Default" });
    await passed(f, "open", [f.url]);
    await passed(f, "fill", ["#name", "Ada"]);
    assert.match(await passed(f, "snapshot"), /3 results/);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    const workflow = f.library.list().workflows[0]!;
    assert.equal(workflow.driver, "playwright");
    const input = workflow.inputs[0]!;
    const condition = stepCheck(workflow.steps[0]!);
    assert.ok(condition?.kind === "value");
    assert.equal(condition.match, `{{${input.name}}}`);
    const search = await f.request("tools/call", { name: "search_workflows", arguments: { query: "Browser task" } });
    assert.match(text(search), new RegExp(workflow.id));
    const replay = await f.request("tools/call", { name: "run_workflow", arguments: { id: workflow.id, inputs: { [input.name]: "Grace" } } });
    assert.equal((JSON.parse(text(replay)) as { status: string }).status, "ok", text(replay));
    const run = f.library.listRuns().find((run) => run.kind !== "capture")!;
    assert.equal(run.status, "passed");
    assert.equal(run.inputs?.[input.name], "Grace");
    assert.equal(f.library.settings().pageEngine, "agent-browser");
  } finally { await f.close(); }
});

test("selecting the active native tab preserves workflow eligibility", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    const listed = await f.call("tab", ["list", "--json"]);
    assert.equal(listed.isError, false, text(listed));
    assert.match(listed.content[1]!.text!, /^Run run-/);
    const tabs = listed.content[2]!.text!;
    const data = JSON.parse(tabs) as { data: { tabs: { tabId: string; active: boolean }[] } };
    const active = data.data.tabs.find((tab) => tab.active);
    assert.ok(active, tabs);
    await passed(f, "tab", [active.tabId]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    assert.equal(f.library.list().workflows.length, 1);
  } finally { await f.close(); }
});

test("harmless native failures preserve raw failed receipts and save only successful actions", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    assert.equal((await f.call("snapshot", ["-s", "#missing"])).isError, true);
    assert.equal((await f.call("click", ["#missing"])).isError, true);
    await passed(f, "click", ['[data-testid="chosen"]']);
    assert.match(await passed(f, "close"), /Saved workflow:/);
    const workflow = f.library.list().workflows[0]!;
    assert.deepEqual(workflow.steps.map((step) => step.action), ["click"]);
    assert.equal(locatorValue(stepTarget(workflow.steps[0]), "testid"), "chosen");
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

test("completed owner handoffs save workflows but unfinished waits do not", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
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

test("finished native captures explain why unsupported actions cannot become workflows", { skip: !binary, timeout: scaledMs(120_000) }, async () => {
  const f = await fixture();
  try {
    const seen = new Set<string>();
    for (const [command, args, reason] of [
      ["scroll", ["down", "100"], /: it scrolled the page, which Bao cannot replay yet\./],
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

test("on a copy the agent downloads a file or a PDF Chrome shows, and uploads it through the page's upload button", { skip: !binary, timeout: scaledMs(120_000) }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [`${f.url}files`]);
    const downloaded = await passed(f, "download", ["#dl", "statement.pdf"]);
    const saved = /Bao saved the file at (.+)\.$/m.exec(downloaded)?.[1];
    assert.ok(saved, downloaded);
    assert.equal(path.dirname(path.dirname(saved)), path.join(f.home, "downloads"));
    assert.equal(path.basename(saved), "statement.pdf", "the agent's name wins over the server's");
    assert.match(downloaded, /Download saved to .+statement\.pdf/);
    assert.equal(await readFile(saved, "utf8"), STATEMENT);

    const [ref] = snapshotRefs(await passed(f, "snapshot", ["-i"]), /button "Upload Statement"/);
    assert.ok(ref, "the snapshot lists the upload button but not its hidden input");
    assert.match(await passed(f, "upload", [`@${ref}`, "statement.pdf"]), /file chooser the click opened/);
    const until = Date.now() + scaledMs(5000);
    while (!f.uploads.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(f.uploads, [{ name: "statement.pdf", body: STATEMENT }], "the page read the downloaded bytes from the input behind its button");

    const folder = path.dirname(saved);
    assert.match(await passed(f, "download", ["#newtab", "october.pdf"]), /in a new tab, which Bao closed/);
    assert.equal(await readFile(path.join(folder, "october.pdf"), "utf8"), VIEWED);
    assert.match(await passed(f, "snapshot", ["-i"]), /Upload Statement/, "the agent is back on its page after Bao closed the viewer tab");
    assert.match(await passed(f, "download", ["#same", "viewed.pdf"]), /in this tab, which still shows it/);
    assert.equal(await readFile(path.join(folder, "viewed.pdf"), "utf8"), VIEWED);

    assert.match(await passed(f, "close"), /Not saved as a workflow: command-2 \(download\): it moved a file, which Bao cannot replay yet\./);
    const capture = f.library.listRuns()[0]!;
    const steps = capture.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(steps.find((step) => step.native.command === "download")!.native.args, ["#dl", saved], "the run keeps the real argv, full path included");
    assert.equal(steps.find((step) => step.native.command === "upload")!.caption.text, "Upload statement.pdf");
  } finally { await f.close(); }
});

test("native UI closing results retain capture receipt ids beside the workflow notice", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
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

test("owner window close keeps an unfinished native task capture-only", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
  const f = await fixture();
  try {
    await passed(f, "open", [f.url]);
    await passed(f, "click", ['[data-testid="chosen"]']);
    await f.closeWindow();
    const deadline = Date.now() + scaledMs(5000);
    while (f.library.listRuns()[0]?.status === "recording" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(f.library.listRuns()[0]!.status, "passed", "the raw capture receipt stays unchanged");
    await f.disconnect();
    assert.equal(f.library.list().workflows.length, 0, "an owner interruption must not publish partial steps");
    const commands = f.library.listRuns()[0]!.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(commands.map((step) => step.native.command), ["open", "click"]);
  } finally { await f.close(); }
});

test("native disconnect finalizes the workflow without adding a close command to its capture", { skip: !binary, timeout: scaledMs(60_000) }, async () => {
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
