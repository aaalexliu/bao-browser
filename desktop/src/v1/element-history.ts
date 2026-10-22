// Locator versions for one step. A heal, a revert, and a rollback append a row.
// Nothing rewrites an older row.

import type { Identity, StepLocator, WorkflowStep } from "./schema";

export type VersionSource = "recorded" | "heal" | "revert" | "rollback";

export interface ElementVersion {
  id: string;
  at: number;
  source: VersionSource;
  runId?: string;
  /** 100 is a unique visible hit. */
  score?: number;
  changed: string[];
  identity?: Identity;
  locators?: StepLocator[];
}

const ATTRS = ["role", "name", "text", "testId", "id", "label", "cssPath", "xpath"] as const;

export function recordedVersion(step: Pick<WorkflowStep, "identity" | "locators">, at: number, runId?: string): ElementVersion {
  return {
    id: `recorded-${at}`,
    at,
    source: "recorded",
    runId,
    score: 100,
    changed: [],
    identity: copyIdentity(step.identity),
    locators: copyLocators(step.locators),
  };
}

export function versionsFor(step: Pick<WorkflowStep, "history" | "identity" | "locators">, at = 0): ElementVersion[] {
  if (step.history && step.history.length > 0) return step.history;
  return [recordedVersion(step, at)];
}

export function changedAttrs(
  before: Pick<WorkflowStep, "identity" | "locators">,
  after: Pick<WorkflowStep, "identity" | "locators">,
): string[] {
  const changed: string[] = [];
  for (const attr of ATTRS) {
    if ((before.identity?.[attr] || "") !== (after.identity?.[attr] || "")) changed.push(attr);
  }
  if (locatorKey(before.locators) !== locatorKey(after.locators)) changed.push("locators");
  return changed;
}

/** Append a heal row. The recorded row is created once, from the step before the patch. */
export function withHealVersion(
  before: WorkflowStep,
  after: WorkflowStep,
  meta: { at: number; recordedAt: number; runId?: string; score?: number },
): WorkflowStep {
  const history = before.history && before.history.length > 0
    ? [...before.history]
    : [recordedVersion(before, meta.recordedAt)];
  const version: ElementVersion = {
    id: `heal-${meta.at}-${history.length}`,
    at: meta.at,
    source: "heal",
    runId: meta.runId,
    score: meta.score ?? 100,
    changed: changedAttrs(before, after),
    identity: copyIdentity(after.identity),
    locators: copyLocators(after.locators),
  };
  return { ...after, history: [...history, version] };
}

/** Append a revert row. Older rows stay as they were. */
export function withRevertVersion(
  current: WorkflowStep,
  before: WorkflowStep,
  meta: { at: number; recordedAt: number; runId?: string },
): WorkflowStep {
  const history = current.history && current.history.length > 0
    ? [...current.history]
    : [recordedVersion(before, meta.recordedAt)];
  const version: ElementVersion = {
    id: `revert-${meta.at}-${history.length}`,
    at: meta.at,
    source: "revert",
    runId: meta.runId,
    score: history[0]?.score ?? 100,
    changed: changedAttrs(current, before),
    identity: copyIdentity(before.identity),
    locators: copyLocators(before.locators),
  };
  return { ...before, history: [...history, version] };
}

/**
 * Copy one older version onto the step and append that copy.
 * The chosen row is not edited.
 */
export function rollbackTo(
  step: WorkflowStep,
  versionId: string,
  meta: { at: number; recordedAt: number; runId?: string },
): WorkflowStep {
  const history = step.history && step.history.length > 0
    ? [...step.history]
    : [recordedVersion(step, meta.recordedAt)];
  const picked = history.find((row) => row.id === versionId);
  if (!picked) return step;
  const version: ElementVersion = {
    id: `rollback-${meta.at}-${history.length}`,
    at: meta.at,
    source: "rollback",
    runId: meta.runId,
    score: picked.score,
    changed: changedAttrs(step, picked),
    identity: copyIdentity(picked.identity),
    locators: copyLocators(picked.locators),
  };
  return {
    ...step,
    identity: copyIdentity(picked.identity),
    locators: copyLocators(picked.locators),
    history: [...history, version],
  };
}

function locatorKey(list: StepLocator[] | undefined): string {
  return (list || []).map((locator) => [locator.kind, locator.role, locator.name, locator.value, locator.relation].join(":")).join("|");
}

function copyIdentity(identity: Identity | undefined): Identity | undefined {
  if (!identity) return undefined;
  return { ...identity, path: [...(identity.path || [])] };
}

function copyLocators(list: StepLocator[] | undefined): StepLocator[] | undefined {
  if (!list) return undefined;
  return list.map((locator) => ({ ...locator, anchor: locator.anchor ? { ...locator.anchor } : undefined }));
}
