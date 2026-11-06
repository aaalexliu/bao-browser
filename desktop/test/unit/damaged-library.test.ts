import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
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
  return { schema: "bao.workflow/v2", version: 2, id, name: `Workflow ${id}`, createdAt, startUrl: "https://example.test/", inputs: [], steps: [] };
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

test("CLI status returns good workflows and damaged-file reasons in an isolated HOME", () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "status", "--workflows"], {
      env: { ...process.env, HOME: f.home, BAO_HOME: f.home, BAO_HEAL_CURSOR_ACCOUNT: "0" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout) as { home: string; workflows: { id: string }[]; damagedWorkflows: unknown[] };
    assert.equal(status.home, f.home);
    assert.deepEqual(status.workflows.map((doc) => doc.id), ["newer", "older"]);
    assert.deepEqual(status.damagedWorkflows, damage);
    assert.equal(readFileSync(f.file, "utf8"), f.bytes);
  } finally { f.cleanup(); }
});

test("Library explains recovery without hiding good cards or claiming a damaged library is empty", () => {
  const listing = [{ ...workflow("good"), steps: 0 }];
  const html = libraryTable(listing, [], [], [], "/tmp/bao", damage);
  assert.match(html, /id="library-damaged" aria-labelledby="library-damaged-title" role="note"/);
  assert.match(html, /Your other workflows are fine/);
  assert.match(html, /The workflow name is missing/);
  assert.match(html, /\/tmp\/bao\/workflows\/damaged.json/);
  assert.match(html, /Restore a backup, fix the file, or remove it/);
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
