// Deterministic replay. Lookup uses the identity scorer. A miss stops the run
// unless a heal provider is available. Auto applies the patch without waiting.
// Approve returns a pause. The saved workflow is not edited here.

import { lookup } from "./identity";
import {
  applyPatch,
  effectiveMode,
  maskSnapshot,
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
}

export interface RunResult {
  runId: string;
  status: "passed" | "failed" | "paused";
  steps: { id: string; status: "passed" | "failed" | "paused" | "pending"; reason?: string; phase?: ReplayPhase }[];
  failure?: StepFailure;
  heals: HealRecord[];
  repairs: RepairLog[];
  locatorHits: LocatorHit[];
  receipts: Receipt[];
  trajectory: TrajectoryStep[];
  proposal?: HealProposal;
  pausedStepId?: string;
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
}

let seq = 0;

export async function replay(
  workflow: WorkflowV2,
  args: ReplayArgs,
  driver: Driver,
  opts: ReplayOptions = {},
): Promise<RunResult> {
  const runId = opts.runId || `run-${++seq}`;
  const now = opts.now ?? (() => 0);
  const settings = opts.settings ?? {};
  const heal = opts.heal;
  const secrets = opts.secrets ?? secretValues(workflow, args);
  const mode = effectiveMode(workflow, settings);
  const steps: RunResult["steps"] = workflow.steps.map((step) => ({ id: step.id, status: "pending" }));
  const heals: HealRecord[] = [];
  const repairs: RepairLog[] = [];
  const locatorHits: LocatorHit[] = [];
  const locatorMode = opts.locators ?? "all";
  const receiptLog = opts.receipts ?? new ReceiptLog();
  const trajectory: TrajectoryStep[] = [];
  const clock = opts.nowMs ?? (() => Date.now());

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    const started = clock();
    const extra = i === workflow.steps.length - 1 ? workflow.readBack : undefined;
    if (step.unresolved) {
      const failure = await fail(driver, step, "find", "unresolved step", undefined, secrets);
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase };
      noteTrajectory(trajectory, step, undefined, false, clock() - started);
      return { runId, status: "failed", steps, failure, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory };
    }
    const outcome = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, extra);
    repairs.push(...outcome.repairs);
    if (outcome.ok) {
      steps[i] = { id: step.id, status: "passed" };
      noteTrajectory(trajectory, step, outcome.acted, true, clock() - started);
      continue;
    }
    const failure = outcome.failure;
    if (!heal || !heal.available()) {
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase };
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return { runId, status: "failed", steps, failure, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory };
    }
    const proposal = await heal.propose(failure, step);
    const prompt = proposal?.prompt || "";
    const record: HealRecord = {
      id: `heal-${heals.length + 1}`,
      ts: now(),
      workflowId: workflow.id,
      runId,
      mode,
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
    };
    if (!proposal) {
      heals.push(record);
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase };
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return { runId, status: "failed", steps, failure, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory };
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
      steps[i] = { id: step.id, status: "paused", reason: "approve", phase: failure.phase };
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return { runId, status: "paused", steps, failure, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory, proposal, pausedStepId: step.id };
    }
    const patched = applyPatch(step, proposal.patch);
    const retried = await runStep(workflow, patched, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, extra);
    repairs.push(...retried.repairs);
    record.executed = { action: patched.action, identity: patched.identity };
    record.postconditionPassed = retried.ok;
    heals.push(record);
    if (!retried.ok) {
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(retried.failure), phase: retried.failure.phase };
      noteTrajectory(trajectory, patched, retried.acted, false, clock() - started);
      return { runId, status: "failed", steps, failure: retried.failure, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory };
    }
    steps[i] = { id: step.id, status: "passed" };
    noteTrajectory(trajectory, patched, retried.acted, true, clock() - started);
  }
  return { runId, status: "passed", steps, heals, repairs, locatorHits, receipts: receiptLog.entries, trajectory };
}

type StepOutcome = { ok: true; repairs: RepairLog[]; acted?: Identity } | { ok: false; failure: StepFailure; repairs: RepairLog[]; acted?: Identity };

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
  extra?: ReadBack,
): Promise<StepOutcome> {
  const repairs: RepairLog[] = [];
  if (step.waitFor) {
    const ready = await holdCheck(step.waitFor, args, driver, true);
    if (!ready) {
      return { ok: false, repairs, failure: await fail(driver, step, "wait_for", checkReason(step.waitFor), undefined, secrets) };
    }
  }
  const outcome = await runStepAction(step, args, driver, secrets, repairs, locatorHits, locatorMode);
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
): Promise<StepOutcome> {
  if (step.action === "confirm") return runConfirm(step, args, driver, secrets);
  if (step.action === "login") return runLogin(step, args, driver, secrets);
  if (step.action === "verify") {
    const held = await readExpect(step, args, driver, repairs);
    if (!held) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    return { ok: true, repairs };
  }
  if (step.action === "key" && !step.identity) {
    try {
      await driver.key(step.key || "Enter");
    } catch (err) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    if (!await readExpect(step, args, driver, repairs)) {
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
    if (!await readExpect(step, args, driver, repairs)) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs, acted: step.identity };
  }
  const found = await findTarget(step, args, driver, repairs, locatorHits, locatorMode);
  if (!found.hit.ok || found.hit.index == null) {
    return {
      ok: false,
      repairs,
      failure: await fail(driver, step, "find", found.hit.reason || "lookup miss", found.hit.brokenAttr, secrets),
    };
  }
  const node = found.nodes[found.hit.index];
  if (!node) {
    return { ok: false, repairs, failure: await fail(driver, step, "find", "lookup miss", found.hit.brokenAttr, secrets) };
  }
  try {
    await act(step, node, args, driver);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, repairs, acted: node, failure: await fail(driver, step, "action", reason, found.hit.brokenAttr, secrets) };
  }
  if (!await readExpect(step, args, driver, repairs)) {
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
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup> }> {
  let tree = await driver.tree();
  const close = overlayClose(tree.nodes);
  if (close) {
    await driver.click(close);
    repairs.push({ stepId: step.id, repair: "overlay", detail: close.text || close.name || "overlay" });
    tree = await driver.tree();
  }
  let located = locate(step, tree, args, locatorMode);
  if (shouldReveal(step, tree, located, locatorMode)) {
    const opened = await openReveal(step, tree, driver, repairs, locatorMode);
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
  try {
    await driver.click(node);
  } catch {
    return false;
  }
  // The opened field replaces the collapsed one. Wait until that swap settles
  // before the next dump, or the handle is on a node fill cannot use.
  await (driver.sleep ? driver.sleep(300) : sleep(300));
  repairs.push({ stepId: step.id, repair: "reveal", detail: pick.detail });
  return true;
}

async function readExpect(step: WorkflowStep, args: ReplayArgs, driver: Driver, repairs: RepairLog[]): Promise<boolean> {
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
  if (close) {
    await driver.click(close);
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
): Promise<StepOutcome> {
  await driver.showConfirm?.(step.label);
  try {
    const timeout = step.timeoutMs ?? 0;
    const start = Date.now();
    let seen = await driver.tree();
    while (step.postcondition && !holds(step.postcondition, seen, args) && Date.now() - start < timeout) {
      await (driver.sleep ? driver.sleep(200) : sleep(200));
      seen = await driver.tree();
    }
    if (step.postcondition && !holds(step.postcondition, seen, args)) {
      return { ok: false, repairs: [], failure: await fail(driver, step, "expect", "postcondition", undefined, secrets) };
    }
    return { ok: true, repairs: [] };
  } finally {
    await driver.clearConfirm?.();
  }
}

async function runLogin(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
): Promise<StepOutcome> {
  await driver.showLoginWait?.(step.label);
  try {
    const timeout = step.timeoutMs ?? 0;
    const start = Date.now();
    let seen = await driver.tree();
    while (step.postcondition && !holds(step.postcondition, seen, args) && Date.now() - start < timeout) {
      await (driver.sleep ? driver.sleep(200) : sleep(200));
      seen = await driver.tree();
    }
    if (step.postcondition && !holds(step.postcondition, seen, args)) {
      return { ok: false, repairs: [], failure: await fail(driver, step, "expect", "waiting for you to log in", undefined, secrets) };
    }
    return { ok: true, repairs: [] };
  } finally {
    await driver.clearLoginWait?.();
  }
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

async function act(step: WorkflowStep, node: Identity, args: ReplayArgs, driver: Driver): Promise<void> {
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
  await driver.click(node);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
