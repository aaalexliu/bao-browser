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
import { anchorCandidate, labelCandidate, overlayClose, type RepairLog } from "./repair";
import {
  subst,
  type FileArg,
  type Identity,
  type ReplayArgs,
  type WorkflowStep,
  type WorkflowV2,
} from "./schema";

export interface LiveTree {
  nodes: Identity[];
  url?: string;
  texts: string[];
  values: { identity: Identity; value: string }[];
  boxes?: { x: number; y: number; w: number; h: number }[];
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
  steps: { id: string; status: "passed" | "failed" | "paused" | "pending"; reason?: string }[];
  failure?: StepFailure;
  heals: HealRecord[];
  repairs: RepairLog[];
  proposal?: HealProposal;
  pausedStepId?: string;
}

export interface ReplayOptions {
  runId?: string;
  now?: () => number;
  secrets?: string[];
  settings?: HealSettings;
  heal?: HealProvider;
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

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    if (step.unresolved) {
      const failure = await fail(driver, step, "locate", "unresolved step", undefined, secrets);
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure) };
      return { runId, status: "failed", steps, failure, heals, repairs };
    }
    const outcome = await runStep(workflow, step, args, driver, secrets);
    repairs.push(...outcome.repairs);
    if (outcome.ok) {
      steps[i] = { id: step.id, status: "passed" };
      continue;
    }
    const failure = outcome.failure;
    if (!heal || !heal.available()) {
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure) };
      return { runId, status: "failed", steps, failure, heals, repairs };
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
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(failure) };
      return { runId, status: "failed", steps, failure, heals, repairs };
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
      steps[i] = { id: step.id, status: "paused", reason: "approve" };
      return { runId, status: "paused", steps, failure, heals, repairs, proposal, pausedStepId: step.id };
    }
    const patched = applyPatch(step, proposal.patch);
    const retried = await runStep(workflow, patched, args, driver, secrets);
    repairs.push(...retried.repairs);
    record.executed = { action: patched.action, identity: patched.identity };
    record.postconditionPassed = retried.ok;
    heals.push(record);
    if (!retried.ok) {
      steps[i] = { id: step.id, status: "failed", reason: phaseReason(retried.failure) };
      return { runId, status: "failed", steps, failure: retried.failure, heals, repairs };
    }
    steps[i] = { id: step.id, status: "passed" };
  }
  return { runId, status: "passed", steps, heals, repairs };
}

type StepOutcome = { ok: true; repairs: RepairLog[] } | { ok: false; failure: StepFailure; repairs: RepairLog[] };

async function runStep(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
): Promise<StepOutcome> {
  const repairs: RepairLog[] = [];
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
      return { ok: false, repairs, failure: await fail(driver, step, "act", err instanceof Error ? err.message : String(err), undefined, secrets) };
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
      return { ok: false, repairs, failure: await fail(driver, step, "act", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    if (!await readExpect(step, args, driver, repairs)) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs };
  }
  const found = await findTarget(step, args, driver, repairs);
  if (!found.hit.ok || found.hit.index == null) {
    return {
      ok: false,
      repairs,
      failure: await fail(driver, step, "locate", found.hit.reason || "lookup miss", found.hit.brokenAttr, secrets),
    };
  }
  const node = found.nodes[found.hit.index];
  if (!node) {
    return { ok: false, repairs, failure: await fail(driver, step, "locate", "lookup miss", found.hit.brokenAttr, secrets) };
  }
  try {
    await act(step, node, args, driver);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, repairs, failure: await fail(driver, step, "act", reason, found.hit.brokenAttr, secrets) };
  }
  if (!await readExpect(step, args, driver, repairs)) {
    return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
  }
  return { ok: true, repairs };
}

async function findTarget(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  repairs: RepairLog[],
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup> }> {
  let tree = await driver.tree();
  const close = overlayClose(tree.nodes);
  if (close) {
    await driver.click(close);
    repairs.push({ stepId: step.id, repair: "overlay", detail: close.text || close.name || "overlay" });
    tree = await driver.tree();
  }
  let located = locate(step, tree, args);
  if (located.hit.ok) return located;
  const labeled = labelCandidate(step, tree.nodes);
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
  const waited = await poll(step, args, driver);
  if (waited.hit.ok) {
    repairs.push({ stepId: step.id, repair: "wait", detail: `waited for ${step.timeoutMs}ms` });
    return waited;
  }
  return waited;
}

async function readExpect(step: WorkflowStep, args: ReplayArgs, driver: Driver, repairs: RepairLog[]): Promise<boolean> {
  if (await expectationsHold(step, await driver.tree(), args)) return true;
  if (!step.expect && !step.postcondition) return true;
  if (driver.waitIdle) await driver.waitIdle(Math.min(step.expect?.timeoutMs || step.timeoutMs || 1000, 2000));
  await (driver.sleep ? driver.sleep(50) : sleep(50));
  if (await expectationsHold(step, await driver.tree(), args)) {
    repairs.push({ stepId: step.id, repair: "wait", detail: "expect became true" });
    return true;
  }
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
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup> }> {
  const timeout = step.timeoutMs ?? 0;
  const start = Date.now();
  let located = locate(step, await driver.tree(), args);
  while (!located.hit.ok && Date.now() - start < timeout) {
    await (driver.sleep ? driver.sleep(50) : sleep(50));
    located = locate(step, await driver.tree(), args);
  }
  return located;
}

function locate(
  step: WorkflowStep,
  tree: LiveTree,
  args: ReplayArgs,
): { nodes: Identity[]; hit: ReturnType<typeof lookup> } {
  if (!step.identity) {
    return { nodes: [], hit: { ok: false, reason: "no-candidates", brokenAttr: "identity", ranked: [] } };
  }
  let nodes = tree.nodes;
  if (step.selection) {
    const want = String(args[step.selection.input] ?? "");
    nodes = nodes.filter((node) => {
      const got = node[step.selection!.by];
      return typeof got === "string" && got.replace(/\s+/g, " ").trim() === want;
    });
  }
  return { nodes, hit: lookup(step.identity, nodes) };
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
