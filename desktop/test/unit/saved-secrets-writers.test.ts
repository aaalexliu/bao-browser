import { fixtureDoc, fixtureInput, fixtureStep, writeStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startApp } from "../../src/app/server";
import { decideOpen } from "../../src/app/deeplink";
import { typeTrailEvent } from "../../src/mcp/live";
import { NEEDS_SECRET_VALUE, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { editInput, tokenFields } from "../../src/v1/input-token";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { ReceiptLog, verifyReceiptChain } from "../../src/v1/receipt";
import { replay, type Driver } from "../../src/v1/replay";
import { inferSavedWorkflow } from "../../src/v1/save-intent";
import { stepQuery, stepValueTemplate, validateWorkflow, type ReplayArgs, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { projectTeach, teachIntentCase } from "../../src/v1/teach";
import { draftVersion, listVersions, restoreVersion } from "../../src/v1/versions";

function migrate(_raw: unknown): WorkflowV2 {
  return fixtureDoc(_raw && typeof _raw === "object" ? _raw as Record<string, unknown> : {});
}

const PASSWORD = "Bao-local-password-742!";
function fixture(t: TestContext): Library {
  const home = mkdtempSync(path.join(tmpdir(), "bao-saved-inputs-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return new Library(home);
}
function workflow(startUrl = "https://fixture.test/"): WorkflowV2 {
  return fixtureDoc({
    schema: "bao.workflow/v4", version: 2, id: "saved-inputs", name: "Saved inputs", createdAt: 1, startUrl,
    inputs: [fixtureInput({ name: "password", type: "secret", default: PASSWORD })],
    steps: [fixtureStep({ id: "entry", index: 0, action: "type", label: "Fill password", surface: "dom", timeoutMs: 0, input: "password", value: "{{password}}", sensitive: true, heal: "never", identity: { surface: "dom", role: "password", id: "password", inputType: "password", path: [] }, locators: [{ kind: "css", value: "#password" }] })],
  });
}
function memoryDriver(doc: WorkflowV2): { driver: Driver; values: string[] } {
  const values: string[] = [];
  const node = stepQuery(doc.steps[0]!)!;
  return { values, driver: {
    tree: async () => ({ nodes: [node], texts: [], values: [{ identity: node, value: values.at(-1) || "" }], url: doc.startUrl }),
    fill: async (_node: unknown, value: string) => { values.push(value); }, snapshot: async () => ({ dom: [] }), sleep: async () => {},
  } as unknown as Driver };
}

test("recording, teaching and save inference retain password defaults for replay", async (t) => {
  const library = fixture(t);
  const event: TrailEvent = { id: "password", ts: 1, kind: "act", op: "type", value: PASSWORD, sensitive: true, identity: stepQuery(workflow().steps[0]!), locators: [{ kind: "css", value: "#password" }] };
  const original = structuredClone(event);
  const meta = { id: "saved-inputs", startUrl: "https://fixture.test/", secrets: [PASSWORD] };
  const recorded = interpret([event], meta);
  const taught = projectTeach([event], [{ ts: 2, cardId: event.id, kind: "secret", name: "password", detail: "Keep as password" }], meta).workflow;
  const inferred = await inferSavedWorkflow(recorded, { floorTitle: "Saved inputs" }, null, 1);
  for (const doc of [recorded, taught, inferred]) {
    assert.equal(doc.inputs[0]!.default, PASSWORD);
    assert.equal(stepValueTemplate(doc.steps[0]!), "{{password}}");
    library.save(doc);
    library.saveTrail(doc.id, [event]);
    library.saveTeachIntentCase("password", teachIntentCase("password", [event], [], meta));
    const saved = library.read(doc.id);
    saved.steps[0]!.readBack = { source: "value", match: "{{password}}", timeoutMs: 0 };
    assert.equal(saved.inputs[0]!.default, PASSWORD);
    assert.equal((library.readTrail(doc.id) as TrailEvent[])[0]!.value, PASSWORD);
    assert.equal(JSON.parse(readFileSync(path.join(library.root, "evals/intent/cases/password.json"), "utf8")).events[0].value, PASSWORD);
    for (const args of [{}, { password: "runtime-password" }] as ReplayArgs[]) {
      const { driver, values } = memoryDriver(saved);
      const result = await replay(saved, args, driver);
      assert.equal(result.status, "passed", result.failure?.reason);
      assert.deepEqual(values, [args.password ?? PASSWORD]);
      const receipt = result.receipts.find((entry) => entry.kind === "read-back");
      assert.equal(receipt?.kind === "read-back" && receipt.actual, args.password ?? PASSWORD);
      assert.equal(verifyReceiptChain(result.receipts), true);
    }
  }
  assert.deepEqual(event, original);
  assert.equal(typeTrailEvent(PASSWORD, event.identity, [PASSWORD]).value, PASSWORD);
});

test("local writers preserve values, table cells and signed receipt bodies", (t) => {
  const library = fixture(t);
  const doc = workflow();
  const rows = [{ password: PASSWORD, card: "4111111111111111", token: "sk-fixtureToken" }];
  doc.inputs.push(fixtureInput({ name: "rows", type: "table", default: JSON.stringify(rows) }));
  library.save(doc);
  const payload = { op: "type", value: PASSWORD, args: { password: PASSWORD, rows } };
  library.saveTrail(doc.id, [payload]);
  library.appendTrail(doc.id, payload);
  library.savePublicInputs(doc.id, { password: PASSWORD });
  library.saveIntentEval("values", payload);
  const promotion = { workflowId: doc.id, payload };
  library.savePromotion(promotion);
  assert.deepEqual(library.readTrail(doc.id), [payload, payload]);
  assert.deepEqual(library.readPublicInputs(doc.id), { password: PASSWORD });
  assert.deepEqual(library.readIntentEval("values"), payload);
  assert.equal(library.read(doc.id).inputs[1]!.default, JSON.stringify(rows));
  const draft = draftVersion(library, doc, "edit");
  assert.equal(draft.document.inputs[0]!.default, PASSWORD);
  restoreVersion(library, doc.id, draft.n);
  assert.ok(listVersions(library, doc.id).length >= 2);
  assert.ok(readFileSync(path.join(library.root, "versions", `${doc.id}.json`), "utf8").includes(PASSWORD));
  const receipts = new ReceiptLog(path.join(library.root, "receipts.jsonl"));
  const receipt = receipts.append({ kind: "read-back", runId: "receipt-run", stepId: "entry", workflowId: doc.id, ts: 1, source: "value", expected: PASSWORD, actual: PASSWORD, pass: true });
  assert.equal(receipt.kind === "read-back" && receipt.actual, PASSWORD);
  assert.equal(verifyReceiptChain([receipt]), true);
  library.saveRun({ id: "receipt-run", workflowId: doc.id, at: 1, status: "passed", steps: [], heals: [], inputs: { password: PASSWORD }, receipts: [receipt], outputs: [{ name: "rows", type: "table", rows, columns: [] }] });
  assert.deepEqual(library.readRun("receipt-run").receipts, [receipt]);
  assert.equal(library.readRun("receipt-run").inputs?.password, PASSWORD);
});

test("legacy missing literals, keys and defaults never dispatch or heal", async () => {
  for (const kind of ["default", "number-default", "runtime", "literal", "key", "redacted-key"] as const) {
    const doc = workflow();
    const step = doc.steps[0]!;
    if (kind === "default" || kind === "number-default") doc.inputs[0]!.default = STRIPPED_SECRET;
    if (kind === "number-default") doc.inputs[0]!.type = "number";
    if (kind === "literal") writeStep(step, { value: STRIPPED_SECRET });
    if (kind === "key") { step.action = "key"; writeStep(step, { key: STRIPPED_SECRET }); }
    if (kind === "redacted-key") { step.action = "key"; writeStep(step, { unresolved: { reason: "redacted key" } }); }
    const { driver, values } = memoryDriver(doc);
    const result = await replay(doc, kind === "runtime" ? { password: STRIPPED_SECRET } : {}, driver, { heal: { available: () => true, propose: async () => { throw new Error("missing data reached healing"); } } });
    assert.equal(result.failure?.reason, NEEDS_SECRET_VALUE, kind);
    assert.deepEqual(values, [], kind);
    if (kind === "default") {
      const fresh = await replay(doc, { password: PASSWORD }, driver);
      assert.equal(fresh.status, "passed");
      assert.deepEqual(values, [PASSWORD]);
    }
  }
});

test("secret defaults can be edited and supplied by run links", () => {
  const doc = workflow();
  const edited = editInput(doc, { name: "password", default: "  exact password  " });
  assert.equal(edited.doc?.inputs[0]!.default, "  exact password  ");
  assert.equal(tokenFields(edited.doc!.inputs[0]!).default, "  exact password  ");
  assert.equal(tokenFields({ name: "password", type: "secret", default: STRIPPED_SECRET }).default, "");
  assert.deepEqual(validateWorkflow(doc), []);
  const opened = decideOpen(`bao://run/${doc.id}?inputs=${encodeURIComponent(JSON.stringify({ password: PASSWORD }))}`, doc, null);
  assert.ok("opened" in opened);
  assert.equal(opened.opened.inputs?.password, PASSWORD);
  const old = migrate({ id: "old", name: "Old", startUrl: doc.startUrl, steps: [{ action: "input", value: PASSWORD, sensitive: true, selector: "#password" }] });
  assert.equal(old.inputs[0]!.default, PASSWORD);
});

test("running app saves and replays a password default without fresh input", { timeout: 30_000 }, async (t) => {
  const library = fixture(t);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/typed?")) seen.push(new URL(req.url, "http://fixture.test").searchParams.get("value") || "");
    res.setHeader("content-type", "text/html");
    res.end('<input id="password" type="password" oninput="fetch(\'/typed?value=\'+encodeURIComponent(this.value))">');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  library.updateSettings({ pageEngine: "old" });
  const priorHome = process.env.BAO_HOME;
  const app = await startApp({ home: library.root, port: 0, extensionHost: false, chromeUserData: path.join(library.root, "unused-source") });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const doc = { ...workflow(`http://127.0.0.1:${address.port}`), driver: "playwright" };
    const saved = await fetch(base + "/api/workflows/import", { method: "POST", body: JSON.stringify(doc) });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(library.read(doc.id).inputs[0]!.default, PASSWORD);
    const response = await fetch(base + "/api/replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: doc.id, args: {} }) });
    const run = await response.json() as { runId: string; status: string; failure?: { reason: string } };
    assert.equal(response.status, 200);
    assert.equal(run.status, "passed", run.failure?.reason);
    assert.ok(seen.includes(PASSWORD));
    assert.equal(library.readRun(run.runId).status, "passed");
    assert.equal(library.readRun(run.runId).inputs?.password, PASSWORD);
  } finally {
    await app.close();
    if (priorHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = priorHome;
  }
});
