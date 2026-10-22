// Deterministic replay. Lookup uses the identity scorer. A miss stops the run
// unless a heal provider is available. Auto applies the patch without waiting.
// Approve returns a pause. The saved workflow is not edited here.
// A login redirect is phase `auth` and is not sent to a model.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyAllowed, type ApplyGate, type RunTrailEvent } from "./apply-guard";
import { authPreconditionMiss, pathMatches, secretArg, textArg } from "./auth";
import { lookup } from "./identity";
import { actWaitMs, confirmButton, makeAsk, type HumanAsk } from "./human-ask";
import { identityView } from "./run-trace";
import {
  applyPatch,
  maskSnapshot,
  stepPolicy,
  maskText,
  type FailureSnapshot,
  type HealProposal,
  type HealProvider,
  type HealRecord,
  type HealSettings,
  type ReplayPhase,
  type StepFailure,
} from "./heal";
import { isCollapsedBox, matchLocator } from "./locators";
import { classifyFailure } from "./triage";
import { ReceiptLog, readThrowaway, type Receipt } from "./receipt";
import { collapsedTarget, discoverReveal, labelCandidate, overlayClose, recordedReveal, anchorCandidate, type RepairLog } from "./repair";
import {
  subst,
  type FileArg,
  type Identity,
  type ReadBack,
  type ReplayArgs,
  type StepCheck,
  type StepLocator,
  type WorkflowStep,
  type WorkflowV2,
} from "./schema";
import { shotFile } from "./shots";
import { postKey, targetKey, timingBucket, type TrajectoryStep } from "./trajectory";

export interface LocatorHit {
  stepId: string;
  kind: string;
  detail: string;
}

export type LocatorMode = "all" | "primary";

export interface LiveTree {
  nodes: Identity[];
  url?: string;
  texts: string[];
  values: { identity: Identity; value: string }[];
  boxes?: { x: number; y: number; w: number; h: number }[];
  /** Parallel to nodes. True when the page marked the node hidden. */
  hidden?: boolean[];
  flags?: { checked?: boolean; enabled?: boolean }[];
}

export interface HealNotice {
  title: string;
  body: string;
  workflowId: string;
  runId: string;
  stepId: string;
}

export interface Driver {
  tree(): Promise<LiveTree>;
  snapshot(): Promise<FailureSnapshot>;
  click(node: Identity): Promise<void>;
  fill(node: Identity, text: string, secret: boolean): Promise<void>;
  key(key: string): Promise<void>;
  upload(node: Identity, files: FileArg[]): Promise<void>;
  drop(node: Identity, files: FileArg[]): Promise<void>;
  digits(app: string | undefined, role: string, text: string): Promise<void>;
  check(node: Identity, checked: boolean): Promise<void>;
  notify(notice: HealNotice): Promise<void>;
  sleep?(ms: number): Promise<void>;
  waitIdle?(timeoutMs: number): Promise<void>;
  /** Shown in the Bao window. Replay does not click Apply. */
  showConfirm?(label: string): void | Promise<void>;
  clearConfirm?(): void | Promise<void>;
  showLoginWait?(label: string): void | Promise<void>;
  clearLoginWait?(): void | Promise<void>;
  /** The product window's act bar. Replay still does not press the site button. */
  showAsk?(ask: HumanAsk): void | Promise<void>;
  shouldStop?(): boolean;
  loginContinued?(): boolean;
  /** Page PNG of the target, when the driver can see it. Unit-test drivers omit this. */
  shot?(target?: ShotTarget): Promise<Buffer | undefined>;
  /** Tags console and network lines with the step that is running. */
  markStep?(id: string): void;
  /** DOM and accessibility tree at the end of the step. Browser drivers only. */
  captureStep?(): Promise<{ dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string }>;
  trace?(): {
    console: { stepId?: string; type?: string; text: string; ts?: number }[];
    network: { stepId?: string; method?: string; url: string; status?: number; ts?: number }[];
  };
}

export interface ShotTarget {
  identity?: Identity;
  action?: string;
  label?: string;
  text?: string;
}

export interface RunResult {
  runId: string;
  status: "passed" | "failed" | "paused";
  steps: {
    id: string;
    status: "passed" | "failed" | "paused" | "pending";
    reason?: string;
    phase?: ReplayPhase;
    startedAt?: number;
    endedAt?: number;
    beforeShot?: string;
    afterShot?: string;
    triage?: string;
    snapshot?: { dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string };
  }[];
  console?: { stepId?: string; type?: string; text: string; ts?: number }[];
  network?: { stepId?: string; method?: string; url: string; status?: number; ts?: number }[];
  failure?: StepFailure;
  heals: HealRecord[];
  repairs: RepairLog[];
  locatorHits: LocatorHit[];
  receipts: Receipt[];
  trajectory: TrajectoryStep[];
  trail: RunTrailEvent[];
  /** Set when a login redirect was seen. Recovered means replay continued without a model. */
  precondition?: { phase: "auth"; reason: string; recovered: boolean; stepId: string };
  proposal?: HealProposal;
  pausedStepId?: string;
  /** Heal proposals that named a model. Zero is a run that did not call one. */
  modelCalls: number;
}

export interface ReplayOptions {
  runId?: string;
  now?: () => number;
  secrets?: string[];
  settings?: HealSettings;
  heal?: HealProvider;
  /** `all` tries every stored locator. `primary` tries the first one. Absent uses `all` when the step has locators. */
  locators?: LocatorMode;
  /** Append-only receipt file. Absent keeps the receipts on the run only. */
  receipts?: ReceiptLog;
  nowMs?: () => number;
  /** Directory for per-step PNGs. Absent skips capture. */
  shotDir?: string;
  /** Auto-heal stays off after too many recent failures. */
  circuitOpen?: boolean;
}

let seq = 0;

export async function replay(
  workflow: WorkflowV2,
  args: ReplayArgs,
  driver: Driver,
  opts: ReplayOptions = {},
): Promise<RunResult> {
  const runId = opts.runId || `run-${++seq}-${Date.now().toString(36)}`;
  const now = opts.now ?? (() => 0);
  const settings = opts.settings ?? {};
  const heal = opts.heal;
  const secrets = opts.secrets ?? secretValues(workflow, args);
  const steps: RunResult["steps"] = workflow.steps.map((step) => ({ id: step.id, status: "pending" }));
  const heals: HealRecord[] = [];
  const repairs: RepairLog[] = [];
  const locatorHits: LocatorHit[] = [];
  const locatorMode = opts.locators ?? "all";
  const receiptLog = opts.receipts ?? new ReceiptLog();
  const trajectory: TrajectoryStep[] = [];
  const trail: RunTrailEvent[] = [];
  const gate: ApplyGate = { workflow, trail, actTimeoutMs: settings.actTimeoutMs };
  const clock = opts.nowMs ?? (() => Date.now());
  let precondition: RunResult["precondition"];

  const finish = (partial: Omit<RunResult, "trail" | "precondition" | "receipts" | "repairs" | "locatorHits" | "heals" | "trajectory" | "modelCalls"> & Partial<RunResult>): RunResult => {
    const trace = driver.trace?.();
    return {
      heals,
      repairs,
      locatorHits,
      receipts: receiptLog.entries,
      trajectory,
      trail,
      precondition,
      console: trace?.console || [],
      network: trace?.network || [],
      ...partial,
      modelCalls: heals.filter((item) => item.model).length,
    };
  };

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    const mode = stepPolicy(step, workflow, settings);
    driver.markStep?.(step.id);
    let pictured = step;
    const started = clock();
    const beforeShot = await writeStepShot(driver, opts.shotDir, step, "before");
    const stamp = (patch: RunResult["steps"][number]) => {
      steps[i] = { ...patch, startedAt: started, endedAt: clock(), beforeShot };
    };
    try {
    const extra = i === workflow.steps.length - 1 ? workflow.readBack : undefined;
    if (step.unresolved) {
      const failure = await fail(driver, step, "find", "unresolved step", undefined, secrets);
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, undefined, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    let outcome = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, extra);
    repairs.push(...outcome.repairs);
    if (!outcome.ok && "failure" in outcome && outcome.failure.phase === "auth" && step.action !== "login") {
      const recovered = await recoverAuth(workflow, step, args, driver, secrets, gate);
      if (recovered) {
        noteAuth(trail, step.id, true);
        precondition = { phase: "auth", reason: "redirected to login", recovered: true, stepId: step.id };
        outcome = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, extra);
        repairs.push(...outcome.repairs);
      }
    }
    if (outcome.ok) {
      if (outcome.authRecovered || precondition?.stepId === step.id) {
        noteAuth(trail, step.id, true);
        precondition = { phase: "auth", reason: "redirected to login", recovered: true, stepId: step.id };
        stamp({ id: step.id, status: "passed", phase: "auth", reason: "auth: redirected to login" });
      } else {
        stamp({ id: step.id, status: "passed" });
      }
      noteTrajectory(trajectory, step, outcome.acted, true, clock() - started);
      continue;
    }
    if ("paused" in outcome) {
      stamp({ id: step.id, status: "paused", reason: "confirm" });
      noteTrajectory(trajectory, step, undefined, true, clock() - started);
      return finish({ runId, status: "paused", steps, pausedStepId: step.id });
    }
    const failure = outcome.failure;
    if (failure.phase === "auth") {
      noteAuth(trail, step.id, false);
      precondition = { phase: "auth", reason: failure.reason, recovered: false, stepId: step.id };
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    const triage = classifyFailure(failure);
    const skip = mode === "never"
      ? "never"
      : triage !== "change"
        ? triage
        : mode === "auto" && opts.circuitOpen
          ? "circuit"
          : "";
    if (skip) {
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase, triage: skip });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    if (!heal || !heal.available()) {
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    const proposal = await heal.propose(failure, step);
    const prompt = proposal?.prompt || "";
    const record: HealRecord = {
      id: `heal-${heals.length + 1}`,
      ts: now(),
      workflowId: workflow.id,
      runId,
      mode: mode === "approve" ? "approve" : "auto",
      failedStep: step,
      intent: failure.intent,
      snapshot: maskSnapshot(failure.snapshot, secrets),
      prompt: maskText(prompt, secrets),
      model: proposal?.model
        ? {
          provider: proposal.model.provider,
          name: proposal.model.name,
          version: proposal.model.version || proposal.model.name,
        }
        : undefined,
      rawResponse: proposal ? maskText(proposal.rawResponse, secrets) : undefined,
      proposedPatch: proposal?.patch,
      beforeShot: failure.beforeShot || beforeShot,
      identity: failure.identity,
    };
    if (!proposal) {
      heals.push(record);
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    await driver.notify({
      title: mode === "auto" ? "Bao healed a step" : "Bao needs approval",
      body: `${workflow.name}: ${step.label}`,
      workflowId: workflow.id,
      runId,
      stepId: step.id,
    });
    if (mode === "approve") {
      heals.push(record);
      stamp({ id: step.id, status: "paused", reason: "approve", phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "paused", steps, failure, proposal, pausedStepId: step.id });
    }
    const patched = applyPatch(step, proposal.patch);
    pictured = patched;
    const retried = await runStep(workflow, patched, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, extra);
    repairs.push(...retried.repairs);
    record.executed = { action: patched.action, identity: patched.identity };
    record.postconditionPassed = retried.ok;
    heals.push(record);
    if (!retried.ok && "paused" in retried) {
      stamp({ id: step.id, status: "paused", reason: "confirm" });
      noteTrajectory(trajectory, patched, undefined, true, clock() - started);
      return finish({ runId, status: "paused", steps, pausedStepId: step.id });
    }
    if (!retried.ok) {
      if (retried.failure.phase === "auth") {
        noteAuth(trail, step.id, false);
        precondition = { phase: "auth", reason: retried.failure.reason, recovered: false, stepId: step.id };
      }
      stamp({ id: step.id, status: "failed", reason: phaseReason(retried.failure), phase: retried.failure.phase });
      noteTrajectory(trajectory, patched, retried.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure: retried.failure });
    }
    stamp({ id: step.id, status: "passed" });
    noteTrajectory(trajectory, patched, retried.acted, true, clock() - started);
    } finally {
      const afterShot = await writeStepShot(driver, opts.shotDir, pictured, "after");
      const snapshot = driver.captureStep ? await driver.captureStep().catch(() => undefined) : undefined;
      if (steps[i]) steps[i] = { ...steps[i], beforeShot, afterShot, ...(snapshot ? { snapshot } : {}) };
    }
  }
  return finish({ runId, status: "passed", steps });
}

type StepOutcome =
  | { ok: true; repairs: RepairLog[]; acted?: Identity; authRecovered?: boolean }
  | { ok: false; failure: StepFailure; repairs: RepairLog[]; acted?: Identity }
  | { ok: false; paused: "confirm"; repairs: RepairLog[] };

async function runStep(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  locatorHits: LocatorHit[],
  locatorMode: LocatorMode,
  receiptLog: ReceiptLog,
  runId: string,
  gate: ApplyGate,
  extra?: ReadBack,
): Promise<StepOutcome> {
  const repairs: RepairLog[] = [];
  if (step.waitFor) {
    const ready = await holdCheck(step.waitFor, args, driver, true);
    if (!ready) {
      return { ok: false, repairs, failure: await fail(driver, step, "wait_for", checkReason(step.waitFor), undefined, secrets) };
    }
  }
  const outcome = await runStepAction(step, args, driver, secrets, repairs, locatorHits, locatorMode, gate);
  if (!outcome.ok) return outcome;
  if (step.gone) {
    const left = await holdCheck(step.gone, args, driver, false);
    if (!left) {
      return {
        ok: false,
        repairs: outcome.repairs,
        acted: outcome.acted,
        failure: await fail(driver, step, "expect", `gone: ${step.gone.match || step.gone.kind}`, undefined, secrets),
      };
    }
  }
  for (const read of [step.readBack, extra]) {
    if (!read) continue;
    const failure = await takeReadBack(workflow, step, read, args, driver, secrets, receiptLog, runId);
    if (failure) return { ok: false, repairs: outcome.repairs, acted: outcome.acted, failure };
  }
  return outcome;
}

async function runStepAction(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  repairs: RepairLog[],
  locatorHits: LocatorHit[],
  locatorMode: LocatorMode,
  gate: ApplyGate,
): Promise<StepOutcome> {
  if (step.action === "login") return runLogin(gate.workflow, step, args, driver, secrets, gate);
  const seen = await driver.tree();
  const miss = authPreconditionMiss(gate.workflow.precondition, seen.url);
  if (miss) return { ok: false, repairs, failure: await fail(driver, step, "auth", miss, undefined, secrets) };
  if (step.action === "confirm") return runConfirm(step, args, driver, secrets, gate);
  if (step.action === "verify") {
    const held = await readExpect(step, args, driver, repairs, gate);
    if (!held) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    return { ok: true, repairs };
  }
  if (step.action === "key" && !step.identity) {
    try {
      await driver.key(step.key || "Enter");
    } catch (err) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    if (!await readExpect(step, args, driver, repairs, gate)) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs };
  }
  if (step.action === "digits") {
    const text = String(args[step.input || ""] ?? subst(step.value || "", args));
    try {
      await driver.digits(step.identity?.app, step.identity?.role || "button", text);
    } catch (err) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    if (!await readExpect(step, args, driver, repairs, gate)) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs, acted: step.identity };
  }
  const found = await findTarget(step, args, driver, repairs, locatorHits, locatorMode, gate);
  if (!found.hit.ok || found.hit.index == null) {
    const failure = await fail(driver, step, "find", found.hit.reason || "lookup miss", found.hit.brokenAttr, secrets);
    if (step.identity) failure.identity = identityView(step.identity, found.nodes, found.hit);
    return { ok: false, repairs, failure };
  }
  const node = found.nodes[found.hit.index];
  if (!node) {
    return { ok: false, repairs, failure: await fail(driver, step, "find", "lookup miss", found.hit.brokenAttr, secrets) };
  }
  try {
    await act(step, node, args, driver, gate);
  } catch (err) {
    const reason = maskText(err instanceof Error ? err.message : String(err), secrets);
    return { ok: false, repairs, acted: node, failure: await fail(driver, step, "action", reason, found.hit.brokenAttr, secrets) };
  }
  if (!await readExpect(step, args, driver, repairs, gate)) {
    return { ok: false, repairs, acted: node, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
  }
  return { ok: true, repairs, acted: node };
}

async function findTarget(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  repairs: RepairLog[],
  locatorHits: LocatorHit[],
  locatorMode: LocatorMode,
  gate: ApplyGate,
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup> }> {
  let tree = await driver.tree();
  const close = overlayClose(tree.nodes);
  if (close && await guardedClick(driver, gate, step.id, close)) {
    repairs.push({ stepId: step.id, repair: "overlay", detail: close.text || close.name || "overlay" });
    tree = await driver.tree();
  }
  let located = locate(step, tree, args, locatorMode);
  if (shouldReveal(step, tree, located, locatorMode)) {
    const opened = await openReveal(step, tree, driver, repairs, locatorMode, gate);
    if (opened) {
      tree = await driver.tree();
      // The opened field is not the collapsed node. Its role can change
      // (input to combobox), so try every stored locator, not only the first.
      located = locate(step, tree, args, "all");
    }
  }
  if (located.hit.ok && located.hit.index != null && !isCollapsedBox(located.hit.index, tree.boxes, tree.hidden)) {
    if (located.via) locatorHits.push(located.via);
    return located;
  }
  const labeled = labelCandidate(step, tree.nodes, tree.boxes);
  if (labeled) {
    repairs.push({ stepId: step.id, repair: "label", detail: labeled.detail });
    return { nodes: tree.nodes, hit: { ok: true, index: labeled.index, score: 0, margin: 0, ranked: [] } };
  }
  const anchored = anchorCandidate(step, tree.nodes, tree.boxes);
  if (anchored) {
    repairs.push({ stepId: step.id, repair: "anchor", detail: anchored.detail });
    return { nodes: tree.nodes, hit: { ok: true, index: anchored.index, score: 0, margin: 0, ranked: [] } };
  }
  if (driver.waitIdle) await driver.waitIdle(Math.min(step.timeoutMs || 1000, 2000));
  const waited = await poll(step, args, driver, locatorMode);
  if (waited.hit.ok && waited.hit.index != null && !isCollapsedBox(waited.hit.index, waited.boxes, waited.hidden)) {
    repairs.push({ stepId: step.id, repair: "wait", detail: `waited for ${step.timeoutMs}ms` });
    if (waited.via) locatorHits.push(waited.via);
    return waited;
  }
  if (waited.hit.ok) {
    return { nodes: waited.nodes, hit: { ok: false, reason: "below-threshold", brokenAttr: "box", ranked: [] } };
  }
  return waited;
}

function shouldReveal(
  step: WorkflowStep,
  tree: LiveTree,
  located: { hit: { ok?: boolean; index?: number } },
  locatorMode: LocatorMode,
): boolean {
  if (located.hit.ok && located.hit.index != null) {
    return isCollapsedBox(located.hit.index, tree.boxes, tree.hidden);
  }
  return !!collapsedTarget(step, tree.nodes, tree.boxes, tree.hidden, locatorList(step, locatorMode));
}

/** Click a recorded or discoverable toggle, once, when the target box cannot be used. */
async function openReveal(
  step: WorkflowStep,
  tree: LiveTree,
  driver: Driver,
  repairs: RepairLog[],
  locatorMode: LocatorMode,
  gate: ApplyGate,
): Promise<boolean> {
  const collapsed = collapsedTarget(step, tree.nodes, tree.boxes, tree.hidden, locatorList(step, locatorMode));
  const recorded = recordedReveal(step, tree.nodes, tree.boxes, tree.hidden);
  const discovered = !recorded && collapsed
    ? discoverReveal(tree.nodes, tree.boxes, collapsed.index, tree.hidden)
    : undefined;
  const pick = recorded
    ? { index: recorded.index, detail: recorded.detail }
    : discovered
      ? { index: discovered.index, detail: `discovered ${discovered.detail}` }
      : undefined;
  if (!pick) return false;
  const node = tree.nodes[pick.index];
  if (!node) return false;
  if (!await guardedClick(driver, gate, step.id, node)) return false;
  // The opened field replaces the collapsed one. Wait until that swap settles
  // before the next dump, or the handle is on a node fill cannot use.
  await (driver.sleep ? driver.sleep(300) : sleep(300));
  repairs.push({ stepId: step.id, repair: "reveal", detail: pick.detail });
  return true;
}

async function readExpect(step: WorkflowStep, args: ReplayArgs, driver: Driver, repairs: RepairLog[], gate: ApplyGate): Promise<boolean> {
  if (!step.expect && !step.postcondition) return true;
  if (await expectationsHold(step, await driver.tree(), args)) return true;
  const timeout = step.expect?.timeoutMs || step.postcondition?.timeoutMs || 0;
  const start = Date.now();
  if (driver.waitIdle) await driver.waitIdle(Math.min(timeout || step.timeoutMs || 1000, 2000));
  while (Date.now() - start < timeout) {
    await (driver.sleep ? driver.sleep(100) : sleep(100));
    if (await expectationsHold(step, await driver.tree(), args)) {
      repairs.push({ stepId: step.id, repair: "wait", detail: "expect became true" });
      return true;
    }
  }
  if (timeout === 0 && await expectationsHold(step, await driver.tree(), args)) return true;
  const tree = await driver.tree();
  const close = overlayClose(tree.nodes);
  if (close && await guardedClick(driver, gate, step.id, close)) {
    repairs.push({ stepId: step.id, repair: "overlay", detail: close.text || close.name || "overlay" });
    if (await expectationsHold(step, await driver.tree(), args)) return true;
  }
  return false;
}

async function expectationsHold(step: WorkflowStep, tree: LiveTree, args: ReplayArgs): Promise<boolean> {
  if (step.expect && !holdsExpect(step.expect, tree, args)) return false;
  if (step.postcondition && !holds(step.postcondition, tree, args)) return false;
  return true;
}

async function runConfirm(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  gate: ApplyGate,
): Promise<StepOutcome> {
  const workflow = gate.workflow;
  await driver.showAsk?.(makeAsk({
    kind: "confirm",
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepId: step.id,
    stepIndex: step.index + 1,
    stepCount: workflow.steps.length,
    label: step.label,
    button: confirmButton(step),
    timeoutMs: actWaitMs(step.timeoutMs, gate.actTimeoutMs),
  }));
  await driver.showConfirm?.(step.label);
  if (!step.postcondition) {
    return { ok: false, paused: "confirm", repairs: [] };
  }
  try {
    const timeout = actWaitMs(step.timeoutMs, gate.actTimeoutMs);
    const start = Date.now();
    let seen = await driver.tree();
    while (!holds(step.postcondition, seen, args) && Date.now() - start < timeout) {
      if (driver.shouldStop?.()) {
        return { ok: false, repairs: [], failure: await fail(driver, step, "expect", "cancelled", undefined, secrets) };
      }
      await (driver.sleep ? driver.sleep(200) : sleep(200));
      seen = await driver.tree();
    }
    if (!holds(step.postcondition, seen, args)) {
      const reason = driver.shouldStop?.() ? "cancelled" : "nothing applied";
      return { ok: false, repairs: [], failure: await fail(driver, step, "expect", reason, undefined, secrets) };
    }
    gate.trail.push({ kind: "human-confirm", stepId: step.id });
    return { ok: true, repairs: [] };
  } finally {
    await driver.clearConfirm?.();
  }
}

async function runLogin(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  gate: ApplyGate,
): Promise<StepOutcome> {
  const seen = await driver.tree();
  const miss = authPreconditionMiss(workflow.precondition, seen.url);
  if (loginSatisfied(workflow, step, seen, args) && !miss) return { ok: true, repairs: [] };
  const filled = await settleLogin(workflow, step, args, driver, gate, !secretArg(workflow, args, step.input));
  const startedLoggedOut = !!miss || (workflow.precondition?.phase === "auth" && !loginSatisfied(workflow, step, seen, args));
  if (filled) return { ok: true, repairs: [], authRecovered: startedLoggedOut };
  const phase = workflow.precondition?.phase === "auth" || miss ? "auth" : "expect";
  const reason = phase === "auth" ? (miss || "redirected to login") : "waiting for you to log in";
  return { ok: false, repairs: [], failure: await fail(driver, step, phase, reason, undefined, secrets) };
}

function loginSatisfied(workflow: WorkflowV2, step: WorkflowStep, tree: LiveTree, args: ReplayArgs): boolean {
  if (workflow.precondition?.phase === "auth") return pathMatches(tree.url, workflow.precondition.match);
  if (!step.postcondition) return false;
  return holds(step.postcondition, tree, args);
}

/** Fill a supplied secret, or wait while the person signs in. Returns when the page is past login. */
async function settleLogin(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  gate: ApplyGate,
  human: boolean,
): Promise<boolean> {
  const password = secretArg(workflow, args, step.input);
  if (!human && password) {
    try {
      await fillSecretLogin(workflow, args, driver, gate, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "login failed";
      if (message === "could not fill the secret field" || message === "password field missing") return false;
      return false;
    }
  } else {
    await driver.showAsk?.(makeAsk({
      kind: "login",
      workflowId: workflow.id,
      workflowName: workflow.name,
      stepId: step.id,
      stepIndex: step.index + 1,
      stepCount: workflow.steps.length,
      label: step.label,
      timeoutMs: actWaitMs(step.timeoutMs, gate.actTimeoutMs),
    }));
    await driver.showLoginWait?.(step.label || "Sign in on the site window");
  }
  try {
    return await waitForLogin(workflow, step, args, driver, gate);
  } finally {
    await driver.clearLoginWait?.();
  }
}

async function recoverAuth(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  _secrets: string[],
  gate: ApplyGate,
): Promise<boolean> {
  const human = !secretArg(workflow, args, step.input);
  return settleLogin(workflow, step, args, driver, gate, human);
}

async function waitForLogin(workflow: WorkflowV2, step: WorkflowStep, args: ReplayArgs, driver: Driver, gate: ApplyGate): Promise<boolean> {
  const timeout = actWaitMs(step.timeoutMs, gate.actTimeoutMs);
  const start = Date.now();
  let seen = await driver.tree();
  if (driver.loginContinued?.()) return true;
  if (loginSatisfied(workflow, step, seen, args)) return true;
  while (Date.now() - start < timeout) {
    if (driver.loginContinued?.()) return true;
    if (driver.shouldStop?.()) return false;
    await (driver.sleep ? driver.sleep(100) : sleep(100));
    seen = await driver.tree();
    if (loginSatisfied(workflow, step, seen, args)) return true;
  }
  seen = await driver.tree();
  return loginSatisfied(workflow, step, seen, args);
}

async function fillSecretLogin(
  workflow: WorkflowV2,
  args: ReplayArgs,
  driver: Driver,
  gate: ApplyGate,
  password: string,
): Promise<void> {
  const username = textArg(args, "username") || workflow.inputs.find((input) => input.name === "username")?.default || "";
  let tree = await driver.tree();
  const user = tree.nodes.find((node) => node.id === "username" || node.nameAttr === "username");
  if (user && username) await driver.fill(user, username, false);
  const cont = tree.nodes.find((node) => node.id === "continue" || node.testId === "login-continue");
  if (cont) await guardedClick(driver, gate, "login", cont);
  tree = await driver.tree();
  const pass = tree.nodes.find((node) => node.id === "password" || node.nameAttr === "password" || node.role === "password");
  if (!pass) throw new Error("password field missing");
  await driver.fill(pass, password, true);
  const shot = process.env.BAO_SECRET_SHOT;
  if (shot) {
    mkdirSync(path.dirname(shot), { recursive: true });
    const snap = await driver.snapshot();
    if (snap.screenshot) writeFileSync(shot, Buffer.from(snap.screenshot, "base64"));
  }
  const hold = Number(process.env.BAO_DEMO_HOLD_MS || 0);
  if (hold > 0) await (driver.sleep ? driver.sleep(hold) : sleep(hold));
  tree = await driver.tree();
  const sign = tree.nodes.find((node) => node.id === "signin" || node.testId === "login-submit");
  if (sign) await guardedClick(driver, gate, "login", sign);
  await (driver.sleep ? driver.sleep(50) : sleep(50));
  tree = await driver.tree();
  const code = tree.nodes.find((node) => node.id === "code" || node.testId === "verify-code");
  const verifyCode = textArg(args, "code");
  if (code && verifyCode) {
    await driver.fill(code, verifyCode, false);
    const button = tree.nodes.find((node) => node.id === "verify" || node.testId === "verify-submit");
    if (button) await guardedClick(driver, gate, "login", button);
  }
}

async function guardedClick(driver: Driver, gate: ApplyGate, stepId: string, node: Identity): Promise<boolean> {
  if (!applyAllowed(gate.workflow, gate.trail, node)) return false;
  await driver.click(node);
  gate.trail.push({
    kind: "click",
    stepId,
    target: node.testId || node.id || node.text || node.name || node.role,
  });
  return true;
}

async function poll(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  locatorMode: LocatorMode,
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup>; via?: LocatorHit; boxes?: LiveTree["boxes"]; hidden?: boolean[] }> {
  const timeout = step.timeoutMs ?? 0;
  const start = Date.now();
  let tree = await driver.tree();
  let located = locate(step, tree, args, locatorMode);
  while (!located.hit.ok && Date.now() - start < timeout) {
    await (driver.sleep ? driver.sleep(50) : sleep(50));
    tree = await driver.tree();
    located = locate(step, tree, args, locatorMode);
  }
  return { ...located, boxes: tree.boxes, hidden: tree.hidden };
}

function locate(
  step: WorkflowStep,
  tree: LiveTree,
  args: ReplayArgs,
  locatorMode: LocatorMode,
): { nodes: Identity[]; hit: ReturnType<typeof lookup>; via?: LocatorHit } {
  let nodes = tree.nodes;
  if (step.selection) {
    const want = String(args[step.selection.input] ?? "");
    nodes = nodes.filter((node) => {
      const got = node[step.selection!.by];
      return typeof got === "string" && got.replace(/\s+/g, " ").trim() === want;
    });
  }
  const list = locatorList(step, locatorMode);
  if (list) {
    for (const locator of list) {
      const found = matchLocator(locator, nodes, tree.boxes, tree.hidden);
      if (!found) continue;
      return {
        nodes,
        hit: { ok: true, index: found.index, ranked: [] },
        via: { stepId: step.id, kind: locator.kind, detail: found.detail },
      };
    }
    return {
      nodes,
      hit: { ok: false, reason: "below-threshold", brokenAttr: list[0]?.kind || "locator", ranked: [] },
    };
  }
  if (!step.identity) {
    return { nodes: [], hit: { ok: false, reason: "no-candidates", brokenAttr: "identity", ranked: [] } };
  }
  return { nodes, hit: lookup(step.identity, nodes) };
}

function locatorList(step: WorkflowStep, mode: LocatorMode): StepLocator[] | undefined {
  const list = step.locators;
  if (!list || list.length === 0) return undefined;
  return mode === "primary" ? list.slice(0, 1) : list;
}

async function act(step: WorkflowStep, node: Identity, args: ReplayArgs, driver: Driver, gate: ApplyGate): Promise<void> {
  if (step.action === "type") {
    const text = String(args[step.input || ""] ?? "");
    await driver.fill(node, text, !!step.sensitive || step.identity?.role === "password");
    return;
  }
  if (step.action === "upload") {
    await driver.upload(node, files(args, step.input));
    return;
  }
  if (step.action === "drop") {
    await driver.drop(node, files(args, step.input));
    return;
  }
  if (step.action === "check") {
    await driver.check(node, !!step.checked);
    return;
  }
  if (step.action === "key") {
    await driver.key(step.key || "Enter");
    return;
  }
  if (!await guardedClick(driver, gate, step.id, node)) {
    throw new Error("refusing to click Apply without a human confirm");
  }
}

export function holdsExpect(expect: NonNullable<WorkflowStep["expect"]>, tree: LiveTree, args: ReplayArgs): boolean {
  if (expect.kind === "url") return (tree.url || "").includes(expectedText(expect.match || "", args));
  if (expect.kind === "text") {
    const want = expectedText(expect.match || "", args);
    return tree.texts.some((text) => text.includes(want));
  }
  const identity = expect.identity || undefined;
  if (!identity) return false;
  const hit = lookup(identity, tree.nodes);
  if (!hit.ok || hit.index == null) return false;
  const flag = tree.flags?.[hit.index];
  if (expect.state === "checked") return !!flag?.checked;
  if (expect.state === "unchecked") return !flag?.checked;
  if (expect.state === "disabled") return flag?.enabled === false;
  if (expect.state === "enabled") return flag?.enabled !== false;
  return true;
}

export function holds(post: NonNullable<WorkflowStep["postcondition"]>, tree: LiveTree, args: ReplayArgs): boolean {
  if (post.kind === "element") {
    const identity = post.identity;
    if (!identity) return true;
    return lookup(identity, tree.nodes).ok;
  }
  if (post.kind === "absent") {
    if (!post.identity) return true;
    return !lookup(post.identity, tree.nodes).ok;
  }
  const expected = expectedText(post.match || "", args);
  if (post.kind === "url") return (tree.url || "").includes(expected);
  if (post.kind === "text") return tree.texts.some((text) => text.includes(expected));
  if (post.kind === "value") {
    if (tree.values.some((item) => item.value === expected || item.value.includes(expected))) return true;
    return tree.texts.some((text) => text === expected || text.includes(expected));
  }
  return false;
}

export function expectedText(match: string, args: ReplayArgs): string {
  const arith = match.match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}([+\-*/])\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/);
  if (arith) {
    const left = Number(args[arith[1]!] ?? subst(`{{${arith[1]}}}`, args));
    const right = Number(args[arith[3]!] ?? subst(`{{${arith[3]}}}`, args));
    const op = arith[2];
    const n = op === "+" ? left + right : op === "-" ? left - right : op === "*" ? left * right : left / right;
    return String(n);
  }
  return subst(match, args);
}

function files(args: ReplayArgs, name: string | undefined): FileArg[] {
  if (!name) return [];
  const value = args[name];
  if (!value || typeof value === "string" || typeof value === "number") return [];
  return Array.isArray(value) ? value : [value];
}

function secretValues(workflow: WorkflowV2, args: ReplayArgs): string[] {
  const out: string[] = [];
  for (const input of workflow.inputs) {
    if (input.type !== "secret") continue;
    const value = args[input.name];
    if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

function noteTrajectory(
  trajectory: TrajectoryStep[],
  step: WorkflowStep,
  acted: Identity | undefined,
  ok: boolean,
  elapsedMs: number,
): void {
  const post = postKey(step);
  trajectory.push({
    stepId: step.id,
    action: step.action,
    target: targetKey(acted || step.identity),
    postcondition: ok ? post : `missed ${post}`,
    timing: timingBucket(Math.max(0, elapsedMs)),
  });
}

async function holdCheck(check: StepCheck, args: ReplayArgs, driver: Driver, present: boolean): Promise<boolean> {
  const ready = async () => {
    const tree = await driver.tree();
    const holds = checkHolds(check, tree, args);
    return present ? holds : !holds;
  };
  if (await ready()) return true;
  const timeout = check.timeoutMs || 0;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await (driver.sleep ? driver.sleep(50) : sleep(50));
    if (await ready()) return true;
  }
  return false;
}

function checkHolds(check: StepCheck, tree: LiveTree, args: ReplayArgs): boolean {
  const want = expectedText(check.match || "", args);
  if (check.kind === "url") return (tree.url || "").includes(want);
  if (check.kind === "text") return !!want && tree.texts.some((text) => text.includes(want));
  if (check.kind === "value") {
    if (tree.values.some((item) => item.value === want || item.value.includes(want))) return true;
    return tree.texts.some((text) => text === want || text.includes(want));
  }
  if (!check.identity) return false;
  return lookup(check.identity, tree.nodes).ok;
}

function checkReason(check: StepCheck): string {
  return check.match || check.identity?.name || check.identity?.id || check.kind;
}

async function takeReadBack(
  workflow: WorkflowV2,
  step: WorkflowStep,
  read: ReadBack,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  receiptLog: ReceiptLog,
  runId: string,
): Promise<StepFailure | undefined> {
  const expected = maskRead(expectedText(read.match, args), secrets);
  let actual = "";
  let pass = false;
  const start = Date.now();
  const timeout = read.timeoutMs || 0;
  do {
    try {
      const seen = await readActual(read, args, driver);
      actual = maskRead(clipRead(seen), secrets);
      pass = readMatches(expected, actual);
    } catch (err) {
      actual = maskRead(err instanceof Error ? err.message : String(err), secrets);
      pass = false;
    }
    if (pass || Date.now() - start >= timeout) break;
    await (driver.sleep ? driver.sleep(100) : sleep(100));
  } while (Date.now() - start < timeout);
  receiptLog.append({
    kind: "read-back",
    ts: Date.now(),
    runId,
    workflowId: workflow.id,
    stepId: step.id,
    source: read.source,
    expected,
    actual,
    pass,
  });
  if (pass) return undefined;
  return fail(driver, step, "expect", `read-back expected "${expected}", read "${actual}"`, undefined, secrets);
}

async function readActual(read: ReadBack, args: ReplayArgs, driver: Driver): Promise<string> {
  if (read.source === "file") {
    const file = args[read.fileInput || ""];
    if (typeof file !== "string" || !file) throw new Error("read-back file is missing");
    return readThrowaway(file);
  }
  const tree = await driver.tree();
  if (read.source === "url") return tree.url || "";
  if (read.source === "text") {
    const want = expectedText(read.match, args);
    return tree.texts.find((text) => text.includes(want)) || tree.texts.join(" ").slice(0, 500);
  }
  if (read.identity) {
    const hit = lookup(read.identity, tree.nodes);
    if (hit.ok && hit.index != null) {
      const value = tree.values.find((item) => item.identity === tree.nodes[hit.index!]);
      if (value) return value.value;
    }
  }
  const want = expectedText(read.match, args);
  const value = tree.values.find((item) => item.value === want || item.value.includes(want));
  return value?.value || "";
}

function readMatches(expected: string, actual: string): boolean {
  if (!expected) return false;
  return actual.trimEnd() === expected.trimEnd() || actual.includes(expected);
}

function maskRead(value: string, secrets: string[]): string {
  return maskText(value, secrets);
}

function clipRead(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

function phaseReason(failure: StepFailure): string {
  return `${failure.phase}: ${failure.reason}`;
}

function expectReason(step: WorkflowStep): string {
  if (step.expect?.kind === "text" || step.expect?.kind === "url") return step.expect.match || step.expect.kind;
  if (step.expect?.state) return step.expect.state;
  if (step.postcondition) return "postcondition";
  return "expect";
}

async function fail(
  driver: Driver,
  step: WorkflowStep,
  phase: ReplayPhase,
  reason: string,
  brokenAttr: string | undefined,
  secrets: string[],
): Promise<StepFailure> {
  const snapshot = maskSnapshot(await driver.snapshot(), secrets);
  return {
    stepId: step.id,
    index: step.index,
    intent: step.intent || step.label,
    phase,
    reason,
    brokenAttr,
    snapshot,
  };
}

function noteAuth(trail: RunTrailEvent[], stepId: string, recovered: boolean): void {
  if (trail.some((event) => event.kind === "auth" && event.stepId === stepId)) return;
  trail.push({
    kind: "auth",
    stepId,
    phase: "auth",
    reason: recovered ? "redirected to login" : "redirected to login",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeStepShot(driver: Driver, dir: string | undefined, step: WorkflowStep, which: "before" | "after"): Promise<string | undefined> {
  if (!dir || !driver.shot) return;
  try {
    const png = await driver.shot({
      identity: step.identity,
      action: step.action,
      label: step.label,
      text: step.expect?.match || step.postcondition?.match,
    });
    if (!png || png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) return;
    mkdirSync(dir, { recursive: true });
    const name = shotFile(step.id, which);
    writeFileSync(path.join(dir, name), png);
    return name;
  } catch {
    return;
  }
}
