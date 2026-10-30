// A miss is sorted before a model sees it. Only a real change is healed.
// A temporary blocker and an outage stop the run. A burst of failures opens
// the circuit and auto-heal stays off until the window clears.

export type FailureClass = "change" | "blocker" | "outage";

export interface ClassifiedFailure {
  phase?: string;
  reason?: string;
  brokenAttr?: string;
  identity?: { changed?: string };
}

const OUTAGE = /net::|ERR_|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|target closed|page closed|browser has been closed|navigation|status (?:500|502|503|504)|\b50[234]\b/i;
const BLOCKER = /\bwaiting\b|overlay|spinner|not stable|intercept|detached|animat|\bdisabled\b|^gone:/i;

export function classifyFailure(failure: ClassifiedFailure): FailureClass {
  const reason = failure.reason || "";
  if (OUTAGE.test(reason)) return "outage";
  if (failure.phase === "wait_for" || BLOCKER.test(reason)) return "blocker";
  return "change";
}

export const DEFAULT_CIRCUIT_LIMIT = 3;
export const DEFAULT_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;

export interface RunStamp {
  status: string;
  at: number;
}

export const STEP_REVIEW_LIMIT = 3;

export interface HealStamp {
  at?: number;
  workflowId: string;
  heals?: { failedStep?: { id?: string; label?: string } }[];
  steps?: { id?: string; status?: string; triage?: string }[];
}

export interface StepReview {
  workflowId: string;
  stepId: string;
  label: string;
  streak: number;
}

/**
 * Newest runs first. A heal, or a run stopped because auto-heal was already off,
 * keeps the streak. A pass with no heal clears it. A run that never reached the
 * step is ignored.
 */
export function consecutiveHeals(runs: HealStamp[], stepId: string): number {
  const ordered = [...runs].sort((a, b) => (b.at || 0) - (a.at || 0));
  let count = 0;
  for (const run of ordered) {
    const healed = (run.heals || []).some((heal) => heal.failedStep?.id === stepId);
    if (healed) {
      count += 1;
      continue;
    }
    const step = (run.steps || []).find((item) => item.id === stepId);
    if (step?.triage === "review") {
      count += 1;
      continue;
    }
    if (!step || step.status === "skipped" || step.status === "pending") continue;
    break;
  }
  return count;
}

/** A step that healed itself on `limit` consecutive runs. Auto-heal stays off for it. */
export function stepsNeedingReview(runs: HealStamp[], limit = STEP_REVIEW_LIMIT): StepReview[] {
  const seen = new Map<string, { workflowId: string; stepId: string; label: string }>();
  for (const run of runs) {
    for (const heal of run.heals || []) {
      const stepId = heal.failedStep?.id;
      if (!stepId) continue;
      const key = `${run.workflowId}\0${stepId}`;
      if (!seen.has(key)) seen.set(key, { workflowId: run.workflowId, stepId, label: heal.failedStep?.label || stepId });
    }
  }
  const out: StepReview[] = [];
  for (const item of seen.values()) {
    const mine = runs.filter((run) => run.workflowId === item.workflowId);
    const streak = consecutiveHeals(mine, item.stepId);
    if (streak >= limit) out.push({ ...item, streak });
  }
  return out;
}

/** True when `limit` runs have already failed inside the window. */
export function circuitOpen(
  runs: RunStamp[],
  now: number,
  opts: { limit?: number; windowMs?: number } = {},
): boolean {
  const limit = opts.limit ?? DEFAULT_CIRCUIT_LIMIT;
  const windowMs = opts.windowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
  if (limit <= 0) return false;
  const failed = runs.filter((run) => run.status === "failed" && now - run.at <= windowMs && now >= run.at);
  return failed.length >= limit;
}
