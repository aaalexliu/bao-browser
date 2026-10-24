// Guide Me replays a workflow as guidance. It highlights the next target and
// advances when the person does that step. It never clicks, types, or presses keys.

import { lookup } from "./identity";
import type { Driver, GuideAct, LiveTree } from "./replay";
import { holdsExpect } from "./replay";
import { subst, type Identity, type ReplayArgs, type WorkflowStep, type WorkflowV2 } from "./schema";

export interface GuideStepResult {
  id: string;
  status: "passed" | "skipped" | "timeout";
}

export interface GuideResult {
  runId: string;
  status: "passed" | "stopped" | "timeout";
  /** Automated click, fill, key, upload, drop, digits, and check calls. Stays 0. */
  actions: number;
  steps: GuideStepResult[];
}

export interface GuideProgress {
  index: number;
  total: number;
  stepId: string;
  intent: string;
  status: "highlight" | "passed" | "stopped" | "timeout";
  actions: number;
}

export interface GuideOptions {
  runId?: string;
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  onProgress?: (progress: GuideProgress) => void;
}

export async function guideMe(
  workflow: WorkflowV2,
  args: ReplayArgs,
  driver: Driver,
  opts: GuideOptions = {},
): Promise<GuideResult> {
  const steps: GuideStepResult[] = [];
  const total = workflow.steps.length;
  const pollMs = opts.pollMs ?? 40;
  const timeoutMs = opts.timeoutMs ?? 20000;
  let guard: { present: string; open: boolean } | undefined;
  const report = (index: number, step: WorkflowStep, status: GuideProgress["status"]) => {
    opts.onProgress?.({
      index,
      total,
      stepId: step.id,
      intent: step.intent || step.label,
      status,
      actions: actionCount(driver),
    });
  };
  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index]!;
    if (driver.shouldStop?.()) {
      report(index, step, "stopped");
      return { runId: opts.runId || "guide", status: "stopped", actions: actionCount(driver), steps };
    }
    const present = step.when?.present?.trim();
    if (present) {
      if (!guard || guard.present !== present) {
        guard = { present, open: pageShows(await driver.tree(), present) };
      }
      if (!guard.open) {
        steps.push({ id: step.id, status: "skipped" });
        continue;
      }
    } else {
      guard = undefined;
      if (step.when?.input && String(args[step.when.input] ?? "") !== (step.when.value ?? "")) {
        steps.push({ id: step.id, status: "skipped" });
        continue;
      }
    }
    if (step.action === "note") {
      steps.push({ id: step.id, status: "passed" });
      continue;
    }
    const since = Date.now();
    report(index, step, "highlight");
    const node = await highlight(step, driver);
    const outcome = step.action === "verify"
      ? await waitForCheck(step, args, driver, timeoutMs, pollMs)
      : await waitForPerson(step, args, driver, node, timeoutMs, pollMs, since);
    if (outcome === "stopped") {
      report(index, step, "stopped");
      return { runId: opts.runId || "guide", status: "stopped", actions: actionCount(driver), steps };
    }
    if (outcome === "timeout") {
      steps.push({ id: step.id, status: "timeout" });
      report(index, step, "timeout");
      return { runId: opts.runId || "guide", status: "timeout", actions: actionCount(driver), steps };
    }
    steps.push({ id: step.id, status: "passed" });
  }
  const last = workflow.steps[workflow.steps.length - 1];
  if (last) report(Math.max(0, total - 1), last, "passed");
  return { runId: opts.runId || "guide", status: "passed", actions: actionCount(driver), steps };
}

function actionCount(driver: Driver): number {
  const fn = (driver as { actions?: unknown }).actions;
  if (typeof fn !== "function") return 0;
  return (fn as (this: Driver) => number).call(driver);
}

async function highlight(step: WorkflowStep, driver: Driver): Promise<Identity | undefined> {
  const draw = driver.highlightTarget ?? driver.outline;
  if (!step.identity || !draw) return undefined;
  const tree = await driver.tree();
  const hit = lookup(step.identity, tree.nodes);
  if (!hit.ok || hit.index == null) return undefined;
  const node = tree.nodes[hit.index];
  if (!node) return undefined;
  await draw.call(driver, node);
  return node;
}

async function waitForCheck(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  timeoutMs: number,
  pollMs: number,
): Promise<"done" | "stopped" | "timeout"> {
  const expect = step.expect;
  if (!expect) return "done";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (driver.shouldStop?.()) return "stopped";
    if (holdsExpect(expect, await driver.tree(), args)) return "done";
    await sleep(pollMs);
  }
  return "timeout";
}

async function waitForPerson(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  node: Identity | undefined,
  timeoutMs: number,
  pollMs: number,
  since: number,
): Promise<"done" | "stopped" | "timeout"> {
  const before = await fieldValue(driver, step, node);
  const deadline = since + timeoutMs;
  while (Date.now() < deadline) {
    if (driver.shouldStop?.()) return "stopped";
    const act = await driver.performed?.();
    if (act && act.ts + 50 >= since && actMatches(step, act, args)) return "done";
    if (step.action === "type") {
      const now = await fieldValue(driver, step, node);
      if (valueDone(step, args, before, now)) return "done";
    }
    await sleep(pollMs);
  }
  return "timeout";
}

function actMatches(step: WorkflowStep, act: GuideAct, args: ReplayArgs): boolean {
  if (!sameTarget(step.identity, act)) return false;
  if (step.action === "type") return act.op === "type" && typeDone(step, act, args);
  if (step.action === "key") return act.op === "key" && (!step.key || act.key === step.key);
  if (step.action === "check") return act.op === "click" || act.op === "check";
  return act.op === "click";
}

function typeDone(step: WorkflowStep, act: GuideAct, args: ReplayArgs): boolean {
  if (step.sensitive || act.secret || step.identity?.role === "password") return true;
  const want = expectedValue(step, args);
  const got = act.value || "";
  if (!want) return got.length > 0;
  return got === want;
}

function valueDone(step: WorkflowStep, args: ReplayArgs, before: string, now: string): boolean {
  if (!now || now === before) return false;
  if (step.sensitive || step.identity?.role === "password") return true;
  const want = expectedValue(step, args);
  if (!want) return true;
  return now === want;
}

function expectedValue(step: WorkflowStep, args: ReplayArgs): string {
  if (step.input) {
    const arg = args[step.input];
    if (typeof arg === "string" || typeof arg === "number") return String(arg);
  }
  return subst(step.value || "", args);
}

async function fieldValue(driver: Driver, step: WorkflowStep, node: Identity | undefined): Promise<string> {
  if (step.action !== "type") return "";
  const tree = await driver.tree();
  const hit = node ? tree.values.find((item) => item.identity === node) : undefined;
  if (hit) return hit.value;
  const found = tree.values.find((item) => sameTarget(step.identity, {
    id: item.identity.id,
    testId: item.identity.testId,
    name: item.identity.nameAttr,
  }));
  return found?.value || "";
}

function sameTarget(identity: Identity | undefined, act: { id?: string; testId?: string; name?: string }): boolean {
  if (!identity) return false;
  if (identity.id && act.id && identity.id === act.id) return true;
  if (identity.testId && act.testId && identity.testId === act.testId) return true;
  if (identity.nameAttr && act.name && identity.nameAttr === act.name) return true;
  if (identity.name && act.name && identity.name === act.name) return true;
  return false;
}

function pageShows(tree: LiveTree, present: string): boolean {
  if (tree.texts.some((text) => text.includes(present))) return true;
  return tree.nodes.some((node) => [node.text, node.name, node.label].some((bit) => bit?.includes(present)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
