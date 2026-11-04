import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Library } from "../../src/v1/store";
import { hashReceipt, ReceiptLog, verifyReceiptChain, type Receipt } from "../../src/v1/receipt";
import { scrubHome } from "../../src/v1/scrub-home";
import { draftVersion, versionDocument } from "../../src/v1/versions";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import type { WorkflowV2 } from "../../src/v1/schema";

const FIELD = { surface: "dom" as const, role: "textbox", path: [] };
const typed = (value: unknown) => ({ op: "type", sensitive: true, value });

test("owned user values strip across public writers while all other fields remain identical", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-value-allowlist-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const json = (relative: string) => JSON.parse(readFileSync(path.join(home, relative), "utf8"));
  const writers: [string, (doc: WorkflowV2) => WorkflowV2][] = [
    ["workflow", (doc) => { library.save(doc); return library.read(doc.id); }],
    ["trail", (doc) => { library.saveTrail(doc.id, [doc]); return (library.readTrail(doc.id) as WorkflowV2[])[0]!; }],
    ["append trail", (doc) => { library.saveTrail(doc.id, []); library.appendTrail(doc.id, doc); return (library.readTrail(doc.id) as WorkflowV2[])[0]!; }],
    ["run", (doc) => { library.saveRun({ id: doc.id, workflowId: doc.id, status: "passed", at: 1, steps: [], heals: [doc] }); return library.readRun(doc.id).heals[0] as WorkflowV2; }],
    ["kept heal", (doc) => { library.noteHealPromotion(doc.id, doc); return library.readKeptHeal(doc.id) as WorkflowV2; }],
    ["version", (doc) => { library.save(doc); const row = draftVersion(library, doc, "edit"); return versionDocument(library, doc.id, row.n); }],
    ["intent eval", (doc) => { library.saveIntentEval(doc.id, doc); return library.readIntentEval(doc.id) as WorkflowV2; }],
    ["teach case", (doc) => { library.saveTeachIntentCase(doc.id, doc); return json(`evals/intent/cases/${doc.id}.json`); }],
  ];
  for (const value of ["collision", 0, -17, "type", "input", "4111111111111111", "sk-fixtureToken", "{{password}}", STRIPPED_SECRET]) {
    const metadata = {
      id: value, name: value, label: value, text: value, value, default: value, rows: [value], args: { value },
      reason: value, summary: value, placeholder: value, url: value, selector: value, role: value,
      source: { agent: value, vendor: value, adapter: value, model: value }, model: { provider: value, name: value, version: value },
      inference: { provider: value, model: value, status: value, at: value },
      media: { png: value, image: value, video: value },
      locators: [{ kind: "text", value, name: value }], options: [{ value, label: value }], marker: STRIPPED_SECRET,
    };
    const signed = { kind: "read-back", expected: value, actual: value, hash: "signed", prev: "", detail: typed(value) };
    const payload = { ...metadata, receipt: signed, workflow: { schema: "bao.workflow/v2", inputs: [], steps: [{ action: "type", value }] } };
    const strippedPayload = Object.fromEntries(Object.entries(payload).map(([key, item]) => [key, stripPayload(item, value)]));
    const rows: [string, unknown, unknown][] = [
      ["step", { action: "type", sensitive: true, value }, { action: "type", sensitive: true, value: STRIPPED_SECRET, unresolved: { reason: NEEDS_SECRET_VALUE } }],
      ["inserting key", { action: "key", sensitive: true, key: String(value) }, { action: "key", sensitive: true, key: STRIPPED_SECRET, unresolved: { reason: NEEDS_SECRET_VALUE } }],
      ["input default", { schema: "bao.workflow/v2", inputs: [{ name: "payload", type: "text", default: payload }], steps: [] }, { schema: "bao.workflow/v2", inputs: [{ name: "payload", type: "text", default: strippedPayload }], steps: [] }],
      ["unmarked choice", { op: "select", value, identity: { ...FIELD, tag: "select" }, options: [{ value }] }, { op: "select", value, identity: { ...FIELD, tag: "select" }, options: [{ value }] }],
      ["marked choice", { op: "select", sensitive: true, value, identity: { ...FIELD, tag: "select" }, options: [{ value }] }, { op: "select", sensitive: true, value: STRIPPED_SECRET, identity: { ...FIELD, tag: "select" }, options: [{ value }] }],
      ["trail", { ...typed(value), text: value }, { ...typed(STRIPPED_SECRET), text: STRIPPED_SECRET }],
      ["effects", { op: "click", identity: FIELD, valueBefore: value, valueAfter: value, endValue: value }, { op: "click", identity: FIELD, valueBefore: STRIPPED_SECRET, valueAfter: STRIPPED_SECRET, endValue: STRIPPED_SECRET }],
      ["dialog", { op: "dialog", dialogType: "prompt", dialogValue: value }, { op: "dialog", dialogType: "prompt", dialogValue: STRIPPED_SECRET }],
      ["field", { identity: { ...FIELD, value }, value }, { identity: { ...FIELD, value: STRIPPED_SECRET }, value: STRIPPED_SECRET }],
      ["arguments", { op: "type", args: payload }, { op: "type", args: strippedPayload }],
      ["runtime inputs", { workflowId: "matrix", inputs: { payload }, publicInputs: { payload } }, { workflowId: "matrix", inputs: { payload: strippedPayload }, publicInputs: { payload: strippedPayload } }],
      ["captured cells", { op: "copy", list: { headers: [String(value)], rows: [{ [String(value)]: value }] } }, { op: "copy", list: { headers: [String(value)], rows: [{ [String(value)]: STRIPPED_SECRET }] } }],
      ["outputs", { runId: "run", outputs: [{ type: "table", columns: [{ name: value }], rows: [{ cell: value }] }, { type: "text", name: value, value }] }, { runId: "run", outputs: [{ type: "table", columns: [{ name: value }], rows: [{ cell: STRIPPED_SECRET }] }, { type: "text", name: value, value: STRIPPED_SECRET }] }],
      ["unsigned read-back", { kind: "read-back", expected: value, actual: value, prev: value }, { kind: "read-back", expected: STRIPPED_SECRET, actual: STRIPPED_SECRET, prev: value }],
      ["signed read-back", signed, signed],
      ["signed result copy", { workflowId: "matrix", receipts: [signed] }, { workflowId: "matrix", receipts: [signed] }],
      ["receipt-shaped captured cells", { op: "copy", list: { rows: [{ cell: signed }] } }, { op: "copy", list: { rows: [{ cell: stripPayload(signed, value) }] } }],
      ["MCP result", { workflowId: "matrix", receipts: [{ id: value, status: value, readBack: value }] }, { workflowId: "matrix", receipts: [{ id: value, status: value, readBack: STRIPPED_SECRET }] }],
      ["teaching replay", { schema: "bao.intent-case/v1", secrets: [value], replays: [{ texts: [value], secret: value, file: value }] }, { schema: "bao.intent-case/v1", secrets: [STRIPPED_SECRET], replays: [{ texts: [STRIPPED_SECRET], secret: STRIPPED_SECRET, file: value }] }],
    ];
    for (const [location, record, expected] of rows) {
      const doc = {
        schema: "bao.workflow/v2", version: 2, id: "matrix", name: String(value), createdAt: 1, startUrl: "https://example.test/", inputs: [], steps: [],
        artifact: { evidence: typed(value), record, metadata },
      } as WorkflowV2 & { artifact: { record: unknown; metadata: unknown } };
      const original = structuredClone(doc);
      for (const [writer, save] of writers) {
        const saved = save(doc) as typeof doc;
        assert.deepEqual(saved.artifact.record, expected, `${writer} / ${location} / ${value}`);
        assert.deepEqual(saved.artifact.metadata, metadata, `${writer} changed metadata / ${location} / ${value}`);
        assert.deepEqual(doc, original);
        assert.deepEqual(scrubSaved(saved), saved);
      }
    }
    assert.equal(scrubSaved(value, { secrets: [String(value)] }), value);
    assert.deepEqual(scrubSaved({ screenshot: value }, { secrets: [String(value)] }), { screenshot: value });
  }
});

function stripPayload(item: unknown, value: unknown): unknown {
  if (item === value) return STRIPPED_SECRET;
  if (Array.isArray(item)) return item.map((child) => stripPayload(child, value));
  if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, stripPayload(child, value)]));
  return item;
}

test("receipts strip owned values before hashing and retain hash metadata on later saves", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-allowlist-receipt-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const log = new ReceiptLog(path.join(home, "new.receipts.jsonl"));
  const body = { kind: "read-back" as const, ts: 1, runId: "run", workflowId: "matrix", stepId: "entry", source: "value" as const, expected: "collision", actual: "collision", pass: true };
  const first = log.append(body, { secrets: ["collision", "value", "matrix", "entry"] });
  log.append(body, { secrets: ["collision"] });
  assert.equal(first.expected, STRIPPED_SECRET);
  assert.equal(first.actual, STRIPPED_SECRET);
  assert.equal(first.source, "value");
  assert.equal(first.workflowId, "matrix");
  assert.equal(body.actual, "collision");
  assert.equal(verifyReceiptChain(log.entries), true);
  library.saveRun({ id: "run", workflowId: "matrix", status: "passed", at: 1, steps: [], heals: [], receipts: log.entries });
  assert.deepEqual(library.readRun("run").receipts, log.entries);
  library.saveTrail("matrix", log.entries);
  library.appendTrail("matrix", { workflowId: "matrix", receipts: log.entries });
  const trail = library.readTrail("matrix") as [Receipt, Receipt, { receipts: Receipt[] }];
  assert.deepEqual(trail.slice(0, 2), log.entries);
  assert.equal(verifyReceiptChain(trail[2].receipts), true);
  assert.equal(verifyReceiptChain(library.readRun("run").receipts as Receipt[]), true);
});

test("historical signed receipt owners stay intact through writers and cleanup", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-signed-receipt-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const card = "4111111111111111";
  const shared = typed(card);
  const make = (prev: string, actual: string): Receipt => {
    const body = { kind: "read-back" as const, ts: 1, runId: "legacy", workflowId: "matrix", stepId: "entry", source: "value" as const, expected: card, actual, pass: true, prev,
      detail: { workflowId: "matrix", inputs: { password: card }, evidence: shared } };
    return { ...body, hash: hashReceipt(body) };
  };
  const first = make("", card);
  const receipts = [first, make(first.hash, "collision")];
  const original = structuredClone(receipts);
  assert.equal(verifyReceiptChain(receipts), true);
  const aliased = scrubSaved({ receipt: first, shared });
  assert.deepEqual(aliased.receipt, first);
  assert.equal(aliased.shared.value, STRIPPED_SECRET);
  const bytes = receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n";
  const chain = path.join(home, "runs/legacy.receipts.jsonl");
  writeFileSync(chain, bytes);
  const run = { id: "legacy", workflowId: "matrix", status: "passed", at: 1, steps: [], heals: [], receipts, inputs: { password: card } };
  library.saveRun(run);
  library.saveTrail("matrix", receipts);
  library.appendTrail("matrix", { workflowId: "matrix", receipts });
  const check = () => {
    const saved = library.readRun("legacy");
    assert.deepEqual(saved.receipts, receipts);
    assert.equal(verifyReceiptChain(saved.receipts as Receipt[]), true);
    assert.deepEqual(saved.inputs, { password: STRIPPED_SECRET });
    const trail = library.readTrail("matrix") as [Receipt, Receipt, { receipts: Receipt[] }];
    assert.deepEqual(trail.slice(0, 2), receipts);
    assert.deepEqual(trail[2].receipts, receipts);
    assert.equal(verifyReceiptChain(trail.slice(0, 2) as Receipt[]), true);
    assert.equal(verifyReceiptChain(trail[2].receipts), true);
    assert.equal(readFileSync(chain, "utf8"), bytes);
    assert.deepEqual(receipts, original);
  };
  check();
  writeFileSync(path.join(home, "runs/legacy.json"), JSON.stringify(run));
  const trailBytes = JSON.stringify([...receipts, { workflowId: "matrix", receipts }]);
  writeFileSync(path.join(home, "trails/matrix.json"), trailBytes);
  const dry = scrubHome(home);
  assert.deepEqual(dry.files, ["runs/legacy.json"]);
  assert.equal(readFileSync(path.join(home, "runs/legacy.json"), "utf8"), JSON.stringify(run));
  const written = scrubHome(home, true);
  assert.deepEqual(written.files, dry.files);
  check();
  assert.equal(readFileSync(path.join(home, "trails/matrix.json"), "utf8"), trailBytes);
  assert.deepEqual(scrubHome(home, true).files, []);
  const raw = { receipt: first };
  const cleaned = scrubSaved(raw, { args: raw, secrets: ["collision"] });
  assert.equal(cleaned.receipt.expected, STRIPPED_SECRET);
  assert.equal(cleaned.receipt.actual, STRIPPED_SECRET);
  assert.equal(first.actual, card);
});
