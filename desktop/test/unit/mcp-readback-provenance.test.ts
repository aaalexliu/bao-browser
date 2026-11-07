import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { frameRpc, takeRpcChunk } from "../../src/mcp/frame";
import { inspectRunView } from "../../src/mcp/run-view";
import { UI_EXTENSION, VIEWER_MIME } from "../../src/mcp/viewer";
import { STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { verifyReceiptChain, type Receipt } from "../../src/v1/receipt";
import type { WorkflowV2 } from "../../src/v1/schema";
import { laneChildEnv } from "../runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isFixtureReceipt(value: unknown): value is Receipt {
  return isRecord(value) && value.kind === "read-back" && (value.source === "text" || value.source === "value")
    && typeof value.ts === "number" && typeof value.runId === "string" && typeof value.workflowId === "string" && typeof value.stepId === "string"
    && typeof value.expected === "string" && typeof value.actual === "string" && typeof value.pass === "boolean"
    && typeof value.prev === "string" && typeof value.hash === "string";
}

function assertChain(value: unknown): void {
  assert.ok(Array.isArray(value) && value.length > 0 && value.every(isFixtureReceipt));
  assert.equal(verifyReceiptChain(value), true);
}

function mcp() {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "mcp"], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = Buffer.alloc(0), nextId = 0, stderr = "";
  child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-8192); });
  child.stdout.on("data", (bytes: Buffer) => {
    buffer = Buffer.concat([buffer, bytes]);
    while (true) {
      const chunk = takeRpcChunk(buffer, null);
      if (!chunk) break;
      buffer = Buffer.from(chunk.rest);
      const message: unknown = JSON.parse(chunk.body);
      if (!isRecord(message) || typeof message.id !== "number") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${method}: ${stderr}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(frameRpc({ jsonrpc: "2.0", id, method, params }, "json"));
    });
  }
  return {
    async initialize() {
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } }, clientInfo: { name: "readback-test", version: "1" } });
      child.stdin.write(frameRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "json"));
    },
    async views(runId: string) {
      const getRun = object(await request("tools/call", { name: "get_run", arguments: { run_id: runId } }));
      const inspect = object(await request("tools/call", { name: "inspect_run", arguments: { run_id: runId } }));
      assert.equal(getRun.isError, false);
      assert.equal(inspect.isError, false);
      const viewer = object(object(inspect._meta).baoViewer);
      assert.deepEqual(object(getRun._meta).baoViewer, viewer);
      const content = inspect.content;
      assert.ok(Array.isArray(content));
      assert.equal(object(content[0]).text, JSON.stringify(viewer));
      return JSON.stringify(viewer);
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
      await exited;
      clearTimeout(timer);
    },
  };
}

async function fixture(t: test.TestContext) {
  const before = { ...process.env };
  const home = mkdtempSync(path.join(tmpdir(), "bao-readback-provenance-"));
  const cache = before.PLAYWRIGHT_BROWSERS_PATH || path.join(before.HOME || "", "Library/Caches/ms-playwright");
  const browser = before.BAO_TEST_BROWSER || chromium.executablePath();
  const env = laneChildEnv("hermetic", { ...before, PLAYWRIGHT_BROWSERS_PATH: cache });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, { HOME: home, BAO_HOME: path.join(home, "library"), BAO_AGENT_BROWSER_PROFILE_ROOT: path.join(home, "profiles"), BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_TEST_BROWSER: browser });
  mkdirSync(process.env.BAO_AGENT_BROWSER_PROFILE_ROOT!);
  const typed: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/typed?")) {
      typed.push(new URL(req.url, "http://127.0.0.1").searchParams.get("value") || "");
      res.writeHead(204).end();
      return;
    }
    res.setHeader("content-type", "text/html");
    const inputType = req.url?.startsWith("/secret") ? "password" : "text";
    res.end(`<!doctype html><label>Entry<input id="entry" type="${inputType}" oninput="document.querySelector('#entry-echo').textContent=this.value;fetch('/typed?value='+encodeURIComponent(this.value))"></label><p id="entry-echo"></p><label>Note<input id="note" oninput="document.querySelector('#note-echo').textContent=this.value"></label><p id="note-echo"></p><p>Ready</p>`);
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let rpc: ReturnType<typeof mcp> | undefined;
  t.after(async () => {
    await rpc?.close();
    await app?.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const running = app = await startApp({ home: path.join(home, "library"), port: 0, extensionHost: false, chromeUserData: path.join(home, "profiles") });
  running.library.updateSettings({ pageEngine: "old" });
  rpc = mcp();
  await rpc.initialize();
  return {
    app: running, rpc, typed,
    async run(id: string, secret: boolean, value: string, readSource: "text" | "value" = "text") {
      const workflow: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, id, name: "Read-back provenance", createdAt: 1, driver: "playwright", startUrl: `http://127.0.0.1:${address.port}/${secret && readSource === "text" ? "secret" : "ordinary"}`,
        inputs: [{ name: "entry", type: secret ? "secret" : "text" }, { name: "note", type: "text" }],
        steps: ["entry", "note"].map((name, index) => ({
          id: name, index, action: "type", label: `Fill ${name}`, surface: "dom", timeoutMs: 2000, heal: "never", input: name, value: `{{${name}}}`,
          identity: { surface: "dom", role: "textbox", id: name, inputType: name === "entry" && secret && readSource === "text" ? "password" : "text", path: [] }, locators: [{ kind: "css", value: `#${name}` }],
          postcondition: { kind: "text", match: "Ready", timeoutMs: 2000 }, readBack: { source: name === "entry" ? readSource : "text", match: `{{${name}}}`, timeoutMs: 2000 },
        })),
      };
      running.library.save(workflow);
      const response = await fetch(`http://127.0.0.1:${running.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, args: { entry: value, note: "Safe ordinary note" } }) });
      const raw: unknown = await response.json();
      const outcome = object(raw);
      assert.equal(response.ok, true, JSON.stringify(outcome));
      assert.equal(outcome.status, "passed", JSON.stringify(outcome));
      assert.equal(typeof outcome.runId, "string");
      const run = running.library.readRun(String(outcome.runId));
      assert.equal(run.modelCalls, 0);
      assertChain(run.receipts);
      assert.equal(run.inputs?.entry, value);
      const file = path.join(running.library.root, "runs", `${run.id}.json`);
      return { workflow, run, file };
    },
  };
}

async function assertViews(f: Awaited<ReturnType<typeof fixture>>, runId: string, value: string, hidden: boolean) {
  const file = path.join(f.app.library.root, "runs", `${runId}.json`);
  const original = readFileSync(file);
  const local = inspectRunView(f.app.library, { run_id: runId });
  assert.ok(local.steps[0]?.result?.includes(value.slice(0, 500)));
  const response = await fetch(`http://127.0.0.1:${f.app.port}/api/runs/${runId}/receipt`);
  const localApi: unknown = await response.json();
  assert.equal(JSON.stringify(localApi), JSON.stringify(local));
  const outbound = await f.rpc.views(runId);
  assert.equal(outbound.includes(value.slice(0, 100)), !hidden);
  assert.equal(outbound.includes(STRIPPED_SECRET), hidden);
  assert.ok(outbound.includes("Safe ordinary note"));
  assert.deepEqual(readFileSync(file), original);
  assertChain(f.app.library.readRun(runId).receipts);
  assert.ok(f.typed.includes(value));
}

test("new run secret names survive workflow edits/deletion and explicit empty provenance stays authoritative", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const value = `Retained-local-readback-${"s".repeat(600)}`;
  const saved = await f.run("new-provenance", true, value, "value");
  assert.deepEqual(saved.run.secretInputNames, ["entry"]);
  f.app.library.save({ ...saved.workflow, inputs: saved.workflow.inputs.map((input) => ({ ...input, type: "text" })) });
  await assertViews(f, saved.run.id, value, true);
  f.app.library.remove(saved.workflow.id);
  await assertViews(f, saved.run.id, value, true);
  const ordinary = await f.run("explicit-empty-provenance", false, "Ordinary entry retained");
  assert.deepEqual(ordinary.run.secretInputNames, []);
  f.app.library.save({ ...ordinary.workflow, inputs: ordinary.workflow.inputs.map((input) => input.name === "entry" ? { ...input, type: "secret" } : input) });
  await assertViews(f, ordinary.run.id, "Ordinary entry retained", false);
});

test("runs without secret-name provenance follow current workflow typing without changing local receipts", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const value = "Legacy-local-readback-867!";
  const saved = await f.run("legacy-provenance", true, value);
  delete saved.run.secretInputNames;
  f.app.library.saveRun(saved.run);
  assert.equal(f.app.library.readRun(saved.run.id).secretInputNames, undefined);
  await assertViews(f, saved.run.id, value, true);
  f.app.library.save({ ...saved.workflow, inputs: saved.workflow.inputs.map((input) => ({ ...input, type: "text" })) });
  await assertViews(f, saved.run.id, value, false);
});
