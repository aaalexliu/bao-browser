import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { agreementRate, parseJudgeSheet, runJudgeAgree, unlabeled } from "../../src/eval/judge-agree";
import { diffNightly, formatRegression, type NightlyResults } from "../../src/eval/nightly/result";

test("a deliberate regression names heldout/batch5/node-synopsis step node-synopsis-0", () => {
  const baseline: NightlyResults = {
    generated: "2026-10-22T00:00:00.000Z",
    cases: [{
      caseId: "heldout/batch5/node-synopsis",
      passed: true,
      detail: "pass",
      steps: [{ stepId: "node-synopsis-0", passed: true, detail: "" }],
    }],
  };
  const current: NightlyResults = {
    generated: "2026-10-22T01:00:00.000Z",
    cases: [{
      caseId: "heldout/batch5/node-synopsis",
      passed: false,
      detail: "no-candidates",
      steps: [{ stepId: "node-synopsis-0", passed: false, detail: "no-candidates" }],
    }],
  };
  const found = diffNightly(baseline, current).map(formatRegression);
  assert.deepEqual(found, [
    "regression heldout/batch5/node-synopsis step node-synopsis-0: expected pass, got fail (no-candidates)",
  ]);
});

test("a passing step that stays passing is not a regression", () => {
  const results: NightlyResults = {
    generated: "2026-10-22T00:00:00.000Z",
    cases: [{
      caseId: "drift/browser-form/shift",
      passed: true,
      detail: "pass",
      steps: [{ stepId: "0:Type {{username}}", passed: true, detail: "" }],
    }],
  };
  assert.deepEqual(diffNightly(results, results), []);
});

test("agreement is the share of rows where the person and the judge match", () => {
  const score = agreementRate([
    { human: true, judge: true },
    { human: false, judge: false },
    { human: true, judge: false },
    { human: false, judge: true },
  ]);
  assert.equal(score.agree, 2);
  assert.equal(score.n, 4);
  assert.equal(score.rate, 0.5);
});

test("the judge sheet leaves every label empty", async () => {
  const rows = parseJudgeSheet(readFileSync("docs/evals/judge-labels.md", "utf8"));
  assert.ok(rows.length >= 18 && rows.length <= 22);
  assert.equal(unlabeled(rows).length, rows.length);
  assert.equal(new Set(rows.map((row) => row.intent)).size, rows.length);
  const result = await runJudgeAgree("docs/evals/judge-labels.md");
  assert.equal(result.code, 2);
  assert.match(result.text, /0\/\d+ labels filled/);
});
