import assert from "node:assert/strict";
import test from "node:test";
import { canonical } from "../../src/v1/canonical";
import { condense } from "../../src/v1/condense";
import { applyHybrid } from "../../src/v1/hybrid";
import { validateWorkflow } from "../../src/v1/schema";
import { INTENT_CASES, noisyTrail } from "../../src/eval/intent/cases";
import { HAND_LABELS } from "../../src/eval/intent/labels";
import {
  deterministicWorkflow,
  expectedHuman,
  humanKeys,
  multisetScore,
  replayCase,
  scoreParams,
  stepSignature,
  targetOf,
  textDefaults,
  truthLiterals,
  truthTexts,
  truthWorkflow,
} from "../../src/eval/intent/score";

test("ground-truth trails condense through noise and replay twice", async () => {
  assert.ok(INTENT_CASES.length >= 16);
  assert.ok(INTENT_CASES.length <= 20);
  assert.equal(HAND_LABELS.length, 10);
  for (const item of INTENT_CASES) {
    const truth = truthWorkflow(item);
    assert.deepEqual(validateWorkflow(truth), [], item.id);
    assert.deepEqual(humanKeys(truth).sort(), expectedHuman(item).sort(), item.id);
    const noisy = noisyTrail(item.events, item.noise);
    const once = condense(noisy, { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
    const twice = condense(noisy, { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
    assert.equal(canonical(once), canonical(twice), item.id);
    const steps = multisetScore(truth.steps.map(stepSignature), once.steps.map(stepSignature));
    assert.deepEqual(steps.missing, [], item.id);
    assert.deepEqual(steps.extras, ["click|help|-|-"], item.id);
    assert.equal(steps.recall, 1, item.id);
    const params = scoreParams(once, item);
    assert.deepEqual(params.leaked, [], item.id);
    assert.equal(params.secret, 1, item.id);
    assert.deepEqual(textDefaults(once), truthTexts(item), item.id);
    assert.equal(params.recall, 1, item.id);
    assert.deepEqual(humanKeys(once).sort(), expectedHuman(item).sort(), item.id);
    for (const spec of item.replays) {
      const run = await replayCase(once, item, spec);
      assert.equal(run.modelCalls, 0, item.id);
      assert.equal(run.status, "passed", `${item.id} ${run.reason}`);
      assert.equal(run.oracle, null, `${item.id} ${run.oracle}`);
    }
  }
});

test("condense drops a scroll, a typo, and an aborted coupon path", () => {
  const item = INTENT_CASES.find((entry) => entry.id === "save-name");
  assert.ok(item);
  const noisy = noisyTrail(item.events);
  assert.ok(noisy.some((event) => event.op === "scroll"));
  assert.ok(noisy.some((event) => event.op === "key" && event.key === "Backspace"));
  assert.ok(noisy.some((event) => event.identity?.name === "Coupon"));
  const workflow = deterministicWorkflow(item);
  const blob = canonical(workflow);
  assert.equal(blob.includes("NOPE"), false);
  assert.equal(blob.includes("scroll"), false);
  assert.equal(workflow.inputs.find((input) => input.name === "name")?.default, "Ada");
});

test("a long abort is dropped and a currency value stays a literal", () => {
  const abort = INTENT_CASES.find((entry) => entry.id === "long-abort");
  const fare = INTENT_CASES.find((entry) => entry.id === "fare");
  assert.ok(abort);
  assert.ok(fare);
  const noisy = noisyTrail(abort.events, "long");
  const opener = noisy.findIndex((event) => event.identity?.name === "Shipping");
  const end = noisy.findIndex((event) => event.identity?.name === "Cancel");
  assert.ok(end - opener + 1 > abort.events.length);
  const dropped = deterministicWorkflow(abort);
  const blob = JSON.stringify(dropped);
  assert.equal(blob.includes("1 Main"), false);
  assert.equal(blob.includes("Shipping"), false);
  assert.equal(dropped.inputs.map((input) => input.name).join(","), "title");
  const priced = deterministicWorkflow(fare);
  assert.deepEqual(priced.inputs.map((input) => input.name), ["amount"]);
  const currency = priced.steps.find((step) => targetOf(step) === "currency");
  assert.equal(currency?.input, undefined);
  assert.equal(currency?.value, "USD");
  assert.deepEqual(truthLiterals(fare), ["USD"]);
  assert.deepEqual(textDefaults(priced), truthTexts(fare));
});

test("hybrid can drop help and cannot drop a param or keep a secret literal", () => {
  const item = INTENT_CASES.find((entry) => entry.id === "save-name");
  assert.ok(item);
  const base = deterministicWorkflow(item);
  const help = base.steps.find((step) => targetOf(step) === "help");
  const typed = base.steps.find((step) => step.action === "type");
  assert.ok(help);
  assert.ok(typed);
  const applied = applyHybrid(base, {
    drop: [help.id, typed.id, "made-up"],
    summary: "Save Ada now",
    steps: base.steps.map((step) => ({ id: step.id, intent: `Use SuperSecretPassword! then ${step.label}` })),
    human: [{ id: typed.id, gate: "confirm" }],
  }, ["SuperSecretPassword!"]);
  assert.equal(applied.workflow.steps.some((step) => step.id === help.id), false);
  assert.equal(applied.workflow.steps.some((step) => step.id === typed.id), true);
  assert.deepEqual(applied.refused, [typed.id]);
  assert.deepEqual(applied.ignored, ["made-up"]);
  assert.deepEqual(applied.workflow.inputs, base.inputs);
  assert.equal(applied.workflow.steps.find((step) => step.id === typed.id)?.gate, typed.gate);
  assert.equal(applied.workflow.steps.find((step) => step.id === typed.id)?.value, typed.value);
  assert.equal(applied.workflow.summary?.includes("Ada"), false);
  assert.equal(JSON.stringify(applied.workflow.steps).includes("SuperSecretPassword!"), false);
  assert.deepEqual(validateWorkflow(applied.workflow), []);
});
