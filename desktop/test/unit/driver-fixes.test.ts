import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { condense } from "../../src/v1/condense";
import { fileAct, trailHasPath } from "../../src/v1/file-chooser";
import { replay, type Driver } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { crashStatus, loadTrail, replayTask } from "../../src/eval/drivers";
import { ensurePartialTrail, liveCrashReason, withRateLimitRetry, type LiveCliResult } from "../../src/eval/live-cli";
import { McpClient } from "../../src/eval/mcp-client";
import { CAPTURE_SECRET, DRIVER_TASKS, taskHtml } from "../../src/eval/tasks";
import type { TrailEvent } from "../../src/v1/interpret";

const FILE_PATH = "/tmp/bao-secret-folder/note-a.txt";
const DRAG_PATH = "/var/bao-drag/taxes.pdf";

function ident(id: string, role = "textbox"): Identity {
  return { surface: "dom", role, id, testId: id, nameAttr: id, path: [] };
}

function memoryDriver(nodes: Identity[]): Driver & { files: string[]; texts: string[] } {
  const state = { files: [] as string[], texts: [] as string[], values: new Map<string, string>() };
  return {
    files: state.files,
    get texts() { return state.texts; },
    async tree() {
      return {
        nodes,
        texts: state.texts.slice(),
        values: [...state.values].map(([id, value]) => ({ identity: ident(id), value })),
        url: "http://127.0.0.1/t/form-file",
      };
    },
    async snapshot() { return {}; },
    async click(node) {
      if (node.id === "login-btn") state.texts.push(`Welcome ${state.values.get("username") || ""}`);
      if (node.id === "save") state.texts.push("Saved");
    },
    async fill(node, text) {
      if (node.id) state.values.set(node.id, text);
    },
    async key() {},
    async upload(_node, files) {
      const name = files[0]?.name || "";
      state.files.push(name);
      if (name) state.texts.push(name);
    },
    async drop(_node, files) {
      const name = files[0]?.name || "";
      state.files.push(name);
      if (name) state.texts.push(`Dropped file: ${name}`);
    },
    async digits() { throw new Error("digits"); },
    async check() {},
    async notify() {},
  };
}

test("a file set by upload, drop, or a typed path is a file slot and the path stays out", async () => {
  const ways: { op: string; args?: Record<string, unknown>; value?: string; rawPath?: string; identity?: Identity }[] = [
    { op: "upload", args: { id: "file", path: FILE_PATH }, identity: ident("file") },
    { op: "drop", rawPath: DRAG_PATH, identity: ident("file") },
    { op: "type", args: { text: FILE_PATH }, value: FILE_PATH },
  ];
  for (const way of ways) {
    const act = fileAct(way);
    assert.equal(act.file, true, way.op);
    const recorded = { op: act.op, args: act.args, value: act.value, fileName: act.fileName };
    assert.equal(trailHasPath(recorded, FILE_PATH), false);
    assert.equal(trailHasPath(recorded, DRAG_PATH), false);
    const event: TrailEvent = {
      id: "f",
      ts: 1,
      kind: "act",
      op: act.op,
      fileName: act.fileName,
      identity: way.identity || ident("file"),
    };
    const doc = condense([event], { id: "file", name: "File", startUrl: "http://127.0.0.1/t/form-file" });
    const blob = JSON.stringify(doc);
    assert.equal(blob.includes(FILE_PATH), false);
    assert.equal(blob.includes(DRAG_PATH), false);
    assert.equal(doc.inputs.some((item) => item.type === "file"), true);
    assert.equal(doc.steps[0]?.action === "upload" || doc.steps[0]?.action === "drop", true);
    const driver = memoryDriver([ident("file")]);
    const run = await replay(doc, { [doc.inputs[0]!.name]: { name: "note-b.txt", path: "/tmp/replay/note-b.txt" } }, driver);
    assert.equal(run.status, "passed", run.failure?.reason);
    assert.equal(driver.files[0], "note-b.txt");
  }
});

test("a login stop becomes a sign-in step whose postcondition is Welcome", async () => {
  const user = ident("username");
  const password = ident("password");
  const button = ident("login-btn", "button");
  const events: TrailEvent[] = [
    { id: "e1", ts: 1, kind: "act", op: "click", identity: user, beforeUrl: "http://127.0.0.1/t/login", afterUrl: "http://127.0.0.1/t/login" },
    { id: "e2", ts: 2, kind: "act", op: "type", value: "ada", identity: user },
    {
      id: "e3", ts: 3, kind: "act", op: "type", sensitive: true, gate: "login", performed: false, identity: password,
    },
    {
      id: "e4", ts: 4, kind: "act", op: "click", gate: "login", performed: false, identity: button,
      beforeUrl: "http://127.0.0.1/t/login", afterUrl: "http://127.0.0.1/t/login",
    },
    {
      id: "e5", ts: 5, kind: "act", op: "click", gate: "login", performed: false, identity: button,
      beforeUrl: "http://127.0.0.1/t/login", afterUrl: "http://127.0.0.1/t/login",
    },
  ];
  const doc = condense(events, { id: "login", name: "Login", startUrl: "http://127.0.0.1/t/login", secrets: [CAPTURE_SECRET] });
  const sign = doc.steps.filter((step) => step.action === "click" && step.identity?.id === "login-btn");
  assert.equal(sign.length, 1);
  assert.equal(sign[0]?.gate, "login");
  assert.equal(sign[0]?.label, "Sign in");
  assert.equal(sign[0]?.postcondition?.match, "Welcome {{username}}");
  assert.equal(JSON.stringify(doc).includes(CAPTURE_SECRET), false);
  const driver = memoryDriver([user, password, button]);
  const secret = doc.inputs.find((item) => item.type === "secret");
  const text = doc.inputs.find((item) => item.type === "text");
  assert.ok(secret && text);
  const run = await replay(doc, { [text.name]: "grace", [secret.name]: "ReplaySecretOne!" }, driver);
  assert.equal(run.status, "passed", run.failure?.reason);
  assert.equal(driver.texts.includes("Welcome grace"), true);
});

test("a 429 is retried, and a leftover crash writes a partial trail as driver-error", async () => {
  const waits: number[] = [];
  let calls = 0;
  const recovered = await withRateLimitRetry(async () => {
    calls += 1;
    const result: LiveCliResult = {
      code: calls < 3 ? 1 : 0,
      timedOut: false,
      stdout: "",
      stderr: calls < 3 ? "HTTP 429" : "",
      tokens: "n/a",
    };
    return result;
  }, { waitsMs: [5, 7], sleep: async (ms) => { waits.push(ms); } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 7]);
  assert.equal(liveCrashReason(recovered), null);

  let stuck = 0;
  const failed = await withRateLimitRetry(async () => {
    stuck += 1;
    const result: LiveCliResult = {
      code: null,
      timedOut: false,
      stdout: "Too Many Requests",
      stderr: "",
      tokens: "n/a",
    };
    return result;
  }, { waitsMs: [1, 1], sleep: async () => {} });
  assert.equal(stuck, 3);
  assert.equal(liveCrashReason(failed), "HTTP 429");
  assert.equal(crashStatus(liveCrashReason(failed), false), "infra");
  assert.equal(crashStatus("cli exit 1", true), null);

  let once = 0;
  const exited = await withRateLimitRetry(async () => {
    once += 1;
    return { code: 1, timedOut: false, stdout: "boom", stderr: "", tokens: "n/a" };
  }, { waitsMs: [1, 1], sleep: async () => {} });
  assert.equal(once, 1);
  assert.equal(liveCrashReason(exited), "cli exit 1");
  assert.equal(crashStatus(liveCrashReason(exited), false), "driver-error");

  const home = mkdtempSync(path.join(tmpdir(), "bao-crash-"));
  ensurePartialTrail(home, "HTTP 429");
  const trail = readFileSync(path.join(home, "trail.jsonl"), "utf8");
  assert.match(trail, /driver-error/);
  assert.match(trail, /HTTP 429/);
  writeFileSync(path.join(home, "trail.jsonl"), "{\"op\":\"click\"}\n");
  ensurePartialTrail(home, "HTTP 429");
  assert.match(readFileSync(path.join(home, "trail.jsonl"), "utf8"), /click/);
});

test("fixture trails: a typed path never lands in the trail, and a login stop replays Welcome", { timeout: 180_000 }, async () => {
  const server = await fixtureServer();
  try {
    const form = DRIVER_TASKS.find((task) => task.id === "form-file");
    const login = DRIVER_TASKS.find((task) => task.id === "login");
    assert.ok(form && login);
    const home = mkdtempSync(path.join(tmpdir(), "bao-file-"));
    const filePath = path.join(home, "note-a.txt");
    writeFileSync(filePath, "sample note-a\n");
    const client = McpClient.start({
      ...process.env,
      BAO_MCP_LIVE: "1",
      BAO_HOME: home,
      BAO_FIXTURE_URL: `http://127.0.0.1:${server.port}/t/form-file`,
      BAO_HEADED: "0",
    });
    try {
      await client.handshake();
      const typed = await client.call("type", { text: filePath });
      assert.equal(typed.isError, false, typed.text);
      const uploaded = await client.call("upload", { id: "file", path: filePath });
      assert.equal(uploaded.isError, false, uploaded.text);
      await client.call("click", { ref: "name" });
      await client.call("type", { text: "Ada" });
      await client.call("click", { ref: "save" });
    } finally {
      await client.close();
    }
    const raw = readFileSync(path.join(home, "trail.jsonl"), "utf8");
    assert.equal(raw.includes(filePath), false);
    assert.match(raw, /"op":"upload"/);
    const loaded = loadTrail(home);
    const workflow = condense(loaded.events, {
      id: "drv-form-file",
      name: form.title,
      startUrl: `http://127.0.0.1:${server.port}/t/form-file`,
    });
    assert.equal(JSON.stringify(workflow).includes(filePath), false);
    assert.equal(workflow.inputs.some((item) => item.type === "file"), true);
    const replayFile = path.join(home, "note-b.txt");
    writeFileSync(replayFile, "sample note-b\n");
    const fileRun = await replayTask(workflow, form, server.port, {
      texts: ["Grace"],
      secret: "",
      filePath: replayFile,
      fileName: "note-b.txt",
      video: false,
    });
    assert.equal(fileRun.ok, true, fileRun.reason);
    assert.equal(fileRun.reason.includes("no-candidates"), false);

    const drag = dragWorkflow();
    const dragFile = path.join(home, "note-c.txt");
    writeFileSync(dragFile, "sample note-c\n");
    const dragRun = await replayTask(drag, form, server.port, {
      texts: ["Lin"],
      secret: "",
      filePath: dragFile,
      fileName: "note-c.txt",
      video: false,
    });
    assert.equal(dragRun.ok, true, dragRun.reason);

    const loginHome = mkdtempSync(path.join(tmpdir(), "bao-login-"));
    const loginClient = McpClient.start({
      ...process.env,
      BAO_MCP_LIVE: "1",
      BAO_HOME: loginHome,
      BAO_FIXTURE_URL: `http://127.0.0.1:${server.port}/t/login`,
      BAO_HEADED: "0",
    });
    try {
      await loginClient.handshake();
      await loginClient.call("click", { ref: "username" });
      await loginClient.call("type", { text: "ada" });
      await loginClient.call("click", { ref: "password" });
      const stopped = await loginClient.call("type", { text: CAPTURE_SECRET });
      assert.equal(stopped.text, "STOP login");
    } finally {
      await loginClient.close();
    }
    const loginTrail = readFileSync(path.join(loginHome, "trail.jsonl"), "utf8");
    assert.equal(loginTrail.includes(CAPTURE_SECRET), false);
    assert.match(loginTrail, /"gate":"login"/);
    const loginEvents = loadTrail(loginHome);
    const loginDoc = condense(loginEvents.events, {
      id: "drv-login",
      name: login.title,
      startUrl: `http://127.0.0.1:${server.port}/t/login`,
      secrets: [CAPTURE_SECRET],
    });
    const sign = loginDoc.steps.find((step) => step.action === "click" && step.gate === "login");
    assert.ok(sign);
    assert.equal(sign?.postcondition?.match, "Welcome {{username}}");
    const loginRun = await replayTask(loginDoc, login, server.port, {
      texts: ["grace"],
      secret: "ReplaySecretOne!",
      filePath: "",
      fileName: "",
      video: false,
    });
    assert.equal(loginRun.ok, true, loginRun.reason);
  } finally {
    await server.close();
  }
});

function dragWorkflow(): WorkflowV2 {
  const act = fileAct({ op: "drop", rawPath: DRAG_PATH, identity: { id: "file", inputType: "file" } });
  assert.equal(trailHasPath({ op: act.op, fileName: act.fileName, value: act.value }, DRAG_PATH), false);
  const save: Identity = { surface: "dom", role: "button", id: "save", testId: "save", path: [] };
  return condense([
    {
      id: "d1", ts: 1, kind: "act", op: act.op, fileName: act.fileName,
      identity: ident("file"),
    },
    { id: "d2", ts: 2, kind: "act", op: "type", value: "Ada", identity: ident("name") },
    { id: "d3", ts: 3, kind: "act", op: "click", identity: save, afterText: "Saved" },
  ], { id: "drag", name: "Drag", startUrl: "http://127.0.0.1/t/form-file" });
}

async function fixtureServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const id = new URL(req.url || "/", "http://127.0.0.1").pathname.split("/").filter(Boolean).pop() || "";
    const html = taskHtml(id);
    if (!html) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}
