import assert from "node:assert/strict";
import test from "node:test";
import { runRecordStatus, runStatusWord } from "../../src/v1/run-status";

test("a failed replay reads as failed, not refused", () => {
  assert.equal(runRecordStatus({ outcome: "failed" }), "failed");
  assert.equal(runStatusWord("failed"), "failed");
  assert.equal(runStatusWord("timed-out"), "failed");
  assert.equal(runStatusWord("refused"), "failed");
});

test("a sign-in wait reads as waiting for sign-in", () => {
  assert.equal(runRecordStatus({ outcome: "paused", pausedKind: "signin" }), "waiting-for-sign-in");
  assert.equal(runStatusWord("waiting-for-sign-in"), "waiting for sign-in");
  assert.equal(runStatusWord("needs_signin"), "waiting for sign-in");
});
