// Locator versions for one step. A heal, a revert, and a rollback append a row.
// A row stores the changed names and the locator list after the change.

import { stepTarget } from "./schema";
import type { StepLocator, Target, TargetHint, WorkflowStep } from "./schema";

export type VersionSource = "recorded" | "heal" | "revert" | "rollback";

export interface ElementVersion {
  id: string;
  at: number;
  source: VersionSource;
  runId?: string;
  score?: number;
  changed: string[];
  locators: StepLocator[];
  hint?: TargetHint;
}

const HINT_ATTRS = ["label", "nameAttr", "role", "surface"] as const;

export function recordedVersion(step: WorkflowStep, at: number, runId?: string): ElementVersion {
  const target = stepTarget(step);
  return {
    id: `recorded-${at}`,
    at,
    source: "recorded",
    runId,
    score: 100,
    changed: [],
    locators: copyLocators(target?.locators) ?? [],
    hint: copyHint(target?.hint),
  };
}

export function versionsFor(step: WorkflowStep, at = 0): ElementVersion[] {
  const history = stepTarget(step)?.history;
  if (history && history.length > 0) return history;
  return [recordedVersion(step, at)];
}

export function changedAttrs(before: WorkflowStep, after: WorkflowStep): string[] {
  const left = stepTarget(before);
  const right = stepTarget(after);
  const changed: string[] = [];
  for (const attr of HINT_ATTRS) {
    if ((left?.hint?.[attr] || "") !== (right?.hint?.[attr] || "")) changed.push(attr);
  }
  if (testidOf(left?.locators) !== testidOf(right?.locators)) changed.push("testId");
  if (locatorKey(left?.locators) !== locatorKey(right?.locators)) changed.push("locators");
  return changed;
}

function testidOf(list: StepLocator[] | undefined): string {
  const locator = list?.find((item) => item.kind === "testid");
  return locator?.kind === "testid" ? locator.value : "";
}

export function withHealVersion(
  before: WorkflowStep,
  after: WorkflowStep,
  meta: { at: number; recordedAt: number; runId?: string; score?: number },
): WorkflowStep {
  const target = stepTarget(after);
  if (!target) return after;
  const history = stepTarget(before)?.history?.length
    ? [...stepTarget(before)!.history!]
    : [recordedVersion(before, meta.recordedAt)];
  const version: ElementVersion = {
    id: `heal-${meta.at}-${history.length}`,
    at: meta.at,
    source: "heal",
    runId: meta.runId,
    score: meta.score ?? 100,
    changed: changedAttrs(before, after),
    locators: copyLocators(target.locators) ?? [],
    hint: copyHint(target.hint),
  };
  return withTarget(after, { ...target, history: [...history, version] });
}

export function withRevertVersion(
  current: WorkflowStep,
  before: WorkflowStep,
  meta: { at: number; recordedAt: number; runId?: string },
): WorkflowStep {
  const target = stepTarget(before);
  if (!target) return before;
  const history = stepTarget(current)?.history?.length
    ? [...stepTarget(current)!.history!]
    : [recordedVersion(before, meta.recordedAt)];
  const version: ElementVersion = {
    id: `revert-${meta.at}-${history.length}`,
    at: meta.at,
    source: "revert",
    runId: meta.runId,
    score: history[0]?.score ?? 100,
    changed: changedAttrs(current, before),
    locators: copyLocators(target.locators) ?? [],
    hint: copyHint(target.hint),
  };
  return withTarget(before, { ...target, history: [...history, version] });
}

export function rollbackTo(
  step: WorkflowStep,
  versionId: string,
  meta: { at: number; recordedAt: number; runId?: string },
): WorkflowStep {
  const target = stepTarget(step);
  if (!target) return step;
  const history = target.history?.length ? [...target.history] : [recordedVersion(step, meta.recordedAt)];
  const picked = history.find((row) => row.id === versionId);
  if (!picked) return step;
  const version: ElementVersion = {
    id: `rollback-${meta.at}-${history.length}`,
    at: meta.at,
    source: "rollback",
    runId: meta.runId,
    score: picked.score,
    changed: changedAttrs(step, withTarget(step, { ...target, locators: picked.locators, hint: picked.hint })),
    locators: copyLocators(picked.locators) ?? [],
    hint: copyHint(picked.hint),
  };
  return withTarget(step, {
    ...target,
    locators: copyLocators(picked.locators) ?? [],
    hint: copyHint(picked.hint),
    history: [...history, version],
  });
}

function withTarget(step: WorkflowStep, target: Target): WorkflowStep {
  if (!stepTarget(step) && step.action !== "key" && step.action !== "digits" && step.action !== "pickDate") return step;
  if (step.action === "navigate" || step.action === "verify" || step.action === "handoff" || step.action === "extract"
    || step.action === "for_each" || step.action === "note" || step.action === "download" || step.action === "open"
    || step.action === "wait" || step.action === "finish") return step;
  return { ...step, target };
}

function locatorKey(list: StepLocator[] | undefined): string {
  return (list || []).map((locator) => [locator.kind, locator.kind === "role" ? locator.role : "", locator.kind === "role" ? locator.name : "", locator.kind === "anchor" ? locator.relation : "", "value" in locator ? locator.value : ""].join(":")).join("|");
}

function copyHint(hint: TargetHint | undefined): TargetHint | undefined {
  if (!hint) return undefined;
  return { ...hint, path: hint.path ? hint.path.map((seg) => ({ ...seg })) : undefined };
}

function copyLocators(list: StepLocator[] | undefined): StepLocator[] | undefined {
  if (!list) return undefined;
  return list.map((locator) => locator.kind === "anchor"
    ? { ...locator, anchor: { ...locator.anchor } }
    : { ...locator });
}
