// One nightly run compared with the last saved run.
// A regression names the case and the step that stopped passing.

import type { TrajectoryStep } from "../../v1/trajectory";

export interface NightlyStep {
  stepId: string;
  passed: boolean;
  detail: string;
}

export interface NightlyCase {
  caseId: string;
  passed: boolean;
  detail: string;
  steps: NightlyStep[];
}

export interface NightlyResults {
  generated: string;
  cases: NightlyCase[];
}

export interface SuiteCase extends NightlyCase {
  trajectory: TrajectoryStep[];
}

export interface Regression {
  caseId: string;
  stepId: string;
  detail: string;
}

export function formatRegression(item: Regression): string {
  return `regression ${item.caseId} step ${item.stepId}: ${item.detail}`;
}

/** A case that failed after every recorded step passed is an oracle miss. */
export function withOracle(passed: boolean, steps: readonly NightlyStep[], detail: string): NightlyStep[] {
  if (passed || steps.some((step) => !step.passed)) return steps.slice();
  return [...steps, { stepId: "oracle", passed: false, detail }];
}

export function diffNightly(baseline: NightlyResults, current: NightlyResults): Regression[] {
  const now = new Map(current.cases.map((item) => [item.caseId, item]));
  const out: Regression[] = [];
  for (const prev of baseline.cases) {
    const next = now.get(prev.caseId);
    if (!next) {
      out.push({
        caseId: prev.caseId,
        stepId: prev.steps[0]?.stepId || "missing",
        detail: "case missing on this run",
      });
      continue;
    }
    const seen = new Set<string>();
    for (const step of prev.steps) {
      seen.add(step.stepId);
      const got = next.steps.find((item) => item.stepId === step.stepId);
      if (!got) {
        if (step.passed) {
          out.push({ caseId: prev.caseId, stepId: step.stepId, detail: "step missing on this run" });
        }
        continue;
      }
      if (step.passed && !got.passed) {
        out.push({
          caseId: prev.caseId,
          stepId: step.stepId,
          detail: `expected pass, got fail (${got.detail || next.detail || "fail"})`,
        });
      }
    }
    for (const step of next.steps) {
      if (seen.has(step.stepId) || step.passed) continue;
      out.push({
        caseId: prev.caseId,
        stepId: step.stepId,
        detail: `expected pass, got fail (${step.detail || next.detail || "fail"})`,
      });
    }
    if (prev.passed && !next.passed && !out.some((item) => item.caseId === prev.caseId)) {
      out.push({
        caseId: prev.caseId,
        stepId: next.steps.at(-1)?.stepId || "case",
        detail: `expected pass, got fail (${next.detail || "fail"})`,
      });
    }
  }
  return out;
}
