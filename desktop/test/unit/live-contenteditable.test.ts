import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { after, afterEach, before, describe } from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome } from "../../src/launch";
import type { WorkflowOutcome } from "../../src/mcp/catalog";
import { dumpPage } from "../../src/v1/dom-page";
import { applyHermeticApp, laneChildEnv } from "../runtime";

interface LiveReply {
  session: string;
  outcome: { kind: string };
  view: { controls: { ref: string; label: string }[] };
  read?: { text: string };
}

function ref(reply: LiveReply, label: string): string {
  const control = reply.view.controls.find((item) => item.label === label);
  assert.ok(control, `${label}: ${JSON.stringify(reply)}`);
  return control.ref;
}

describe("ordinary contenteditable recording", { timeout: 300_000 }, () => {
  const dirs = applyHermeticApp("live-contenteditable");
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>>;
  let app: Awaited<ReturnType<typeof startApp>>;
  let mcp: McpClient;
  let url: string;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/icons")) {
      const tag = req.url === "/icons-role" ? 'div role="button"' : "button";
      const close = req.url === "/icons-role" ? "div" : "button";
      res.end(`<title>Icon controls</title><style>#icon{width:40px;height:40px}</style><${tag} id="icon" onclick="document.querySelector('#result').textContent='Original clicked'"><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg></${close}><p id="result">Ready</p>`);
      return;
    }
    const editors = req.url === "/plain"
      ? '<div contenteditable="plaintext-only">Seed</div>'
      : '<div contenteditable role="textbox" aria-label="Explicit editor"></div><div contenteditable aria-label="Roleless editor"></div>';
    const content = req.url === "/search-editor" ? `<form role="search">${editors}</form>` : editors;
    res.end(`<title>Local editor</title><style>[contenteditable]{min-height:24px;white-space:pre-wrap}</style><main oninput="document.querySelector('#result').textContent=event.target.textContent">${content}</main><button onclick="this.textContent='Continue typing'">Pause typing</button><p id="result">Ready</p>`);
  });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
    app = await startApp({ home: dirs.home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(dirs.home, "lock") });
    const pinned = process.env.BAO_TEST_BROWSER;
    mcp = McpClient.start({ ...laneChildEnv("hermetic", process.env, () => pinned ?? chromium.executablePath()), HOME: dirs.nativeHostHome, BAO_HOME: dirs.home });
    await mcp.handshake();
  });
  afterEach(async () => { await mcp?.call("live_stop", {}); });
  after(async () => {
    await mcp?.close();
    await app?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<LiveReply> {
    const result = await mcp.call(name, args);
    assert.equal(result.isError, false, result.text);
    const reply = JSON.parse(result.text) as LiveReply;
    assert.equal(reply.outcome.kind, name === "live_stop" ? "stopped" : "applied", result.text);
    return reply;
  }

  for (const careful of [false, true]) {
    for (const label of ["Explicit editor", "Roleless editor"]) {
      for (const separator of ["Tab", "click"]) {
        test(`MCP saves and replays ${label} after ${separator}, careful=${careful}`, async () => {
          let reply = await call("live_session_start", { intent: `Edit ${label} after ${separator} ${careful}`, careful, url });
          const session = reply.session;
          reply = await call("live_type", { ref: ref(reply, label), text: "alpha" });
          reply = separator === "Tab"
            ? await call("live_key", { ref: ref(reply, label), key: "Tab" })
            : await call("live_click", { ref: ref(reply, "Pause typing") });
          reply = await call("live_type", { ref: ref(reply, label), text: "beta" });
          const read = await call("live_read", { name: "result", selector: "#result" });
          const actual = read.read!.text;
          assert.ok(actual === "alphabeta" || actual === "betaalpha", actual);
          await call("live_stop");

          const workflow = app.library.read(session);
          const typed = workflow.steps.filter((step) => step.action === "type");
          assert.equal(typed.length, 2);
          assert.deepEqual(typed.map((step) => workflow.inputs.find((input) => input.name === step.input)?.default), ["alpha", actual]);
          assert.deepEqual(workflow.steps.map((step) => step.action), ["type", separator === "Tab" ? "key" : "click", "type", "extract"]);
          for (const step of typed) {
            assert.equal(step.identity?.tag, "div");
            assert.ok(step.identity?.cssPath);
            assert.ok(step.locators?.some((locator) => locator.kind === "css" && locator.value === step.identity!.cssPath));
          }
          const trail = readFileSync(path.join(dirs.home, "live-session", "trail.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { op: string; value?: string });
          assert.deepEqual(trail.filter((event) => event.op === "type").map((event) => event.value), ["alpha", actual]);

          const result = await mcp.call("run_workflow", { id: session });
          assert.equal(result.isError, false, result.text);
          const replay = JSON.parse(result.text) as WorkflowOutcome;
          assert.equal(replay.outcome, "ok", result.text);
          const output = replay.outputs?.[0];
          assert.equal(output?.type === "table" ? output.rows[0]?.text : undefined, actual);
          const run = app.library.readRun(replay.runId!);
          assert.equal(run.status, "passed");
          assert.equal(run.modelCalls, 0);
        });
      }
    }
  }

  for (const route of ["/icons", "/icons-role"]) {
  test(`default unnamed icon click saves and replays through guarded replay: ${route}`, async () => {
    let reply = await call("live_session_start", { intent: "Click an icon", url: url + route });
    const session = reply.session;
    reply = await call("live_click", { ref: ref(reply, "") });
    assert.equal((await call("live_read", { name: "result", selector: "#result" })).read!.text, "Original clicked");
    await call("live_stop");
    const result = await mcp.call("run_workflow", { id: session });
    assert.equal(result.isError, false, result.text);
    const replay = JSON.parse(result.text) as WorkflowOutcome;
    assert.equal(replay.outcome, "ok", result.text);
    assert.equal(app.library.readRun(replay.runId!).modelCalls, 0);
    assert.equal(replay.outputs?.[0]?.type === "table" ? replay.outputs[0].rows[0]?.text : undefined, "Original clicked");
  });

  for (const mutation of ["insert", "replace", "reload"] as const) {
    test(`default unnamed ref refuses a DOM ${mutation} before click: ${route}`, async () => {
      const reply = await call("live_session_start", { intent: "Check icon identity", url: url + route });
      const old = ref(reply, "");
      const page = browser.pages().find((page) => page.url() === url + route)!;
      if (mutation === "reload") await page.reload();
      else await page.evaluate((mutation) => {
        const original = document.querySelector("#icon")!;
        const other = original.cloneNode(true) as HTMLButtonElement;
        other.id = "other";
        other.onclick = () => { document.querySelector("#result")!.textContent = "Wrong clicked"; };
        if (mutation === "insert") original.before(other); else original.replaceWith(other);
      }, mutation);
      const result = await mcp.call("live_click", { ref: old });
      assert.equal(result.isError, true, result.text);
      assert.deepEqual(JSON.parse(result.text).outcome, { kind: "refused", reason: "stale_ref" });
      assert.equal(await page.locator("#result").innerText(), "Ready");
      await call("live_stop");
    });
  }

  test(`careful snapshots omit unnamed controls: ${route}`, async () => {
    const reply = await call("live_session_start", { intent: "Careful unnamed view", careful: true, url: url + route });
    assert.equal(reply.view.controls.length, 0);
    await call("live_stop");
  });
  }

  for (const careful of [false, true]) {
    for (const label of ["Explicit editor", "Roleless editor"]) {
      for (const value of ["hello\nworld", "hello ", "x".repeat(80), "Enter-separated"]) {
        test(`exact editor replay ${label}, ${JSON.stringify(value)}, careful=${careful}`, async () => {
          const startUrl = url + (value === "Enter-separated" ? "/search-editor" : "/");
          let reply = await call("live_session_start", { intent: `Exact editor ${label} ${careful}`, careful, url: startUrl });
          const session = reply.session;
          reply = await call("live_type", { ref: ref(reply, label), text: value === "Enter-separated" ? "hello" : value });
          if (value === "Enter-separated") {
            reply = await call("live_key", { ref: ref(reply, label), key: "Enter" });
            reply = await call("live_type", { ref: ref(reply, label), text: "world" });
          }
          const page = browser.pages().find((page) => page.url() === startUrl)!;
          const actual = await page.locator(`[aria-label="${label}"]`).innerText();
          assert.equal(actual, value === "Enter-separated" ? "hello\nworld" : value);
          const dump = await page.evaluate(dumpPage);
          const node = dump.nodes.find((node) => node.label === label)!;
          await call("live_stop");
          const workflow = app.library.read(session);
          const last = workflow.steps.filter((step) => step.action === "type").at(-1)!;
          assert.equal(last.input ? workflow.inputs.find((input) => input.name === last.input)?.default : last.value, actual);
          const result = await mcp.call("run_workflow", { id: session });
          assert.equal(result.isError, false, result.text);
          const replay = JSON.parse(result.text) as WorkflowOutcome;
          assert.equal(replay.outcome, "ok", result.text);
          assert.equal(app.library.readRun(replay.runId!).modelCalls, 0);
          assert.equal(node.value, actual);
          assert.equal(dump.values.find((item) => item.handle === node.handle)?.value, actual);
        });
      }
    }
  }

  test("careful typing still refuses values beyond 80 characters", async () => {
    const reply = await call("live_session_start", { intent: "Keep careful length limit", careful: true, url });
    const result = await mcp.call("live_type", { ref: ref(reply, "Explicit editor"), text: "x".repeat(81) });
    assert.equal(result.isError, true, result.text);
    assert.equal(JSON.parse(result.text).outcome.kind, "refused");
    const page = browser.pages().find((page) => page.url() === url + "/")!;
    assert.equal(await page.locator('[aria-label="Explicit editor"]').innerText(), "");
    await call("live_stop");
  });

  test("MCP records the full prefilled role-less plaintext editor beyond 2000 characters", async () => {
    let reply = await call("live_session_start", { intent: "Record a full ordinary editor", url: url + "/plain" });
    const session = reply.session;
    reply = await call("live_type", { ref: reply.view.controls[0]!.ref, text: "entry".repeat(450) });
    const first = await call("live_read", { name: "first", selector: "#result" });
    reply = await call("live_key", { ref: first.view.controls[0]!.ref, key: "Tab" });
    reply = await call("live_type", { ref: reply.view.controls[0]!.ref, text: "tail" });
    const last = await call("live_read", { name: "last", selector: "#result" });
    assert.ok(first.read!.text.includes("Seed"));
    assert.ok(first.read!.text.includes("entry".repeat(450)));
    assert.equal(last.read!.text.replace("tail", ""), first.read!.text);
    await call("live_stop");
    const workflow = app.library.read(session);
    const typed = workflow.steps.filter((step) => step.action === "type");
    assert.deepEqual(typed.map((step) => workflow.inputs.find((input) => input.name === step.input)?.default), [first.read!.text, last.read!.text]);
    assert.ok(typed.every((step) => !!step.identity?.cssPath));
    const result = await mcp.call("run_workflow", { id: session });
    assert.equal(result.isError, false, result.text);
    const replay = JSON.parse(result.text) as WorkflowOutcome;
    assert.equal(replay.outcome, "failed", result.text);
    assert.match(result.text, /cdp-live refused that text/);
    assert.equal(app.library.readRun(replay.runId!).modelCalls, 0);
  });

  test("raw DOM values retain long explicit-role and role-less editors", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      const raw = "long\n" + "x".repeat(2000) + " ";
      await page.locator("[contenteditable]").evaluateAll((editors, raw) => {
        for (const editor of editors) (editor as HTMLElement).innerText = raw;
      }, raw);
      const dump = await page.evaluate(dumpPage);
      for (const label of ["Explicit editor", "Roleless editor"]) {
        const node = dump.nodes.find((node) => node.label === label)!;
        assert.equal(node.value, raw);
        assert.equal(dump.values.find((item) => item.handle === node.handle)?.value, raw);
      }
    } finally { await page.close(); }
  });
});
