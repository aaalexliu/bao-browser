import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome } from "../../src/launch";
import type { WorkflowOutcome } from "../../src/mcp/catalog";
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

describe("ordinary contenteditable recording", { timeout: 120_000 }, () => {
  const dirs = applyHermeticApp("live-contenteditable");
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>>;
  let app: Awaited<ReturnType<typeof startApp>>;
  let mcp: McpClient;
  let url: string;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const editors = req.url === "/plain"
      ? '<div contenteditable="plaintext-only">Seed</div>'
      : '<div contenteditable role="textbox" aria-label="Explicit editor"></div><div contenteditable aria-label="Roleless editor"></div>';
    res.end(`<title>Local editor</title><style>[contenteditable]{min-height:24px}</style><main oninput="document.querySelector('#result').textContent=event.target.textContent">${editors}</main><button onclick="this.textContent='Continue typing'">Pause typing</button><p id="result">Ready</p>`);
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
  });
});
