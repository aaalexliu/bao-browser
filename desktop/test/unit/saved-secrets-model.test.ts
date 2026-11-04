import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { LIVE_SOURCE, typeTrailEvent } from "../../src/mcp/live";
import { LIVE_TRAIL_SOURCE } from "../../src/cdp-live/live-trail";
import { inferSavedWorkflow } from "../../src/v1/save-intent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HealRecord } from "../../src/v1/heal";
import { healDetail } from "../../src/app/views";
import { Library } from "../../src/v1/store";
import { STRIPPED_SECRET } from "../../../shared/saved-secrets";
import type { WorkflowV2 } from "../../src/v1/schema";

const model = { provider: "openai", name: "gpt-4o", version: "test" };
const inference = { at: 1, provider: model.provider, model: model.name, status: "ok" as const };

function workflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "models", name: "Models", createdAt: 1,
    startUrl: "https://example.test/", inference,
    inputs: [
      { name: "password", type: "secret" }, { name: "other", type: "secret" },
      { name: "revision", type: "secret" },
      { name: "payload", type: "text", default: model.name },
    ],
    steps: [{ id: "entry", index: 0, action: "type", surface: "dom", label: "Fill", timeoutMs: 0, sensitive: true, input: "password", value: "{{password}}" }],
  };
}

function heal(doc: WorkflowV2): HealRecord {
  return {
    id: "heal", ts: 1, workflowId: doc.id, runId: "run", mode: "auto", failedStep: { ...doc.steps[0]! },
    intent: "Fill", snapshot: {}, prompt: "", model, kept: true,
  };
}

test("persisted model identifiers stay stable without exempting argument, default or row payloads", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-model-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = workflow();
  const privateArgs = { password: model.provider, other: model.name, revision: model.version };
  const payload = { model, inference, source: { model: model.name }, rows: [model] };
  const metadata = { args: payload, publicInputs: payload, default: payload, rows: [payload] };
  const run = {
    id: "run", workflowId: doc.id, status: "failed", at: 1, inputs: { ...privateArgs, payload },
    steps: [{ op: "type", ...metadata }, metadata, { op: "extract", list: { headers: Object.keys(model), rows: [model] } }],
    outputs: [{ name: "models", type: "table", columns: Object.keys(model).map((name) => ({ name, type: "text" })), rows: [model] }],
    heals: [heal(doc)],
  };
  const original = structuredClone({ doc, run });
  library.save(doc);
  library.saveRun(run as unknown as Parameters<Library["saveRun"]>[0]);
  const saved = JSON.parse(readFileSync(path.join(home, "runs/run.json"), "utf8"));
  assert.deepEqual(saved.heals[0].model, model);
  assert.deepEqual(saved.inputs.password, STRIPPED_SECRET);
  assert.deepEqual(saved.inputs.other, STRIPPED_SECRET);
  assert.deepEqual(saved.inputs.revision, STRIPPED_SECRET);
  const strippedModel = { provider: STRIPPED_SECRET, name: STRIPPED_SECRET, version: STRIPPED_SECRET };
  for (const data of [saved.inputs.payload, saved.steps[0].args, saved.steps[0].publicInputs]) {
    assert.deepEqual(data.model, strippedModel);
    assert.equal(data.inference.provider, STRIPPED_SECRET);
    assert.equal(data.inference.model, STRIPPED_SECRET);
    assert.equal(data.source.model, STRIPPED_SECRET);
    assert.deepEqual(data.rows, [strippedModel]);
  }
  assert.deepEqual(saved.steps[0].default, payload);
  assert.deepEqual(saved.steps[0].rows, [payload]);
  assert.deepEqual(saved.steps[1], metadata);
  assert.deepEqual(saved.steps[2].list.rows, [strippedModel]);
  assert.deepEqual(saved.outputs[0].rows, [strippedModel]);
  const rendered = healDetail({ id: saved.id, workflowId: saved.workflowId, status: saved.status }, saved.heals[0]);
  assert.ok(rendered.includes("gpt-4o test"));
  assert.deepEqual({ doc, run }, original);

  const defaults = workflow();
  defaults.inputs[0]!.default = model.provider;
  defaults.inputs[1]!.default = model.name;
  defaults.inputs[2]!.default = model.version;
  library.save(defaults);
  const stored = JSON.parse(readFileSync(path.join(home, "workflows/models.json"), "utf8"));
  assert.deepEqual(stored.inference, inference);
  assert.deepEqual(stored.inputs.map((input: { default: string }) => input.default), [STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET]);
  assert.deepEqual(library.read(doc.id).inference, inference);

  library.noteHealPromotion(doc.id, heal(doc));
  assert.deepEqual((library.readKeptHeal(doc.id) as HealRecord).model, model);
  library.saveTrail(doc.id, [{ op: "type", sensitive: true, value: model.name, source: { agent: "live-model", vendor: "bao", model: model.name }, model }]);
  const trail = JSON.parse(readFileSync(path.join(home, "trails/models.json"), "utf8"));
  assert.deepEqual(trail[0].model, model);
  assert.equal(trail[0].source.model, model.name);
  assert.equal(trail[0].value, STRIPPED_SECRET);
  assert.deepEqual(model, { provider: "openai", name: "gpt-4o", version: "test" });
});

test("canonical scalar records survive collisions while their payload copies strip", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-source-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const sources = [
    LIVE_SOURCE, LIVE_TRAIL_SOURCE, { agent: "mcp", vendor: "bao", adapter: "stdio" },
    { agent: "scripted-driver", vendor: "configured-vendor", adapter: "configured-model", model: "configured-model" },
  ];
  for (const [index, source] of sources.entries()) {
    const payload = { source, inference, model };
    const secrets = Object.values(payload).flatMap((record) => Object.values(record).map(String));
    const args = Object.fromEntries(secrets.map((value, n) => [`private${n}`, value]));
    const doc = workflow();
    doc.inputs = Object.entries(args).map(([name, value]) => ({ name, type: "secret", default: value }));
    doc.steps = [];
    library.save(doc);
    const stored = JSON.parse(readFileSync(path.join(home, "workflows/models.json"), "utf8"));
    assert.deepEqual(stored.inputs.map((input: { default: string }) => input.default), secrets.map(() => STRIPPED_SECRET));
    const step = { op: "type", ...payload, args: payload, publicInputs: payload, default: payload, rows: [payload] };
    const original = structuredClone(step);
    library.saveRun({
      id: `source-${index}`, workflowId: doc.id, status: "passed", at: 1,
      steps: [step, { op: "extract", list: { headers: Object.keys(args), rows: [args] } }], heals: [], inputs: args,
      outputs: [{ name: "sources", type: "table", columns: Object.keys(args).map((name) => ({ name, type: "text" })), rows: [args] }],
    });
    const saved = JSON.parse(readFileSync(path.join(home, `runs/source-${index}.json`), "utf8"));
    assert.deepEqual(saved.steps[0].source, source);
    assert.deepEqual(saved.steps[0].inference, inference);
    assert.deepEqual(saved.steps[0].model, model);
    assert.ok(Object.values(saved.inputs).every((value) => value === STRIPPED_SECRET));
    const stripped = Object.fromEntries(Object.entries(payload).map(([key, record]) => [key,
      Object.fromEntries(Object.keys(record).map((field) => [field, STRIPPED_SECRET])),
    ]));
    for (const data of [saved.steps[0].args, saved.steps[0].publicInputs]) assert.deepEqual(data, stripped);
    assert.deepEqual(saved.steps[0].default, payload);
    assert.deepEqual(saved.steps[0].rows, [payload]);
    const strippedRow = Object.fromEntries(Object.keys(args).map((key) => [key, STRIPPED_SECRET]));
    assert.deepEqual(saved.steps[1].list.rows, [strippedRow]);
    assert.deepEqual(saved.outputs[0].rows, [strippedRow]);
    assert.deepEqual(step, original);
  }
  const event = typeTrailEvent("cursor", undefined, Object.values(LIVE_SOURCE));
  library.saveTrail("live", [event]);
  const saved = JSON.parse(readFileSync(path.join(home, "trails/live.json"), "utf8"));
  assert.deepEqual(saved[0].source, LIVE_SOURCE);
  assert.equal(saved[0].value, STRIPPED_SECRET);
});

test("save inference persists real successful and skipped metadata despite matching secrets", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-inference-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const status of ["ok", "skipped"] as const) {
    const doc = workflow();
    delete doc.inference;
    doc.inputs[0]!.default = status;
    const original = structuredClone(doc);
    const saved = await inferSavedWorkflow(doc, {
      floorTitle: "Models", startUrl: doc.startUrl, secrets: [status, model.provider, model.name, "101"],
    }, {
      provider: model.provider, model: model.name,
      complete: async () => status === "ok" ? JSON.stringify({ title: "Fill form", steps: [{ id: "entry", intent: "Fill the field" }] }) : "invalid-json",
    }, 101);
    library.save(saved);
    const stored = JSON.parse(readFileSync(path.join(home, "workflows/models.json"), "utf8"));
    assert.deepEqual(stored.inference, { at: 101, provider: model.provider, model: model.name, status });
    assert.equal(stored.inputs[0].default, STRIPPED_SECRET);
    assert.deepEqual(library.read(doc.id).inference, stored.inference);
    assert.deepEqual(doc, original);
  }
});

test("proxy trail preserves configured BAO_VENDOR and BAO_MODEL without invoking OS tools", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-proxy-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, "proxy.json");
  const vendor = "ghp_fixtureVendor";
  const model = "ghp_fixtureModel";
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/proxy/mcp-bao.js")], {
    input: JSON.stringify({ id: 1, method: "tools/call", params: { name: "unknown", arguments: {} } }) + "\n",
    encoding: "utf8", env: {
      ...process.env, HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0",
      BAO_WORK: path.join(home, "work"), BAO_TRAIL: file, BAO_VENDOR: vendor, BAO_MODEL: model,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(stored.source, { agent: "live-model", vendor, model });
  assert.deepEqual(stored.events, []);
});
