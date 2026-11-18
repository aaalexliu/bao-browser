import assert from "node:assert/strict";
import test from "node:test";
import { runAttention, runReceipt, runsList, runWorkflowName, type RunSummary } from "../../src/app/views";

test("saved-workflow replays keep Needs you when the page engine is agent-browser", () => {
  const now = Date.UTC(2026, 10, 6, 18);
  const reason = "The Download PDF button is gone.";
  const ask = "Retry the download from the account page.";
  const failed: RunSummary = {
    id: "r", workflowId: "bill", kind: "replay", pageEngine: "agent-browser", status: "failed", at: now - 1000,
    failure: { index: 0, reason }, heals: [{ id: "h1" }], envelope: { status: "failed", ask },
  };
  const paused: RunSummary = {
    id: "paused-bill", workflowId: "bill", kind: "replay", pageEngine: "agent-browser", status: "paused", at: now, heals: [],
  };
  const workflows = [{ id: "bill", name: "Download the bill", steps: 4 }];
  assert.deepEqual(runAttention([failed, paused]).map((item) => [item.run.id, item.label]), [
    ["paused-bill", "Needs you"],
    ["r", "Heal to keep"],
    ["r", "Failed"],
  ]);
  assert.equal(runWorkflowName(failed, workflows), "Download the bill");
  assert.equal(runWorkflowName(paused, workflows), "Download the bill");
  assert.equal(runWorkflowName(failed, []), "Workflow unavailable");
  const html = runsList([failed, paused], workflows, "", now);
  assert.match(html, /id="needs-you-heading"[\s\S]*?>3</);
  assert.match(html, /data-open-run="paused-bill"[\s\S]*?>Needs you</);
  assert.match(html, /data-heal="h1"[\s\S]*?>Heal to keep</);
  assert.match(html, /data-open-run="r"[\s\S]*?>Failed<\/span> · Stopped at step 1\.</);
  assert.match(html, /Stopped at step 1 of 4/);
  assert.match(html, /class="run-extra">The Download PDF button is gone\.</);
  assert.match(html, /aria-label="Download the bill"/);
  assert.doesNotMatch(html, /Browser session/);
  const receipt = runReceipt({
    view: "receipt",
    run: { id: "r", workflowId: "bill", name: "Download the bill", status: "failed", at: now, kind: "replay", stepCount: 4, modelCalls: null, healCount: 1 },
    reason, handoff: { status: "failed", ask, reason, deadline: undefined },
    steps: [], stepOffset: 0, nextStepOffset: null, workflow: null,
  }, "Download the bill", failed);
  assert.match(receipt, /Retry the download from the account page\./);
  assert.match(receipt, /The Download PDF button is gone\./);
  assert.match(receipt, /<h2>Download the bill<\/h2>/);
});
