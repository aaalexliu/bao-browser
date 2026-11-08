import { fixtureDoc } from "../support/fixture-step";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { libraryTable } from "../../src/app/views";
import { McpClient } from "../../src/eval/mcp-client";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, saveState, syncAll, syncStatus } from "../../src/v1/sync";

function workflow(id: string, createdAt = 1): WorkflowV2 {
  return fixtureDoc({ schema: "bao.workflow/v4", version: 2, id, name: `Workflow ${id}`, createdAt, startUrl: "https://example.test/", inputs: [], steps: [] });
}

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "bao-damaged-library-"));
  const library = new Library(home);
  library.save(workflow("older"));
  library.save(workflow("newer", 2));
  library.saveRun({ id: "past-run", workflowId: "damaged", status: "passed", at: 3, steps: [], heals: [] });
  const file = path.join(home, "workflows", "damaged.json");
  const bytes = JSON.stringify({ ...workflow("damaged"), name: "" });
  writeFileSync(file, bytes);
  return { home, library, file, bytes, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const damage = [{ file: "damaged.json", reason: "The workflow name is missing." }];

test("listing keeps good workflows sorted, reports each bad file, and never changes files", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.home, "workflows", "syntax.json"), '{"private":"do not echo this');
    writeFileSync(path.join(f.home, "workflows", "structure.json"), JSON.stringify({ ...workflow("structure"), steps: "broken" }));
    mkdirSync(path.join(f.home, "workflows", "unreadable.json"));
    writeFileSync(path.join(f.home, "workflows", "notes.txt"), "not a workflow");
    const before = readdirSync(path.join(f.home, "workflows"));
    const result = f.library.list();
    assert.deepEqual(result.workflows.map((doc) => doc.id), ["newer", "older"]);
    assert.deepEqual(result.damagedWorkflows, [
      ...damage,
      { file: "structure.json", reason: "The workflow has an invalid structure." },
      { file: "syntax.json", reason: "The file is not valid JSON." },
      { file: "unreadable.json", reason: "The file could not be read. Check its name and permissions." },
    ]);
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
    assert.equal(readFileSync(path.join(f.home, "workflows", "syntax.json"), "utf8"), '{"private":"do not echo this');
    assert.deepEqual(readdirSync(path.join(f.home, "workflows")), before);
    assert.throws(() => f.library.read("damaged"), /invalid/);
    assert.throws(() => f.library.save(workflow("damaged")), /invalid/);
    assert.equal(f.library.readRun("past-run").status, "passed");
    writeFileSync(f.file, JSON.stringify(workflow("damaged", 4)));
    assert.equal(f.library.list().workflows[0]?.id, "damaged");
    assert.equal(f.library.list().damagedWorkflows.some((item) => item.file === "damaged.json"), false);
  } finally { f.cleanup(); }
});

test("desktop state and Runs remain readable with a schema-invalid workflow", async () => {
  const f = fixture();
  const app = await startApp({ home: f.home, port: 0 });
  const url = `http://127.0.0.1:${app.port}`;
  try {
    const response = await fetch(`${url}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json() as { workflows: { id: string }[]; damagedWorkflows: unknown[]; runs: { id: string }[]; sync: { damagedWorkflows: unknown[] } };
    assert.deepEqual(state.workflows.map((doc) => doc.id), ["newer", "older"]);
    assert.deepEqual(state.damagedWorkflows, damage);
    assert.deepEqual(state.sync.damagedWorkflows, damage);
    assert.equal(state.runs[0]?.id, "past-run");
    const run = await fetch(`${url}/api/runs/past-run`);
    assert.equal(run.status, 200);
    assert.equal((await run.json() as { workflowId: string }).workflowId, "damaged");
    assert.equal((await fetch(`${url}/api/workflows/damaged`)).status, 500);
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
    writeFileSync(f.file, JSON.stringify(workflow("damaged")));
    const repaired = await (await fetch(`${url}/api/state`)).json() as { damagedWorkflows: unknown[] };
    assert.deepEqual(repaired.damagedWorkflows, []);
  } finally { await app.close(); f.cleanup(); }
});

test("Show in Finder opens this Library’s workflow folder with a recoverable failure", async (t) => {
  const f = fixture();
  const oldHome = process.env.HOME;
  process.env.HOME = f.home;
  const app = await startApp({ home: f.home, extensionHost: false, chromeProfilesRoot: path.join(f.home, "profiles") });
  const calls: { command: string; args: readonly string[] | undefined }[] = [];
  let outcome: "opened" | "failed" | "missing" = "opened";
  const spawn = t.mock.method(childProcess, "spawn", (command: string, args?: readonly string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    queueMicrotask(() => outcome === "missing" ? child.emit("error", new Error("not installed")) : child.emit("exit", outcome === "opened" ? 0 : 1));
    return child as unknown as childProcess.ChildProcess;
  });
  try {
    for (const state of ["opened", "failed", "missing"] as const) {
      outcome = state;
      const response = await fetch(`http://127.0.0.1:${app.port}/api/workflows/reveal`, { method: "POST" });
      assert.equal(response.status, state === "opened" ? 200 : 500);
      const body = await response.json() as { ok?: boolean; error?: string };
      if (state === "opened") assert.equal(body.ok, true);
      else assert.match(body.error || "", /File details and recovery/);
      assert.deepEqual(calls.at(-1), { command: process.platform === "darwin" ? "open" : "xdg-open", args: [path.join(f.home, "workflows")] });
      assert.equal(readFileSync(f.file, "utf8"), f.bytes);
    }
  } finally {
    spawn.mock.restore();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    f.cleanup();
  }
});

test("MCP search returns good workflows and damaged-file reasons", async () => {
  const f = fixture();
  const client = McpClient.start({ ...process.env, HOME: f.home, BAO_HOME: f.home, BAO_HEAL_CURSOR_ACCOUNT: "0" });
  try {
    await client.handshake();
    const result = await client.call("search_workflows", { query: "Workflow" });
    assert.equal(result.isError, false);
    const listing = JSON.parse(result.text) as { hits: { id: string }[]; damagedWorkflows: unknown[] };
    assert.deepEqual(listing.hits.map((hit) => hit.id).sort(), ["newer", "older"]);
    assert.deepEqual(listing.damagedWorkflows, damage);
    const run = await client.call("get_run", { run_id: "past-run" });
    assert.equal(run.isError, false);
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
  } finally { await client.close(); f.cleanup(); }
});

test("Library explains recovery without hiding good cards or claiming a damaged library is empty", () => {
  const listing = [{ ...workflow("good"), steps: 0 }];
  const html = libraryTable(listing, [], [], [], "/tmp/bao", damage);
  assert.match(html, /id="library-damaged" aria-labelledby="library-damaged-title" role="note"/);
  assert.match(html, /Your other workflows are fine/);
  assert.match(html, /The workflow name is missing/);
  assert.match(html, /\/tmp\/bao\/workflows\/damaged.json/);
  assert.match(html, /Restore a backup, fix the file, or move it/);
  assert.match(html, /id="library-reveal">Show in Finder/);
  assert.match(html, /data-screen="capture">Record again/);
  assert.match(html, /data-open-workflow="good"/);
  assert.doesNotMatch(html, /No workflows yet/);
  assert.match(libraryTable([], [], [], [], "", damage), /No workflows can open/);
  assert.doesNotMatch(libraryTable([], [], [], [], "", damage), /No workflows yet|Your other workflows are fine/);
  assert.match(libraryTable([], []), /No workflows yet/);
  assert.doesNotMatch(libraryTable(listing, []), /id="library-damaged"/);
  const escaped = libraryTable([], [], [], [], "<home>", [{ file: '<file>.json', reason: '<reason>' }]);
  assert.match(escaped, /&lt;file&gt;.json/);
  assert.doesNotMatch(escaped, /<file>|<reason>|<home>/);
});

for (const mode of ["sync", "push", "pull"] as const) {
  for (const scenario of [
    { name: "known damaged file", known: true, cloud: 3, catchingUp: false },
    { name: "unrelated damaged file", known: false, cloud: 3, catchingUp: true },
    { name: "known damaged file and another missing workflow", known: true, cloud: 4, catchingUp: true },
  ]) {
    test(`${mode} catch-up accounts for ${scenario.name} without changing readable counts`, async () => {
      const f = fixture();
      const server = createServer((req, res) => {
        const send = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        if (req.url === "/api/sync/snapshot") return send({ counts: { workflows: scenario.cloud } });
        if (req.url === "/api/workflows") return send({ workflows: [{ id: "damaged" }] });
        if (req.url === "/api/workflows/damaged") return send({ version: 2, document: workflow("damaged"), shots: [] });
        if (req.url === "/api/devices") return send({ devices: [], categories: [] });
        if (req.method === "POST") return send({ version: 1 });
        return send({ error: "not found" }, 404);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        saveState(f.home, {
          ...loadState(f.home), server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture-token", backedUp: true,
          workflows: scenario.known ? { damaged: { version: 1, hash: "previous-good-version" } } : {},
          cloudCounts: { workflows: scenario.cloud }, outbox: [{ id: "damaged", hash: "queued-before-damage", at: 1 }],
        });
        const before = syncStatus(f.library);
        assert.equal(before.catchingUp, scenario.catchingUp);
        assert.equal(before.buckets.find((bucket) => bucket.category === "workflows")?.local, 2);
        const after = await syncAll(f.library, mode);
        assert.equal(after.catchingUp, scenario.catchingUp);
        assert.equal(loadState(f.home).catchingUp, scenario.catchingUp);
        assert.equal(after.buckets.find((bucket) => bucket.category === "workflows")?.local, 2);
        assert.equal(loadState(f.home).outbox?.some((item) => item.id === "damaged"), false);
        assert.equal(readFileSync(f.file, "utf8"), f.bytes);
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.cleanup(); }
    });
  }
}

test("offline sync drops an unreadable queued edit but keeps readable edits", async () => {
  const f = fixture();
  const server = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "offline" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveState(f.home, {
      ...loadState(f.home), server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture-token", backedUp: true,
      outbox: [{ id: "damaged", hash: "queued-before-damage", at: 1 }],
    });
    await assert.rejects(() => syncAll(f.library), /offline/);
    const waiting = loadState(f.home);
    assert.deepEqual(waiting.outbox?.map((item) => item.id).sort(), ["newer", "older"]);
    assert.equal(waiting.lastResult, "Offline. 2 edits will push when this Mac reconnects.");
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
    for (const id of ["newer", "older"]) writeFileSync(path.join(f.home, "workflows", `${id}.json`), "{");
    await assert.rejects(() => syncAll(f.library), /offline/);
    assert.deepEqual(loadState(f.home).outbox, []);
    assert.equal(loadState(f.home).lastResult, "Offline. This Mac will catch up when it reconnects.");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.cleanup(); }
});

test("sync counts and exports good workflows but does not overwrite a damaged local file on pull", async () => {
  const f = fixture();
  const pushed: string[] = [];
  const server = createServer((req, res) => {
    const send = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/workflows") return send({ workflows: [{ id: "damaged" }, { id: "remote" }] });
    if (req.url === "/api/workflows/damaged") return send({ version: 2, document: workflow("damaged"), shots: [] });
    if (req.url === "/api/workflows/remote") return send({ version: 1, document: workflow("remote"), shots: [] });
    if (req.method === "POST" && req.url?.endsWith("/versions")) { pushed.push(req.url); return send({ version: 1 }); }
    if (req.url === "/api/devices") return send({ devices: [], categories: [] });
    if (req.url?.endsWith("/runs")) return send({ ok: true });
    return send({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveState(f.home, { ...loadState(f.home), server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture-token" });
    const before = syncStatus(f.library);
    assert.equal(before.buckets.find((bucket) => bucket.category === "workflows")?.local, 2);
    assert.deepEqual(before.damagedWorkflows, damage);
    const result = await syncAll(f.library);
    assert.deepEqual(result.damagedWorkflows, damage);
    assert.equal(result.buckets.find((bucket) => bucket.category === "workflows")?.local, 3);
    assert.deepEqual(pushed.sort(), ["/api/workflows/newer/versions", "/api/workflows/older/versions"]);
    assert.equal(f.library.read("remote").id, "remote");
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); f.cleanup(); }
});
