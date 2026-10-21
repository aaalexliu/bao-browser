// Trajectory diff. Replay is compared with the recording, one step at a time:
// target identity, action, postcondition, and a coarse timing bucket.

import type { Identity, WorkflowStep, WorkflowV2 } from "./schema";

export type TimingBucket = "lt1s" | "lt10s" | "lt60s" | "slower";

export interface TrajectoryStep {
  stepId: string;
  action: string;
  target: string;
  postcondition: string;
  timing: TimingBucket;
}

export interface TrajectoryDiff {
  workflow: string;
  change: string;
  lines: string[];
}

export function timingBucket(ms: number): TimingBucket {
  if (ms < 1000) return "lt1s";
  if (ms < 10000) return "lt10s";
  if (ms < 60000) return "lt60s";
  return "slower";
}

export function bucketWords(bucket: TimingBucket): string {
  if (bucket === "lt1s") return "under 1s";
  if (bucket === "lt10s") return "under 10s";
  if (bucket === "lt60s") return "under 60s";
  return "60s or more";
}

/** Stable identity for a diff. The id wins, then the test id, then the name. */
export function targetKey(identity?: Identity): string {
  if (!identity) return "page";
  const role = identity.role || "unknown";
  if (identity.id) return `${role}#${identity.id}`;
  if (identity.testId) return `${role}[testid=${identity.testId}]`;
  if (identity.nameAttr) return `${role}[name=${identity.nameAttr}]`;
  const name = identity.name || identity.text || identity.label;
  if (name) return `${role}:${name}`;
  return role;
}

export function postKey(step: Pick<WorkflowStep, "expect" | "postcondition" | "waitFor" | "gone" | "readBack">): string {
  const parts: string[] = [];
  if (step.waitFor) parts.push(`wait_for ${step.waitFor.kind} ${step.waitFor.match || ""}`.trim());
  if (step.expect) parts.push(`${step.expect.kind} ${step.expect.match || step.expect.state || ""}`.trim());
  else if (step.postcondition) parts.push(`${step.postcondition.kind} ${step.postcondition.match || ""}`.trim());
  if (step.gone) parts.push(`gone ${step.gone.kind} ${step.gone.match || ""}`.trim());
  if (step.readBack) parts.push(`read-back ${step.readBack.source} ${step.readBack.match}`);
  return parts.filter(Boolean).join("; ") || "none";
}

export function trajectoryFromWorkflow(workflow: WorkflowV2, timings: number[] = []): TrajectoryStep[] {
  return workflow.steps.map((step, index) => ({
    stepId: step.id,
    action: step.action,
    target: targetKey(step.identity),
    postcondition: postKey(step),
    timing: timingBucket(timings[index] ?? 0),
  }));
}

export function diffTrajectory(recorded: TrajectoryStep[], replayed: TrajectoryStep[]): string[] {
  const lines: string[] = [];
  const byId = new Map(replayed.map((step) => [step.stepId, step]));
  for (const rec of recorded) {
    const got = byId.get(rec.stepId);
    if (!got) {
      lines.push(`Step ${rec.stepId} was in the recording and did not run on replay.`);
      continue;
    }
    if (rec.target !== got.target) {
      lines.push(`Step ${rec.stepId} aimed at ${rec.target} in the recording and at ${got.target} on replay.`);
    }
    if (rec.action !== got.action) {
      lines.push(`Step ${rec.stepId} used ${rec.action} in the recording and ${got.action} on replay.`);
    }
    if (rec.postcondition !== got.postcondition) {
      lines.push(`Step ${rec.stepId} expected ${rec.postcondition} in the recording and ${got.postcondition} on replay.`);
    }
    if (rec.timing !== got.timing) {
      lines.push(`Step ${rec.stepId} finished in the ${bucketWords(rec.timing)} bucket in the recording and the ${bucketWords(got.timing)} bucket on replay.`);
    }
  }
  for (const got of replayed) {
    if (!recorded.some((step) => step.stepId === got.stepId)) {
      lines.push(`Step ${got.stepId} ran on replay and was not in the recording.`);
    }
  }
  if (!lines.length) lines.push("Replay matched the recording on target, action, postcondition, and timing bucket.");
  return lines;
}

export function trajectoryMarkdown(diffs: TrajectoryDiff[]): string {
  const lines = [
    "## Trajectory",
    "",
    "Each checked replay is diffed against the recording: target identity, action, postcondition, and timing bucket. A difference here does not change the pass rate.",
    "",
  ];
  if (!diffs.length) {
    lines.push("No trajectory was checked.", "");
    return lines.join("\n");
  }
  for (const diff of diffs) {
    lines.push(`### ${diff.workflow} / ${diff.change}`, "");
    for (const line of diff.lines) lines.push(`- ${line}`);
    lines.push("");
  }
  return lines.join("\n");
}
