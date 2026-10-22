// A "you need to act" prompt lives in the app home (BAO_HOME) so closing the
// window does not drop it. Launch reads it back. Past the deadline, the prompt
// is removed and the run is marked stopped, timed out.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HumanAsk } from "./human-ask";
import type { StoredRun } from "./store";

export const TIMED_OUT = "stopped, timed out";
export const TIMED_OUT_STATUS = "timed-out";

export interface PendingPrompt {
  ask: HumanAsk;
  runId: string;
}

const FILE = "pending-prompt.json";

export function pendingPromptPath(home: string): string {
  return path.join(home, FILE);
}

export function writePendingPrompt(home: string, prompt: PendingPrompt): void {
  mkdirSync(home, { recursive: true });
  const file = pendingPromptPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prompt));
  renameSync(tmp, file);
}

export function readPendingPrompt(home: string): PendingPrompt | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingPromptPath(home), "utf8")) as PendingPrompt;
    if (!parsed?.ask || (parsed.ask.kind !== "login" && parsed.ask.kind !== "confirm")) return null;
    if (!parsed.ask.workflowId || !parsed.runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingPrompt(home: string): void {
  rmSync(pendingPromptPath(home), { force: true });
}

/** A deadline of null waits without expiring. Zero is not a deadline either. */
export function promptDue(prompt: PendingPrompt, now: number): boolean {
  const deadline = prompt.ask.deadline;
  return typeof deadline === "number" && deadline > 0 && now >= deadline;
}

export interface PromptRunStore {
  readRun(id: string): StoredRun;
  saveRun(run: StoredRun): void;
}

export function markPromptTimedOut(store: PromptRunStore, prompt: PendingPrompt, now: number): StoredRun {
  let existing: StoredRun | undefined;
  try { existing = store.readRun(prompt.runId); } catch { existing = undefined; }
  const steps = Array.isArray(existing?.steps) ? [...existing.steps] as { id?: string; status?: string; label?: string; reason?: string; phase?: string }[] : [];
  const failed = { id: prompt.ask.stepId, status: "failed", label: prompt.ask.label, reason: TIMED_OUT, phase: "expect" };
  const idx = steps.findIndex((step) => step.id === prompt.ask.stepId);
  if (idx >= 0) steps[idx] = { ...steps[idx], ...failed };
  else steps.push(failed);
  const run: StoredRun = {
    id: prompt.runId,
    workflowId: prompt.ask.workflowId,
    status: TIMED_OUT_STATUS,
    at: now,
    heals: existing?.heals ?? [],
    steps,
    decisions: existing?.decisions,
    inputs: existing?.inputs,
    failure: {
      stepId: prompt.ask.stepId,
      index: Math.max(0, prompt.ask.stepIndex - 1),
      intent: prompt.ask.label,
      reason: TIMED_OUT,
      phase: "expect",
    },
  };
  store.saveRun(run);
  return run;
}
