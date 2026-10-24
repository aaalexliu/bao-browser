import assert from "node:assert/strict";
import test from "node:test";
import { heldAverages, type HeldRow } from "../../src/eval/heldout/run";

test("invalid fixtures stay visible and drop out of the bao miss rate", () => {
  const rows = [
    row("ok", "condense", 1, 1, "pass", ""),
    row("broken", "condense", 1, 1, "body missing write tests", "libraries 404"),
    row("search", "condense", 1, 1, "url missing get", ""),
  ];
  const withInvalid = heldAverages(rows, true)[0]!;
  const without = heldAverages(rows, false)[0]!;
  assert.equal(withInvalid.replay, "1/3");
  assert.equal(without.replay, "1/2");
  assert.equal(without.n, 2);
  assert.equal(withInvalid.precision, 1);
  assert.equal(without.precision, 1);
});

function row(caseId: string, condenser: string, precision: number, recall: number, replay: string, invalid: string): HeldRow {
  return {
    caseId,
    condenser,
    stepPrecision: precision,
    stepRecall: recall,
    paramRecall: 1,
    secret: 1,
    humanPrecision: 1,
    humanRecall: 1,
    modelHumanRecall: null,
    modelSecretRecall: null,
    judge: null,
    replay,
    modelCalls: 0,
    tokens: null,
    note: "",
    invalid,
  };
}
