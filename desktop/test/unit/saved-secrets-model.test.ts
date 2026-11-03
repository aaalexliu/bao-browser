import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HealRecord } from "../../src/v1/heal";
import { healDetail } from "../../src/app/views";
import { Library } from "../../src/v1/store";
import { STRIPPED_SECRET } from "../../src/v1/saved-secrets";
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
  const run = { id: "run", workflowId: doc.id, status: "failed", at: 1, inputs: { ...privateArgs, payload }, steps: [{ args: payload, publicInputs: payload, default: payload, rows: [payload] }], heals: [heal(doc)] };
  const original = structuredClone({ doc, run });
  library.save(doc);
  library.saveRun(run as unknown as Parameters<Library["saveRun"]>[0]);
  const saved = JSON.parse(readFileSync(path.join(home, "runs/run.json"), "utf8"));
  assert.deepEqual(saved.heals[0].model, model);
  assert.deepEqual(saved.inputs.password, STRIPPED_SECRET);
  assert.deepEqual(saved.inputs.other, STRIPPED_SECRET);
  assert.deepEqual(saved.inputs.revision, STRIPPED_SECRET);
  const strippedModel = { provider: STRIPPED_SECRET, name: STRIPPED_SECRET, version: STRIPPED_SECRET };
  for (const data of [saved.inputs.payload, saved.steps[0].args, saved.steps[0].publicInputs, saved.steps[0].default, saved.steps[0].rows[0]]) {
    assert.deepEqual(data.model, strippedModel);
    assert.equal(data.inference.provider, STRIPPED_SECRET);
    assert.equal(data.inference.model, STRIPPED_SECRET);
    assert.equal(data.source.model, STRIPPED_SECRET);
    assert.deepEqual(data.rows, [strippedModel]);
  }
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
  assert.equal(stored.inputs[3].default, STRIPPED_SECRET);
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
