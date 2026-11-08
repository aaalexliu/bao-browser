import assert from "node:assert/strict";
import test from "node:test";
import { runKind, statusLabel, type RunSummary } from "../../src/app/views";

function run(status: string): RunSummary {
  return { id: "run", workflowId: "wf", status };
}

test("the run viewer and the Runs list share one status word", () => {
  assert.equal(statusLabel(runKind(run("failed"))), "failed");
  assert.equal(statusLabel(runKind(run("timed-out"))), "stopped, timed out");
  assert.equal(statusLabel(runKind(run("timeout"))), "stopped, timed out");
  assert.equal(statusLabel(runKind(run("refused"))), "failed");
  assert.equal(statusLabel(runKind(run("needs_human"))), "needs you");
  assert.equal(statusLabel(runKind(run("paused"))), "needs you");
  assert.equal(statusLabel(runKind(run("waiting-for-sign-in"))), "waiting for sign-in");
  assert.equal(statusLabel(runKind(run("needs_signin"))), "waiting for sign-in");
});
