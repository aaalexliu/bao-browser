import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { startApp } from "../../src/app/server";
import { getRun, runWorkflow, type LiveReplayer } from "../../src/mcp/catalog";
import { LiveSession } from "../../src/mcp/live";
import { ReceiptLog, verifyReceiptChain } from "../../src/v1/receipt";
import { replay, type Driver } from "../../src/v1/replay";
import { NEEDS_SECRET_VALUE, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { inferSavedWorkflow } from "../../src/v1/save-intent";
import { projectTeach, teachIntentCase } from "../../src/v1/teach";
import { parseTable } from "../../src/v1/data-steps";

const ARGS = { password: "pass", privateWord: "secret" };
function fixture(t: TestContext): string {
  const home = mkdtempSync(path.join(tmpdir(), "bao-final-writers-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function workflow(startUrl = "https://example.test/"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "writer-census", name: "Writer census", createdAt: 1, startUrl,
    inputs: [{ name: "password", type: "secret" }, { name: "privateWord", type: "secret" }],
    steps: [{ id: "password-entry", index: 0, action: "type", label: "Type {{password}}", intent: "Fill {{password}}", surface: "dom", timeoutMs: 0, input: "password", value: "{{password}}", sensitive: true, heal: "never", identity: { surface: "dom", role: "textbox", id: "password", path: [] }, locators: [{ kind: "css", value: "#password" }], readBack: { source: "value", match: "{{password}}", timeoutMs: 0 } }],
  };
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("recording, teaching and save inference keep authored metadata before the public writer", async (t) => {
  const home = fixture(t);
  const library = new Library(home);
  const event: TrailEvent = { id: "password", ts: 1, kind: "act", op: "type", sensitive: true, value: "password", identity: { surface: "dom", role: "password", inputType: "password", id: "password", name: "Type {{password}}", path: [{ role: "group", name: "password" }] }, locators: [{ kind: "css", value: "#password" }] };
  const original = structuredClone(event);
  const meta = { id: "writer-census", name: "password", startUrl: "https://example.test/", secrets: ["pass", "secret"] };
  const producers: [string, () => WorkflowV2 | Promise<WorkflowV2>][] = [
    ["recording", () => interpret([event], meta)],
    ["teaching", () => {
      const decisions = [{ ts: 1, cardId: event.id, kind: "rename" as const, detail: "see hunter2", intent: "Type {{password}}" }];
      const projected = projectTeach([event], decisions, meta);
      assert.deepEqual(projected.cards[0]!.eventIds, [event.id]);
      library.saveTeachIntentCase("writer", teachIntentCase("writer", [event], decisions, meta));
      const stored = JSON.parse(readFileSync(path.join(home, "evals", "intent", "cases", "writer.json"), "utf8"));
      assert.deepEqual(stored.secretIds, [event.id]);
      assert.equal(stored.decisions[0].cardId, event.id);
      assert.equal(stored.events[0].value, STRIPPED_SECRET);
      return projected.workflow;
    }],
    ["saved trail", () => {
      library.save(workflow());
      library.saveTrail(meta.id, [event]);
      return interpret(library.readTrail(meta.id) as TrailEvent[], meta);
    }],
    ["stripped default", () => {
      const doc = workflow();
      doc.inputs[0]!.default = "password";
      library.save(doc);
      assert.equal(library.read(doc.id).inputs[0]!.default, STRIPPED_SECRET);
      return library.read(doc.id);
    }],
    ["save inference", () => inferSavedWorkflow(workflow(), { floorTitle: "Writer census", secrets: ["pass", "secret"] }, null, 1)],
  ];
  for (const [name, produce] of producers) {
    const doc = await produce();
    const step = doc.steps[0]!;
    assert.equal(step.value, "{{password}}", name);
    assert.equal(step.label, name === "recording" || name === "saved trail" ? "Type secret" : "Type {{password}}", name);
    assert.deepEqual(step.locators, [{ kind: "css", value: "#password" }], name);
    if (["recording", "teaching", "saved trail"].includes(name)) {
      assert.equal(doc.name, "password", name);
      assert.deepEqual(step.identity!.path, event.identity!.path, name);
      assert.equal(step.identity!.name, "Type {{password}}", name);
    }
    library.save(doc);
    const saved = library.read(doc.id);
    let filled = "";
    const node = saved.steps[0]!.identity!;
    const driver = { tree: async () => ({ nodes: [node], texts: [], values: [{ identity: node, value: filled }], url: doc.startUrl }), fill: async (_node: unknown, value: string) => { filled = value; }, snapshot: async () => ({ dom: [] }), sleep: async () => {} } as unknown as Driver;
    const result = await replay(saved, { password: "new-credential", privateWord: "new-private-word" }, driver);
    assert.equal(result.status, "passed", `${name}: ${result.failure?.reason}`);
    assert.equal(filled, "new-credential", name);
    filled = "";
    const blocked = await replay(saved, { password: STRIPPED_SECRET, privateWord: "fresh" }, driver, { heal: { available: () => true, propose: async () => { throw new Error("A stripped value reached healing"); } } });
    assert.equal(blocked.failure?.reason, NEEDS_SECRET_VALUE, name);
    assert.equal(filled, "", name);
    library.saveTrail(doc.id, [event]);
    const trail = library.readTrail(doc.id) as TrailEvent[];
    assert.equal(trail[0]!.value, STRIPPED_SECRET, name);
    assert.equal(trail[0]!.identity!.id, "password", name);
    assert.deepEqual(event, original, name);
  }
});

test("ordinary CSV and array table cells use whole-value nets without schema-name exemptions", (t) => {
  const home = fixture(t);
  const library = new Library(home);
  const rows = [{ label: "4111111111111111", status: "sk-table-value" }];
  const doc = workflow();
  doc.version = 3;
  doc.inputs.push({ name: "rows", type: "table", default: "label,status\n4111111111111111,sk-table-value\n" });
  doc.steps.push({ id: "rows-loop", index: 1, action: "for_each", label: "Rows", surface: "dom", timeoutMs: 0, forEach: { over: { kind: "input", name: "rows" }, steps: [{ id: "row", index: 0, action: "type", label: "Type {{row.label}}", surface: "dom", timeoutMs: 0, value: "{{row.label}}", identity: { surface: "dom", role: "textbox", id: "row", path: [] } }] } });
  library.save(doc);
  assert.deepEqual(parseTable(library.read(doc.id).inputs.find((input) => input.name === "rows")!.default), [{ label: STRIPPED_SECRET, status: STRIPPED_SECRET }]);
  library.saveRun({ id: "tables", workflowId: doc.id, status: "passed", at: 1, steps: [], heals: [], outputs: [{ name: "table", type: "table", columns: [{ name: "label", type: "text" }, { name: "status", type: "text" }], rows }] });
  const outputs = library.readRun("tables").outputs as { rows: unknown }[];
  assert.deepEqual(outputs[0]!.rows, [{ label: STRIPPED_SECRET, status: STRIPPED_SECRET }]);
  assert.deepEqual(rows, [{ label: "4111111111111111", status: "sk-table-value" }]);
  doc.inputs.push({ name: "choice", type: "choice", choices: ["4111111111111111"] });
  library.save(doc);
  const args = { password: { inputs: { choice: "4111111111111111" } }, choice: "4111111111111111" };
  library.saveTrail(doc.id, [{ op: "type", args }]);
  const trail = library.readTrail(doc.id) as { args: typeof args }[];
  assert.equal(trail[0]!.args.choice, "4111111111111111");
  assert.equal(trail[0]!.args.password.inputs.choice, STRIPPED_SECRET);
  assert.equal(args.password.inputs.choice, "4111111111111111");
});

test("saved zero-valued secrets do not rewrite pointer coordinates or identity indices", (t) => {
  const home = fixture(t);
  const library = new Library(home);
  const event: TrailEvent = { id: "zero", ts: 1, kind: "act", op: "type", sensitive: true, value: "0", identity: { surface: "dom", role: "textbox", name: "0", app: "0", windowTitle: "0", siblingIndex: 0, path: [] }, locators: [{ kind: "css", value: "#field" }], provenance: { x: 0, y: 0, space: "viewport" } };
  const original = structuredClone(event);
  library.saveTrail("zero", [event]);
  const saved = (library.readTrail("zero") as TrailEvent[])[0]!;
  assert.equal(saved.value, STRIPPED_SECRET);
  assert.deepEqual(saved.identity, event.identity);
  assert.deepEqual(saved.locators, event.locators);
  assert.deepEqual(saved.provenance, event.provenance);
  assert.deepEqual(event, original);
});

test("public MCP reports keep names, statuses, bindings and markers with nonempty secret evidence", async (t) => {
  const home = fixture(t);
  const library = new Library(home);
  const doc = { ...workflow(), driver: "cdp-live" as const };
  library.save(doc);
  const seen: unknown[] = [];
  const live: LiveReplayer = async (active, args) => {
    seen.push(structuredClone({ active, args }));
    return { runId: "writer-run", status: "passed", steps: [{ id: "password-entry", status: "passed" }], heals: [], repairs: [], locatorHits: [], receipts: [], trajectory: [], trail: [], pageClasses: [], modelCalls: 0, outputs: [{ name: "password", label: "Type {{password}}", type: "text", value: STRIPPED_SECRET }] };
  };
  const outcome = await runWorkflow(library, { id: doc.id, inputs: ARGS }, undefined, { live });
  assert.equal(outcome.outcome, "ok");
  assert.deepEqual(outcome.receipts, [{ id: "password-entry", status: "passed", readBack: STRIPPED_SECRET }]);
  assert.deepEqual(outcome.outputs, [{ name: "password", label: "Type {{password}}", type: "text", value: STRIPPED_SECRET }]);
  const stored = JSON.parse(readFileSync(path.join(home, "reports", "writer-run.json"), "utf8"));
  for (const saved of [stored, getRun(library, "writer-run")]) {
    assert.equal(saved.workflowId, doc.id);
    assert.deepEqual(saved.receipts, outcome.receipts);
    assert.deepEqual(saved.outputs, outcome.outputs);
  }
  assert.deepEqual(library.readRun("writer-run").steps, [{ id: "password-entry", status: "passed" }]);
  assert.deepEqual(seen, [{ active: doc, args: ARGS }]);
});

test("read-back compares original values and hashes only whole-value-scrubbed receipt bodies", async (t) => {
  const home = fixture(t);
  const doc = workflow();
  let filled = "";
  const node = doc.steps[0]!.identity!;
  doc.steps[0]!.readBack!.identity = node;
  const args = { password: "pass", privateWord: "hunter2" };
  const driver = {
    tree: async () => ({ nodes: [node], texts: [], values: [{ identity: node, value: args.privateWord }], url: doc.startUrl }),
    fill: async (_node: unknown, value: string) => { filled = value; }, snapshot: async () => ({ dom: [] }), sleep: async () => {},
  } as unknown as Driver;
  const file = path.join(home, "receipts.jsonl");
  const result = await replay(doc, args, driver, { receipts: new ReceiptLog(file), secrets: Object.values(args) });
  assert.equal(filled, "pass");
  assert.equal(result.status, "failed");
  const receipts = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const read = receipts.find((row) => row.kind === "read-back");
  assert.equal(read.pass, false);
  assert.equal(read.expected, STRIPPED_SECRET);
  assert.equal(read.actual, STRIPPED_SECRET);
  assert.equal(verifyReceiptChain(receipts), true);
  assert.deepEqual(ARGS, { password: "pass", privateWord: "secret" });
});

test("owned app HTTP replay persists stable IDs, statuses, shot references and receipt hashes", async (t) => {
  const home = fixture(t);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/typed?")) seen.push(new URL(req.url, "http://fixture.test").searchParams.get("value") || "");
    res.setHeader("content-type", "text/html");
    res.end('<input id="password" oninput="fetch(\'/typed?value=\'+encodeURIComponent(this.value))"><p>[secret stripped]</p>');
  });
  const startUrl = await listen(server);
  const library = new Library(home);
  library.updateSettings({ pageEngine: "old" });
  const doc = { ...workflow(startUrl), driver: "playwright" as const };
  library.save(doc);
  const priorHome = process.env.BAO_HOME;
  const app = await startApp({ home, port: 0, extensionHost: false, chromeUserData: path.join(home, "unused-source"), liveTarget: "bao", liveLockFile: path.join(home, "live.lock") });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: doc.id, args: ARGS }) });
    assert.equal(response.status, 200, await response.clone().text());
    const run = await response.json() as { runId: string; status: string; failure?: { reason: string } };
    assert.equal(run.status, "passed", run.failure?.reason);
    assert.ok(seen.includes("pass"));
    const stored = library.readRun(run.runId);
    assert.equal(stored.workflowId, doc.id);
    assert.equal(stored.status, "passed");
    const step = (stored.steps as { id: string; status: string; beforeShot?: string; afterShot?: string }[])[0]!;
    assert.equal(step.id, "password-entry");
    assert.equal(step.status, "passed");
    for (const ref of [step.beforeShot, step.afterShot]) {
      assert.ok(ref, "Missing shot reference");
      assert.ok(ref.includes("password-entry"), `Unstable shot reference: ${ref}`);
      assert.ok(existsSync(path.join(home, "shots", "runs", run.runId, ref)));
    }
    const receipts = stored.receipts as Parameters<typeof verifyReceiptChain>[0];
    assert.equal(verifyReceiptChain(receipts), true);
    const read = receipts.find((row) => row.kind === "read-back");
    assert.ok(read?.kind === "read-back");
    assert.equal(read.expected, STRIPPED_SECRET);
    assert.equal(read.actual, STRIPPED_SECRET);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (priorHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = priorHome;
  }
});

test("root live MCP types original text and saves metadata without substring rejection", async (t) => {
  const home = fixture(t);
  let seen = "";
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/typed?")) seen = new URL(req.url, "http://fixture.test").searchParams.get("value") || "";
    res.setHeader("content-type", "text/html");
    res.end('<input id="password" type="password" oninput="fetch(\'/typed?value=\'+encodeURIComponent(this.value))"><script>document.querySelector("input").focus()</script>');
  });
  const url = await listen(server);
  const session = await LiveSession.start({ ...process.env, BAO_HOME: home, BAO_MCP_URL: url, BAO_MCP_SURFACE: "browser", BAO_SECRETS: "pass,secret" });
  try {
    await session.call("type", { text: "pass" });
    for (let i = 0; i < 100 && seen !== "pass"; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(seen, "pass");
    const events = readFileSync(path.join(home, "trail.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const typed = events.find((row) => row.op === "type");
    assert.equal(typed.identity.id, "password");
    assert.equal(typed.value, STRIPPED_SECRET);
    assert.equal(typed.sensitive, true);
  } finally {
    await (session as unknown as { page: Page }).page.context().close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
