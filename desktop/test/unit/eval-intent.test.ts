import assert from "node:assert/strict";
import test from "node:test";
import { canonical } from "../../src/v1/canonical";
import { condense } from "../../src/v1/condense";
import { validateWorkflow } from "../../src/v1/schema";
import { INTENT_CASES, noisyTrail } from "../../src/eval/intent/cases";
import {
  deterministicWorkflow,
  expectedHuman,
  humanKeys,
  multisetScore,
  replayCase,
  scoreParams,
  stepSignature,
  textDefaults,
  truthTexts,
  truthWorkflow,
} from "../../src/eval/intent/score";

test("sixteen ground-truth trails condense through noise and replay twice", async () => {
  assert.ok(INTENT_CASES.length >= 16);
  assert.ok(INTENT_CASES.length <= 20);
  for (const item of INTENT_CASES) {
    const truth = truthWorkflow(item);
    assert.deepEqual(validateWorkflow(truth), [], item.id);
    assert.deepEqual(humanKeys(truth).sort(), expectedHuman(item).sort(), item.id);
    const noisy = noisyTrail(item.events);
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
