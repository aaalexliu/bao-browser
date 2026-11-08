// Deterministic replay. Lookup uses the identity scorer. A miss stops the run
// unless a heal provider is available. Auto applies the patch without waiting.
// Approve returns a pause. The saved workflow is not edited here.
// A login redirect is phase `auth` and is not sent to a model.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { hasStrippedSecret, NEEDS_SECRET_VALUE, oneTimeCodeInput, stepNeedsSecretValue } from "../../../shared/saved-secrets";
import type { ApplyGate as BaseApplyGate, RunTrailEvent } from "./apply-guard";
import { authPreconditionMiss, pathMatches, secretArg, textArg } from "./auth";
import { materializeOutputs, performDataStep, type ExtractSpec, type OutputValue } from "./data-steps";
import { findDebugDir, queriesForLocators, writeFindDebug } from "./find-debug";
import { lookup, normRole, pathEq, sameRecordedControl, unstableId } from "./identity";
import { actWaitMs, confirmButton, makeAsk, siteHost, wallInstruction, type HumanAsk } from "./human-ask";
import { formatClock } from "./time";
import { identityView } from "./run-trace";
import { applyPatch, stepPolicy, type FailureSnapshot, type HealProposal, type HealProvider, type HealRecord, type HealSettings, type ReplayPhase, type StepFailure, type TriedLocator } from "./heal";
import { isCollapsedBox, locatorIndexes, matchLabeledControl, matchLocator, scoreLocator } from "./locators";
import { classifyFailure } from "./triage";
import { findRecovery, hardFailure, hasCaptcha, RECOVERY_LIMIT } from "./recover";
import { classifyPage, recordingExpectsLogin, type PageClassDecision, type PageClassRecord, type PageSignals } from "./page-class";
import { ReceiptLog, readThrowaway, type Receipt } from "./receipt";
import { collapsedTarget, discoverReveal, labelCandidate, recordedReveal, anchorCandidate, type RepairLog } from "./repair";
import { beginFilesRun, downloadFileName, endFilesRun, fileDigest, filesFor, filesRun, openTarget, placeDownload, prepareFilesDatesRun, renderTemplate, templateScope, type FileOutput } from "./files-dates";
import { stepOptional, stepDownload, stepOpen, popupDismissName, stepCheck, stepDate, stepForEach, stepInputName, stepKey, stepLocators, stepQuery, stepTitle, stepValueTemplate, subst, type Check, type FileArg, type Identity, type ReadBack, type ReplayArgs, type StepLocator, type WorkflowStep, type WorkflowV2 } from "./schema";
import { shotFile, shotFormat } from "./shots";
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
  /** Parallel to nodes. True when the node sits inside a dialog. */
  inDialog?: boolean[];
  flags?: { checked?: boolean; enabled?: boolean }[];
}

export interface HealNotice {
  title: string;
  body: string;
  workflowId: string;
  runId: string;
  stepId: string;
}

/** A person did this on the page. Guide Me reads it. It is not an automated action. */
export interface GuideAct {
  op: "click" | "type" | "key" | "check";
  id?: string;
  testId?: string;
  name?: string;
  value?: string;
  key?: string;
  secret?: boolean;
  ts: number;
}

export interface Driver {
  tree(): Promise<LiveTree>;
  snapshot(): Promise<FailureSnapshot>;
  /** Count the recorded locator in the live DOM. Debug only. Not a score. */
  probe?(queries: { kind: "css" | "text" | "role" | "xpath"; query: string; role?: string; name?: string }[]): Promise<{ url: string; hits: { kind: string; query: string; count: number; visible: number }[] }>;
  click(node: Identity): Promise<void>;
  /** The next native prompt accepts this text. Alert and confirm stay empty. */
  answerDialog?(value: string): void;
  fill(node: Identity, text: string, secret: boolean): Promise<void>;
  key(key: string): Promise<void>;
  upload(node: Identity, files: FileArg[]): Promise<void>;
  drop(node: Identity, files: FileArg[]): Promise<void>;
  digits(app: string | undefined, role: string, text: string): Promise<void>;
  check(node: Identity, checked: boolean): Promise<void>;
  /** Open a recorded URL. Absent when the host already loaded startUrl. */
  goto?(url: string): Promise<void>;
  /** Choose an option by its visible label, or by its value when the label misses. */
  select?(node: Identity, value: string): Promise<void>;
  /** Move focus onto the key step's target before the key is pressed. */
  focus?(node: Identity): Promise<void>;
  notify(notice: HealNotice): Promise<void>;
  sleep?(ms: number): Promise<void>;
  waitIdle?(timeoutMs: number): Promise<void>;
  /** Read every row of an extract spec. Browser drivers only. */
  readList?(spec: ExtractSpec): Promise<{ rows: Record<string, string>[]; nextVisible: boolean }>;
  /** Click a pagination control matched by locators, not by a single identity. */
  activate?(locators: StepLocator[]): Promise<boolean>;
  /** Shown in the Bao window. Replay does not click Apply. */
  showConfirm?(label: string): void | Promise<void>;
  clearConfirm?(runId: string): void | Promise<void>;
  showLoginWait?(label: string): void | Promise<void>;
  clearLoginWait?(runId: string): void | Promise<void>;
  /** The product window's handoff prompt. Replay still does not press the site button. */
  showAsk?(ask: HumanAsk): void | Promise<void>;
  shouldStop?(): boolean;
  loginContinued?(): boolean;
  ownerContinued?(): boolean;
  /** Page PNG or JPEG of the target. Unit-test drivers omit this. */
  shot?(target?: ShotTarget): Promise<Buffer | undefined>;
  /** Full viewport. Unit-test drivers omit this. */
  pageShot?(): Promise<Buffer | undefined>;
  /** Tags console and network lines with the step that is running. */
  markStep?(id: string): void;
  /** DOM and accessibility tree at the end of the step. Browser drivers only. */
  captureStep?(): Promise<{ dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string }>;
  /** Draw the match. Not an action: Try and element crops use this and do not click or type. */
  outline?(node: Identity): Promise<void>;
  /** Ring the control itself. Guide Me uses this. It does not click or type. */
  highlightTarget?(node: Identity): Promise<void>;
  /** The next person action, if the driver is watching the page. */
  performed?(): Promise<GuideAct | null>;
  /** Arm CDP download capture, trigger the download, and return the saved path. */
  download?(spec: { dir: string; filename: string; timeoutMs: number; url?: string; node?: Identity }): Promise<{ suggestedFilename: string; path: string }>;
  /** Click or drag the cell for a resolved date. Recorded day clicks are not replayed. */
  pickDate?(spec: { iso: string; endIso?: string; formatted?: string; node?: Identity }): Promise<void>;
  /** Drop trail capture while a person has the page. */
  pauseCapture?(): void;
  resumeCapture?(): void;
  trace?(): {
    unavailable?: string;
    console: { stepId?: string; type?: string; text: string; ts?: number }[];
    network: { stepId?: string; method?: string; url: string; status?: number; ts?: number }[];
  };
  /** DOM, iframes, headers, and cookies for the pre-heal classifier. */
  pageSignals?(): Promise<PageSignals>;
  /** Click a known close control. Does not click a captcha. */
  dismissClutter?(): Promise<boolean>;
  /** Drop the visible replay indicator. Playwright has nothing to clear. */
  end?(): Promise<void>;
}

export interface ShotTarget {
  identity?: Identity;
  action?: string;
  label?: string;
  text?: string;
}

export interface RunResult {
  runId: string;
  pageEngine?: "old" | "agent-browser";
  traceUnavailable?: string;
  /** Run-local CDP video, when the selected live engine recorded one. */
  video?: string;
  videoStartedAt?: number;
  videoTruncated?: boolean;
  status: "passed" | "failed" | "paused";
  steps: {
    id: string;
    status: "passed" | "failed" | "paused" | "pending" | "skipped";
    reason?: string;
    phase?: ReplayPhase;
    startedAt?: number;
    endedAt?: number;
    beforeShot?: string;
    afterShot?: string;
    target?: { rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number } };
    beforeShotError?: string;
    afterShotError?: string;
    triage?: string;
    snapshot?: { dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string };
  }[];
  console?: { stepId?: string; type?: string; text: string; ts?: number }[];
  network?: { stepId?: string; method?: string; url: string; status?: number; ts?: number }[];
  failure?: StepFailure;
  navigationBlock?: import("../cdp-live/live-record").LiveNavigationBlock;
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
  /** Set when replay stopped for a person instead of a heal approval. */
  pausedKind?: "signin" | "confirm" | "wall";
  /** Classifier decisions for this run, including the evidence. */
  pageClasses: PageClassRecord[];
  /** The ask that is waiting. Absent when the run is not waiting on a person. */
  ask?: HumanAsk;
  /** Heal proposals that named a model. Zero is a run that did not call one. */
  modelCalls: number;
  /** Filled from workflow.outputs. Absent when the workflow declares none. */
  outputs?: OutputValue[];
  /** A live replay detached and left its final page in Chrome. */
  pageLeftOpen?: boolean;
  /** Download files from this run. Paths live only here. */
  files?: Record<string, FileOutput>;
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
  /** Directory for per-step PNGs or JPEGs. Absent skips capture. */
  shotDir?: string;
  /** Auto-heal stays off after too many recent failures. */
  circuitOpen?: boolean;
  /** Steps whose last runs each needed a heal. Auto-heal stays off for these. */
  reviewSteps?: ReadonlySet<string>;
  /** Replay starts here. Earlier steps are not run again. */
  fromStepId?: string;
  /** Return as soon as a person must sign in or confirm. The page is not clicked. */
  yieldHuman?: boolean;
  /** Observe the resumed human step, or accept the owner's local completion signal. Never press it. */
  humanReady?: boolean | "confirmed";
  /** Trail lines already recorded for this run. Resume appends the handoff end. */
  trail?: RunTrailEvent[];
  /** Desktop waits on Continue. MCP and unit tests return as soon as the wall is raised. */
  holdForPerson?: boolean;
  /** Called when a wall pauses the run, before the wait, so the run page can show it. */
  onPause?: (result: RunResult) => void;
  /** IANA zone for date inputs. Absent uses the host zone. */
  zone?: string;
  /** Per-run download root. Each run gets a folder under it. */
  downloadDir?: string;
  /** Clock for resolving relative dates. Absent uses nowMs or the current time. */
  clock?: Date;
  /** Spawn used by an open-file step. Absent runs xdg-open or open. */
  openExec?: (argv: string[]) => Promise<void>;
}

type ApplyGate = BaseApplyGate & { onPause?: (ask: HumanAsk) => void };

let seq = 0;

export function withInputDefaults(workflow: WorkflowV2, args: ReplayArgs): ReplayArgs {
  const defaults = Object.fromEntries(workflow.inputs.flatMap((input) => input.type !== "file" && !oneTimeCodeInput(workflow, input.name) && input.default !== undefined
    ? [[input.name, input.type === "number" && !hasStrippedSecret(input.default) ? Number(input.default) : input.default]] : []));
  return { ...defaults, ...args };
}

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
  args = withInputDefaults(workflow, args);
  const secrets = opts.secrets ?? secretValues(workflow, args);
  const steps: RunResult["steps"] = workflow.steps.map((step) => ({ id: step.id, status: "pending" }));
  const heals: HealRecord[] = [];
  const repairs: RepairLog[] = [];
  const locatorHits: LocatorHit[] = [];
  const locatorMode = opts.locators ?? "all";
  const receiptLog = opts.receipts ?? new ReceiptLog();
  const trajectory: TrajectoryStep[] = [];
  const trail: RunTrailEvent[] = opts.trail ?? [];
  const gate: ApplyGate = {
    workflow,
    trail,
    actTimeoutMs: settings.actTimeoutMs,
    runId,
    yieldHuman: opts.yieldHuman,
  };
  const clock = opts.nowMs ?? (() => Date.now());
  let precondition: RunResult["precondition"];
  const tables = new Map<string, Record<string, string>[]>();
  const pageClasses: PageClassRecord[] = [];
  const filesClock = opts.clock ?? new Date(opts.nowMs ? opts.nowMs() : Date.now());
  const prepared = prepareFilesDatesRun(workflow, args, {
    now: filesClock,
    zone: opts.zone,
    runId,
    downloadDir: opts.downloadDir || path.join(tmpdir(), "bao-runs"),
    openExec: opts.openExec,
  });
  args = prepared.args;
  beginFilesRun(prepared);

  const finish = (partial: Omit<RunResult, "trail" | "precondition" | "receipts" | "repairs" | "locatorHits" | "heals" | "trajectory" | "modelCalls" | "pageClasses"> & Partial<RunResult>): RunResult => {
    const trace = driver.trace?.();
    const downloaded = Object.fromEntries(prepared.outputs);
    const outputs = materializeOutputs(workflow, tables);
    return {
      heals,
      repairs,
      locatorHits,
      receipts: receiptLog.entries,
      trajectory,
      trail,
      precondition,
      pageClasses,
      console: trace?.console || [],
      network: trace?.network || [],
      ...(trace?.unavailable ? { traceUnavailable: trace.unavailable } : {}),
      ...partial,
      ...(outputs ? { outputs } : {}),
      ...(Object.keys(downloaded).length ? { files: downloaded } : {}),
      modelCalls: heals.filter((item) => item.model).length,
    };
  };

  const execute = async (): Promise<RunResult> => {
  const fromIndex = opts.fromStepId ? workflow.steps.findIndex((item) => item.id === opts.fromStepId) : 0;
  const startAt = fromIndex < 0 ? 0 : fromIndex;
  const recovery: RecoveryBudget = { used: 0 };
  let guard: PageGuard | undefined;
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i]!;
    gate.humanReady = i === startAt ? opts.humanReady : false;
    if (driver.shouldStop?.()) {
      steps[i] = { id: step.id, status: "failed", reason: "cancelled" };
      return finish({
        runId,
        status: "failed",
        steps,
        failure: {
          stepId: step.id,
          index: step.index,
          intent: step.caption.text || stepTitle(step),
          phase: "action",
          reason: "cancelled",
          snapshot: {},
        },
      });
    }
    if (i < startAt) {
      steps[i] = { id: step.id, status: "skipped", reason: "not re-run" };
      continue;
    }
    const wants = pageWhen(step);
    let skipReason = "";
    if (wants) {
      if (!guard || guard.key !== wants.key) {
        guard = { key: wants.key, open: pageShows(await driver.tree(), wants.text, wants.anyCount) === wants.shown };
      }
      if (!guard.open) skipReason = wants.shown ? "other branch" : "already done";
    } else {
      guard = undefined;
      if (step.when?.input && String(args[step.when.input] ?? "") !== (step.when.value ?? "")) skipReason = "other branch";
    }
    const mode = stepPolicy(step, workflow, settings);
    driver.markStep?.(step.id);
    let pictured = step;
    const started = clock();
    const yieldShot = opts.yieldHuman && !skipReason && step.action === "handoff";
    const before = yieldShot ? { error: "Pictures stay off while you have the page." } : await writeStepShot(driver, opts.shotDir, step, "before");
    const beforeShot = before.ref;
    const marked = "viewport" in before && before.viewport ? storedShotTarget(step) : undefined;
    const stamp = (patch: RunResult["steps"][number]) => {
      steps[i] = { ...patch, startedAt: started, endedAt: clock(), beforeShot, beforeShotError: before.error, ...(marked ? { target: marked } : {}) };
    };
    gate.onPause = (ask) => {
      stamp({ id: step.id, status: "paused", reason: ask.kind === "login" ? "sign in" : "confirm" });
      const paused = finish({ runId, status: "paused", steps, pausedStepId: step.id, pausedKind: ask.kind === "login" ? "signin" : "confirm", ask });
      opts.onPause?.(structuredClone(paused));
    };
    try {
    if (skipReason) {
      stamp({ id: step.id, status: "passed", reason: skipReason });
      continue;
    }
    const extra = i === workflow.steps.length - 1 ? workflow.readBack : undefined;
    if (!(step.action === "handoff" && step.reason === "sign-in") && stepNeedsSecretValue(step, workflow, args)) {
      const failure = await fail(driver, step, "action", NEEDS_SECRET_VALUE, undefined, secrets);
      stamp({ id: step.id, status: "failed", reason: NEEDS_SECRET_VALUE, phase: failure.phase });
      return finish({ runId, status: "failed", steps, failure });
    }
    const noteClass = (decision: PageClassDecision, keepChanged = false) => {
      if (!keepChanged && decision.class === "changed") return;
      const line = decision.class === "bot_wall" || decision.class === "login_wall"
        ? wallInstruction(siteHost(workflow.startUrl), decision.class === "login_wall" ? "login" : "bot")
        : undefined;
      const last = pageClasses[pageClasses.length - 1];
      if (last && last.stepId === step.id && last.class === decision.class) return;
      pageClasses.push({
        stepId: step.id,
        at: now(),
        class: decision.class,
        reason: decision.reason,
        vendor: decision.vendor,
        evidence: decision.evidence,
        line,
        dismiss: decision.dismiss,
      });
    };
    const holdWall = async (decision: PageClassDecision): Promise<{ result?: RunResult; next?: boolean; outcome?: StepOutcome }> => {
      noteClass(decision);
      const ask = makeAsk({
        kind: "wall",
        wall: decision.class === "login_wall" ? "login" : "bot",
        workflowId: workflow.id,
        workflowName: workflow.name,
        stepId: step.id,
        stepIndex: step.index + 1,
        stepCount: workflow.steps.length,
        label: stepTitle(step),
        site: siteHost(workflow.startUrl),
        timeoutMs: actWaitMs(undefined, settings.actTimeoutMs),
        runId,
      });
      await driver.showAsk?.(ask);
      beginHandoff(driver, gate, step.id);
      stamp({ id: step.id, status: "paused", reason: decision.class === "login_wall" ? "sign in" : "bot check" });
      const paused = finish({ runId, status: "paused", steps, pausedStepId: step.id, pausedKind: "wall", ask });
      opts.onPause?.(structuredClone(paused));
      if (!opts.holdForPerson) return { result: paused };
      const timeout = actWaitMs(undefined, settings.actTimeoutMs);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (driver.shouldStop?.()) {
          endHandoff(driver, gate, step.id);
          await driver.clearLoginWait?.(runId);
          stamp({ id: step.id, status: "failed", reason: "cancelled" });
          return { result: finish({ runId, status: "failed", steps, failure: await fail(driver, step, "find", "cancelled", undefined, secrets) }) };
        }
        if (driver.loginContinued?.()) {
          await driver.clearLoginWait?.(runId);
          endHandoff(driver, gate, step.id);
          const retried = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, extra, tables);
          repairs.push(...retried.repairs);
          if (retried.ok) {
            stamp({ id: step.id, status: "passed", ...(retried.recovered ? { reason: `recovered: ${retried.recovered}` } : {}) });
            noteTrajectory(trajectory, step, retried.acted, true, clock() - started);
            return { next: true };
          }
          if ("paused" in retried) return { outcome: retried };
          const again = await classifyLive(driver, workflow, step);
          if (again.class === "bot_wall" || again.class === "login_wall") {
            noteClass(again);
            await driver.showAsk?.(ask);
            beginHandoff(driver, gate, step.id);
            continue;
          }
          return { outcome: retried };
        }
        await (driver.sleep ? driver.sleep(200) : sleep(200));
      }
      endHandoff(driver, gate, step.id);
      await driver.clearLoginWait?.(runId);
      stamp({ id: step.id, status: "failed", reason: "stopped, timed out" });
      return { result: finish({ runId, status: "failed", steps, failure: await fail(driver, step, "find", "stopped, timed out", undefined, secrets) }) };
    };
    const before = step.action === "note" ? undefined : await classifyLive(driver, workflow, step);
    let outcome: StepOutcome | undefined;
    if (before && (before.class === "bot_wall" || before.class === "login_wall")) {
      const held = await holdWall(before);
      if (held.result) return held.result;
      if (held.next) continue;
      outcome = held.outcome;
    }
    let clutterPrimed = false;
    if (!stepOptional(step) && !outcome && before && before.class === "clutter") {
      noteClass(before);
      const nodes = (await driver.tree().catch(() => undefined))?.nodes || [];
      if (!findRecovery(nodes) && recovery.used < RECOVERY_LIMIT) {
        if (await dismissNamed(driver, before)) {
          recovery.used += 1;
          repairs.push({ stepId: step.id, repair: "overlay", detail: before.reason });
          clutterPrimed = true;
        }
      }
    }
    if (!outcome) outcome = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, extra, tables);
    if (!outcome.ok && "failure" in outcome && (outcome.failure.reason === "cancelled" || driver.shouldStop?.())) {
      const failure = { ...outcome.failure, reason: "cancelled" };
      stamp({ id: step.id, status: "failed", reason: "cancelled", phase: "action" });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    repairs.push(...outcome.repairs);
    if (!outcome.ok && "failure" in outcome && outcome.failure.phase === "auth" && !(step.action === "handoff" && step.reason === "sign-in")) {
      const recovered = await recoverAuth(workflow, step, args, driver, secrets, gate);
      if (recovered) {
        noteAuth(trail, step.id, true);
        precondition = { phase: "auth", reason: "redirected to login", recovered: true, stepId: step.id };
        outcome = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, extra, tables);
        repairs.push(...outcome.repairs);
      }
    }
    if (outcome.ok) {
      if (outcome.authRecovered || precondition?.stepId === step.id) {
        noteAuth(trail, step.id, true);
        precondition = { phase: "auth", reason: "redirected to login", recovered: true, stepId: step.id };
        stamp({ id: step.id, status: "passed", phase: "auth", reason: "auth: redirected to login" });
      } else {
        const passed = clutterPrimed
          ? "recovered: clutter"
          : (outcome.note || outcome.detail || (outcome.recovered ? `recovered: ${outcome.recovered}` : ""));
        stamp({ id: step.id, status: outcome.skipped ? "skipped" : "passed", ...(passed ? { reason: passed } : {}) });
      }
      noteTrajectory(trajectory, step, outcome.acted, true, clock() - started);
      continue;
    }
    if ("paused" in outcome) {
      const reason = outcome.paused === "signin" ? "sign in" : "confirm";
      stamp({ id: step.id, status: "paused", reason });
      noteTrajectory(trajectory, step, undefined, true, clock() - started);
      const pausedKind = outcome.paused === "signin" || outcome.paused === "confirm" ? outcome.paused : undefined;
      return finish({ runId, status: "paused", steps, pausedStepId: step.id, pausedKind, ask: outcome.ask });
    }
    let failure = outcome.failure;
    if (failure.reason.includes(NEEDS_SECRET_VALUE)) {
      stamp({ id: step.id, status: "failed", reason: NEEDS_SECRET_VALUE, phase: failure.phase });
      return finish({ runId, status: "failed", steps, failure: { ...failure, reason: NEEDS_SECRET_VALUE } });
    }
    const missed = await classifyLive(driver, workflow, step);
    noteClass(missed, true);
    if (missed.class === "bot_wall" || missed.class === "login_wall") {
      const held = await holdWall(missed);
      if (held.result) return held.result;
      if (held.next) continue;
      if (held.outcome && "failure" in held.outcome) {
        outcome = held.outcome;
        failure = held.outcome.failure;
      }
    } else if (!stepOptional(step) && missed.class === "clutter") {
      const nodesNow = (await driver.tree().catch(() => undefined))?.nodes || [];
      const coveredNow = findRecovery(nodesNow);
      const budgetLeft = recovery.used < RECOVERY_LIMIT;
      if (!clutterPrimed && budgetLeft && !coveredNow) {
        if (await dismissNamed(driver, missed)) {
          recovery.used += 1;
          repairs.push({ stepId: step.id, repair: "overlay", detail: missed.reason });
          const retried = await runStep(workflow, step, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, extra, tables);
          repairs.push(...retried.repairs);
          if (retried.ok) {
            stamp({ id: step.id, status: "passed", reason: "recovered: clutter" });
            noteTrajectory(trajectory, step, retried.acted, true, clock() - started);
            continue;
          }
          if ("paused" in retried) {
            const reason = retried.paused === "signin" ? "sign in" : "confirm";
            stamp({ id: step.id, status: "paused", reason });
            return finish({ runId, status: "paused", steps, pausedStepId: step.id, pausedKind: retried.paused === "signin" || retried.paused === "confirm" ? retried.paused : undefined, ask: retried.ask });
          }
          const again = await classifyLive(driver, workflow, step);
          noteClass(again, true);
          if (again.class === "bot_wall" || again.class === "login_wall") {
            const held = await holdWall(again);
            if (held.result) return held.result;
            if (held.next) continue;
          }
          if (again.class !== "changed") {
            stamp({ id: step.id, status: "failed", reason: again.reason, phase: retried.failure.phase });
            noteTrajectory(trajectory, step, retried.acted, false, clock() - started);
            return finish({ runId, status: "failed", steps, failure: { ...retried.failure, reason: again.reason } });
          }
          outcome = retried;
          failure = retried.failure;
        } else {
          stamp({ id: step.id, status: "failed", reason: missed.reason, phase: failure.phase });
          noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
          return finish({ runId, status: "failed", steps, failure: { ...failure, reason: missed.reason } });
        }
      } else if (!coveredNow) {
        stamp({ id: step.id, status: "failed", reason: missed.reason, phase: failure.phase });
        noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
        return finish({ runId, status: "failed", steps, failure: { ...failure, reason: missed.reason } });
      }
    }
    const liveNodes = (await driver.tree().catch(() => undefined))?.nodes || [];
    const stop = hardFailure({
      phase: failure.phase,
      reason: failure.reason,
      nodes: liveNodes,
      network: driver.trace?.().network,
    });
    if (stop && failure.phase !== "auth") {
      stamp({ id: step.id, status: "failed", reason: stop, phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure: { ...failure, reason: stop } });
    }
    const covered = findRecovery(liveNodes);
    if (covered && recovery.used >= RECOVERY_LIMIT) {
      stamp({ id: step.id, status: "failed", reason: covered.kind, phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure: { ...failure, reason: covered.kind } });
    }
    if (failure.phase === "auth") {
      noteAuth(trail, step.id, false);
      precondition = { phase: "auth", reason: failure.reason, recovered: false, stepId: step.id };
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    const triage = classifyFailure(failure);
    const review = mode === "auto" && opts.reviewSteps?.has(step.id) === true;
    const skip = mode === "never"
      ? "never"
      : triage !== "change"
        ? triage
        : review
          ? "review"
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
    const proposal = await heal.propose(failure, step, { workflow, args, secrets });
    const prompt = proposal?.prompt || "";
    const record: HealRecord = {
      id: `heal-${heals.length + 1}`,
      ts: now(),
      workflowId: workflow.id,
      runId,
      mode: mode === "approve" ? "approve" : "auto",
      failedStep: step,
      intent: failure.intent,
      snapshot: failure.snapshot,
      prompt,
      model: proposal?.model
        ? {
          provider: proposal.model.provider,
          name: proposal.model.name,
          version: proposal.model.version || proposal.model.name,
        }
        : undefined,
      rawResponse: proposal?.rawResponse,
      proposedPatch: proposal?.patch,
      beforeShot: failure.beforeShot || beforeShot,
      identity: failure.identity,
    };
    if (!proposal?.patch) {
      heals.push(record);
      stamp({ id: step.id, status: "failed", reason: phaseReason(failure), phase: failure.phase });
      noteTrajectory(trajectory, step, outcome.acted, false, clock() - started);
      return finish({ runId, status: "failed", steps, failure });
    }
    await driver.notify({
      title: mode === "auto" ? "Bao healed a step" : "Bao needs approval",
      body: `${workflow.name}: ${stepTitle(step)}`,
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
    const retried = await runStep(workflow, patched, args, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, extra, tables);
    repairs.push(...retried.repairs);
    record.executed = { action: patched.action, identity: stepQuery(patched) };
    record.postconditionPassed = retried.ok;
    heals.push(record);
    if (!retried.ok && "paused" in retried) {
      const reason = retried.paused === "signin" ? "sign in" : "confirm";
      stamp({ id: step.id, status: "paused", reason });
      noteTrajectory(trajectory, patched, undefined, true, clock() - started);
      const pausedKind = retried.paused === "signin" || retried.paused === "confirm" ? retried.paused : undefined;
      return finish({ runId, status: "paused", steps, pausedStepId: step.id, pausedKind, ask: retried.ask });
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
    const passed = retried.note || retried.detail || (retried.recovered ? `recovered: ${retried.recovered}` : "");
    stamp({ id: step.id, status: "passed", ...(passed ? { reason: passed } : {}) });
    noteTrajectory(trajectory, patched, retried.acted, true, clock() - started);
    } finally {
      const quiet = gate.shotsPaused;
      const after = quiet ? { error: "Pictures stay off while you have the page." } : await writeStepShot(driver, opts.shotDir, pictured, "after");
      const snapshot = !driver.captureStep ? undefined : await driver.captureStep().catch(() => undefined);
      if (steps[i]) steps[i] = { ...steps[i], beforeShot, afterShot: after.ref, beforeShotError: before.error, afterShotError: after.error, ...(snapshot ? { snapshot } : {}) };
    }
  }
  const executed = steps.filter((step) => step.status === "passed" && step.reason !== "other branch" && step.reason !== "not re-run");
  // A step skipped as already done showed its result through its guard, so its own expect is not the final check.
  const ran = executed.filter((step) => step.reason !== "already done");
  const lastId = ran[ran.length - 1]?.id;
  const last = workflow.steps.find((step) => step.id === lastId && step.action !== "note");
  let finalCheckFailed = false;
  if (last && stepCheck(last)) {
    finalCheckFailed = !(await expectationsHold(last, await driver.tree(), args));
  }
  if (!runPassed(steps, finalCheckFailed)) {
    const reason = executed.length === 0 ? "no steps executed" : "final check failed";
    const snapshot = await driver.snapshot().catch(() => ({}));
    return finish({
      runId,
      status: "failed",
      steps,
      failure: {
        stepId: last?.id || workflow.id,
        index: last?.index ?? 0,
        intent: last ? stepTitle(last) : workflow.name,
        phase: "expect",
        reason,
        snapshot,
      },
    });
  }
  return finish({ runId, status: "passed", steps });
  };
  // Per-step finally fills snapshots and shot refs before this copy detaches the result.
  try {
    return structuredClone(await execute());
  } finally {
    endFilesRun(runId);
  }
}

/** A run with nothing executed, or a failed final check, is not a pass. */
export function runPassed(
  steps: { status: string; reason?: string }[],
  finalCheckFailed = false,
): boolean {
  if (finalCheckFailed) return false;
  return steps.some((step) => step.status === "passed" && step.reason !== "other branch" && step.reason !== "not re-run");
}

type StepOutcome =
  | { ok: true; repairs: RepairLog[]; acted?: Identity; authRecovered?: boolean; recovered?: string; note?: string; detail?: string; skipped?: true }
  | { ok: false; failure: StepFailure; repairs: RepairLog[]; acted?: Identity }
  | { ok: false; paused: "confirm" | "signin"; repairs: RepairLog[]; ask?: HumanAsk };

interface RecoveryBudget {
  used: number;
}

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
  recovery: RecoveryBudget,
  extra?: ReadBack,
  tables?: Map<string, Record<string, string>[]>,
  appending = false,
): Promise<StepOutcome> {
  const repairs: RepairLog[] = [];
  if (!(step.action === "handoff" && step.reason === "sign-in") && stepNeedsSecretValue(step, workflow, args)) {
    return { ok: false, repairs, failure: await fail(driver, step, "action", NEEDS_SECRET_VALUE, undefined, secrets) };
  }
  if (step.action === "note") return { ok: true, repairs };
  if (step.action === "extract" || step.action === "for_each") {
    const bag = tables ?? new Map();
    const data = await performDataStep(step, args, bag, driver, appending, async (nested, nestedArgs) => {
      const inner = await runStep(
        workflow, nested, nestedArgs, driver, secrets, locatorHits, locatorMode, receiptLog, runId, gate, recovery, undefined, bag, true,
      );
      if (inner.ok) return { ok: true };
      if ("failure" in inner) return { ok: false, reason: inner.failure.reason };
      return { ok: false, reason: "paused" };
    });
    if (!data.ok) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", data.reason, undefined, secrets) };
    }
    return { ok: true, repairs, detail: data.detail };
  }
  if (step.action === "navigate") {
    const url = (step.action === "navigate" ? step.url : undefined) || workflow.startUrl;
    try {
      if (url && driver.goto) await driver.goto(url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, repairs, failure: await fail(driver, step, "action", reason, undefined, secrets) };
    }
    const held = await readExpect(step, args, driver, repairs, gate, recovery);
    if (!held.ok) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs, recovered: held.recovered };
  }
  const outcome = await runStepAction(step, args, driver, secrets, repairs, locatorHits, locatorMode, gate, recovery);
  if (!outcome.ok || outcome.skipped) return outcome;
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
  recovery: RecoveryBudget,
): Promise<StepOutcome> {
  if (step.action === "handoff") return runHandoff(gate.workflow, step, args, driver, secrets, gate);
  const seen = await driver.tree();
  const miss = authPreconditionMiss(gate.workflow.precondition, seen.url);
  if (miss) return { ok: false, repairs, failure: await fail(driver, step, "auth", miss, undefined, secrets) };
  if (step.action === "download" || step.action === "open" || stepDate(step)) {
    return runFilesDatesStep(step, args, driver, secrets, repairs, gate, recovery);
  }
  if (step.action === "verify") {
    const held = await readExpect(step, args, driver, repairs, gate, recovery);
    if (!held.ok) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    return { ok: true, repairs, recovered: held.recovered };
  }
  if (step.action === "key" && !stepQuery(step)) {
    try {
      await driver.key(stepKey(step) || "Enter");
    } catch (err) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    const held = await readExpect(step, args, driver, repairs, gate, recovery);
    if (!held.ok) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs, recovered: held.recovered };
  }
  if (step.action === "digits") {
    const text = String(args[stepInputName(step) || ""] ?? subst(stepValueTemplate(step) || "", args));
    try {
      await driver.digits(stepQuery(step)?.app, stepQuery(step)?.role || "button", text);
    } catch (err) {
      return { ok: false, repairs, failure: await fail(driver, step, "action", err instanceof Error ? err.message : String(err), undefined, secrets) };
    }
    const held = await readExpect(step, args, driver, repairs, gate, recovery);
    if (!held.ok) {
      return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    }
    return { ok: true, repairs, acted: stepQuery(step), recovered: held.recovered };
  }
  const found = await findTarget(step, args, driver, repairs, locatorHits, locatorMode, gate, recovery);
  if (found.optionalAbsent) return { ok: true, repairs, skipped: true, note: "optional dismiss absent" };
  if (!found.hit.ok || found.hit.index == null) {
    const failure = await fail(driver, step, "find", found.hit.reason || "lookup miss", found.hit.brokenAttr, secrets);
    const missed = stepQuery(step);
    if (missed) failure.identity = identityView(missed, found.nodes, found.hit);
    return { ok: false, repairs, failure: withLocators(failure, found.tried) };
  }
  const node = found.nodes[found.hit.index];
  if (!node) {
    const failure = await fail(driver, step, "find", "lookup miss", found.hit.brokenAttr, secrets);
    return { ok: false, repairs, failure: withLocators(failure, found.tried) };
  }
  try {
    await act(step, node, args, driver, gate);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failure = await fail(driver, step, "action", reason, found.hit.brokenAttr, secrets);
    return { ok: false, repairs, acted: node, failure: withLocators(failure, found.tried) };
  }
  const held = await readExpect(step, args, driver, repairs, gate, recovery);
  if (!held.ok) {
    if (held.cancelled || driver.shouldStop?.()) {
      return {
        ok: false,
        repairs,
        acted: node,
        failure: {
          stepId: step.id,
          index: step.index,
          intent: step.caption.text || stepTitle(step),
          phase: "action",
          reason: "cancelled",
          snapshot: {},
        },
      };
    }
    const failure = await fail(driver, step, "expect", expectReason(step), undefined, secrets);
    return { ok: false, repairs, acted: node, failure: withLocators(failure, found.tried) };
  }
  return { ok: true, repairs, acted: node, recovered: found.recovered || held.recovered };
}

export interface PageGuard {
  key: string;
  open: boolean;
}

/**
 * The page text a step's `when` names. `shown` true runs the step only while the page shows it,
 * false only while it does not. With `absent`, `anyCount` lets each number in the text match any number.
 * Steps with the same key are decided once, on the first of them.
 */
export function pageWhen(step: Pick<WorkflowStep, "when">): { key: string; text: string; shown: boolean; anyCount: boolean } | undefined {
  const present = step.when?.present?.trim();
  if (present) return { key: `present:${present}`, text: present, shown: true, anyCount: false };
  const absent = step.when?.absent?.trim();
  const anyCount = step.when?.anyCount === true;
  if (absent) return { key: `absent${anyCount ? "#" : ""}:${absent}`, text: absent, shown: false, anyCount };
  return undefined;
}

/**
 * Visible text, or a control's name, that marks an interstitial or a step's result as on the page.
 * With `anyCount`, each number in `present` matches any number, so "1 in cart" matches "3 in cart".
 */
export function pageShows(tree: LiveTree, present: string, anyCount = false): boolean {
  const pattern = anyCount
    ? new RegExp(present.split(/\d+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\d+"))
    : undefined;
  const shows = (bit: string | undefined): boolean => !!bit && (pattern ? pattern.test(bit) : bit.includes(present));
  if (tree.texts.some(shows)) return true;
  return tree.nodes.some((node) => [node.text, node.name, node.label].some(shows));
}

function withLocators(failure: StepFailure, tried: TriedLocator[]): StepFailure {
  return tried.length ? { ...failure, locators: tried } : failure;
}

async function dismissCover(
  driver: Driver,
  gate: ApplyGate,
  step: WorkflowStep,
  repairs: RepairLog[],
  budget: RecoveryBudget,
): Promise<string | undefined> {
  if (stepOptional(step) || budget.used >= RECOVERY_LIMIT) return undefined;
  const tree = await driver.tree();
  const stop = hardFailure({ nodes: tree.nodes, network: driver.trace?.().network });
  if (stop || hasCaptcha(tree.nodes)) return undefined;
  const block = findRecovery(tree.nodes);
  if (!block) return undefined;
  // The registration form is a dialog that contains the field. Closing it
  // removes the step's control. An overlay whose target is outside the dialog
  // is still dismissed.
  if (block.kind === "modal" && targetInsideDialog(step, tree)) return undefined;
  if (block.kind === "spinner") {
    if (!await waitSpinner(driver, step)) return undefined;
  } else {
    if (!block.node) return undefined;
    if (!await recordedClick(driver, gate, step.id, block.node)) return undefined;
  }
  repairs.push({ stepId: step.id, repair: "overlay", detail: block.kind });
  budget.used += 1;
  return block.kind;
}

/** A sized box can be clicked even when the node is aria-hidden. A 0×0 box cannot. */
function canClick(index: number, boxes?: LiveTree["boxes"], hidden?: boolean[]): boolean {
  const box = boxes?.[index];
  if (box && box.w > 2 && box.h > 2) return true;
  return !isCollapsedBox(index, boxes, hidden);
}

/** The step's control is visible inside the dialog, so the dialog is the form. */
function targetInsideDialog(step: WorkflowStep, tree: LiveTree): boolean {
  const flags = tree.inDialog;
  const want = stepQuery(step);
  if (!flags || !want) return false;
  const index = tree.nodes.findIndex((node) => sameDialogControl(want, node));
  if (index < 0 || !flags[index]) return false;
  if (tree.hidden?.[index]) return false;
  const box = tree.boxes?.[index];
  if (box && (box.w < 2 || box.h < 2)) return false;
  return true;
}

function sameDialogControl(want: Identity, node: Identity): boolean {
  return !!((want.id && node.id === want.id)
    || (want.testId && node.testId === want.testId)
    || (want.cssPath && node.cssPath === want.cssPath));
}

async function waitSpinner(driver: Driver, step: WorkflowStep): Promise<boolean> {
  const timeout = Math.min(step.timeoutMs ?? 1000, 2000);
  if (timeout <= 0) return false;
  const start = Date.now();
  let spins = 0;
  while (Date.now() - start < timeout && spins < 40) {
    spins += 1;
    await (driver.sleep ? driver.sleep(50) : sleep(50));
    const block = findRecovery((await driver.tree()).nodes);
    if (!block || block.kind !== "spinner") return true;
  }
  return false;
}

async function findTarget(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  repairs: RepairLog[],
  locatorHits: LocatorHit[],
  locatorMode: LocatorMode,
  gate: ApplyGate,
  recovery: RecoveryBudget,
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup>; tried: TriedLocator[]; recovered?: string; optionalAbsent?: true }> {
  if (step.action === "click" && step.optional === "dismiss") {
    const deadline = Date.now() + 2000;
    const want = stepQuery(step);
    const scoped = want?.path.some((seg) => seg.name || ["dialog", "alertdialog"].includes(normRole(seg.role)));
    while (true) {
      const tree = await driver.tree();
      const scopedCandidates = tree.nodes.flatMap((node, index) => {
        if (!want || !popupDismissName(node) || popupDismissName(node).toLowerCase() !== popupDismissName(want).toLowerCase() || !canClick(index, tree.boxes, tree.hidden)) return [];
        if (want.path.length && !pathEq(want.path, node.path)) return [];
        return [index];
      });
      const exact = scopedCandidates.filter((index) => sameRecordedControl(want!, tree.nodes[index]!));
      const candidates = exact.length || want?.testId || (want?.id && !unstableId(want.id)) || (want?.nameAttr && !unstableId(want.nameAttr)) || !scoped ? exact : scopedCandidates;
      if (candidates.length) return { nodes: tree.nodes, hit: candidates.length === 1 ? { ok: true, index: candidates[0]!, ranked: [] } : { ok: false, reason: "tie", ranked: [] }, tried: [] };
      if (Date.now() >= deadline) return { nodes: tree.nodes, hit: { ok: false, reason: "no-candidates", ranked: [] }, tried: [], optionalAbsent: true };
      await (driver.sleep ? driver.sleep(50) : sleep(50));
    }
  }
  const recovered = await dismissCover(driver, gate, step, repairs, recovery);
  let tree = await driver.tree();
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
  if (located.hit.ok && located.hit.index != null && canClick(located.hit.index, tree.boxes, tree.hidden)) {
    if (located.via) locatorHits.push(located.via);
    return { ...located, recovered };
  }
  const labeled = labelCandidate(step, tree.nodes, tree.boxes);
  if (labeled) {
    repairs.push({ stepId: step.id, repair: "label", detail: labeled.detail });
    return { nodes: tree.nodes, hit: { ok: true, index: labeled.index, score: 0, margin: 0, ranked: [] }, tried: located.tried, recovered };
  }
  const anchored = anchorCandidate(step, tree.nodes, tree.boxes);
  if (anchored) {
    repairs.push({ stepId: step.id, repair: "anchor", detail: anchored.detail });
    return { nodes: tree.nodes, hit: { ok: true, index: anchored.index, score: 0, margin: 0, ranked: [] }, tried: located.tried, recovered };
  }
  if (driver.waitIdle) await driver.waitIdle(Math.min(step.timeoutMs || 1000, 2000));
  const waited = await poll(step, args, driver, locatorMode);
  if (waited.hit.ok && waited.hit.index != null && canClick(waited.hit.index, waited.boxes, waited.hidden)) {
    repairs.push({ stepId: step.id, repair: "wait", detail: `waited for ${step.timeoutMs}ms` });
    if (waited.via) locatorHits.push(waited.via);
    return { ...waited, recovered };
  }
  if (waited.hit.ok) {
    const hit = { ok: false as const, reason: "below-threshold" as const, brokenAttr: "box", ranked: [] as ReturnType<typeof lookup>["ranked"] };
    await captureFindMiss(step, driver, waited.nodes, hit, waited.tried);
    return { nodes: waited.nodes, hit, tried: waited.tried, recovered };
  }
  await captureFindMiss(step, driver, waited.nodes, waited.hit, waited.tried);
  return { ...waited, recovered };
}

async function captureFindMiss(
  step: WorkflowStep,
  driver: Driver,
  nodes: Identity[],
  hit: ReturnType<typeof lookup>,
  tried: TriedLocator[],
): Promise<void> {
  const dir = findDebugDir();
  if (!dir || hit.ok) return;
  const missed = stepQuery(step);
  const ranked = missed ? lookup(missed, nodes).ranked.slice(0, 5) : [];
  const candidates = ranked.map((score) => {
    const node = nodes[score.index];
    return {
      index: score.index,
      score: score.score,
      role: node?.role,
      name: node?.name,
      label: node?.label,
      text: node?.text,
      id: node?.id,
      nameAttr: node?.nameAttr,
      testId: node?.testId,
      parts: score.parts,
    };
  });
  const probed = driver.probe ? await driver.probe(queriesForLocators(stepLocators(step))).catch(() => undefined) : undefined;
  const snap = await driver.snapshot().catch(() => undefined);
  const png = snap?.screenshot ? Buffer.from(snap.screenshot, "base64") : undefined;
  writeFindDebug(dir, step.id, {
    stepId: step.id,
    action: step.action,
    label: stepTitle(step),
    url: probed?.url,
    reason: hit.reason,
    brokenAttr: hit.brokenAttr,
    locators: tried,
    direct: probed?.hits || [],
    candidates,
    identity: stepQuery(step),
    recordedLocators: stepLocators(step),
  }, png);
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
  if (!await recordedClick(driver, gate, step.id, node)) return false;
  // The opened field replaces the collapsed one. Wait until that swap settles
  // before the next dump, or the handle is on a node fill cannot use.
  await (driver.sleep ? driver.sleep(300) : sleep(300));
  repairs.push({ stepId: step.id, repair: "reveal", detail: pick.detail });
  return true;
}

async function readExpect(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  repairs: RepairLog[],
  gate: ApplyGate,
  recovery: RecoveryBudget,
): Promise<{ ok: boolean; recovered?: string; cancelled?: boolean }> {
  const check = stepCheck(step);
  if (!check) return { ok: true };
  if (await expectationsHold(step, await driver.tree(), args)) return { ok: true };
  const timeout = check.timeoutMs || 0;
  const start = Date.now();
  if (driver.waitIdle) await driver.waitIdle(Math.min(timeout || step.timeoutMs || 1000, 2000));
  while (Date.now() - start < timeout) {
    if (driver.shouldStop?.()) return { ok: false, cancelled: true };
    await (driver.sleep ? driver.sleep(100) : sleep(100));
    if (driver.shouldStop?.()) return { ok: false, cancelled: true };
    if (await expectationsHold(step, await driver.tree(), args)) {
      repairs.push({ stepId: step.id, repair: "wait", detail: "expect became true" });
      return { ok: true };
    }
  }
  if (timeout === 0 && await expectationsHold(step, await driver.tree(), args)) return { ok: true };
  const recovered = await dismissCover(driver, gate, step, repairs, recovery);
  if (recovered && await expectationsHold(step, await driver.tree(), args)) return { ok: true, recovered };
  return { ok: false };
}

async function expectationsHold(step: WorkflowStep, tree: LiveTree, args: ReplayArgs): Promise<boolean> {
  if (step.action === "click" && step.optional === "dismiss" && stepCheck(step)?.kind === "settled") return true;
  const check = stepCheck(step);
  if (!check) return true;
  return checkHolds(check, tree, args);
}

async function runHandoff(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  gate: ApplyGate,
): Promise<StepOutcome> {
  if (step.action !== "handoff") return { ok: true, repairs: [] };
  if (step.reason === "sign-in") return runLogin(workflow, step, args, driver, secrets, gate);
  const check = step.check;
  const real = !!check && check.kind !== "settled";
  const seen = await driver.tree().catch(() => undefined);
  if (step.reason === "code" && real && seen && checkHolds(check, seen, args)) return finishHandoff(driver, gate, step.id);
  if (gate.humanReady === "confirmed" || (gate.humanReady === true && !real)) return finishHandoff(driver, gate, step.id);
  if (gate.humanReady && real && seen && checkHolds(check, seen, args)) return finishHandoff(driver, gate, step.id);
  const ask = personAsk(gate, step, "confirm");
  if (gate.humanReady || gate.yieldHuman) {
    if (!gate.humanReady) await showOwnerAsk(driver, step, ask);
    beginHandoff(driver, gate, step.id);
    return { ok: false, paused: "confirm", repairs: [], ask };
  }
  beginHandoff(driver, gate, step.id);
  gate.onPause?.(ask);
  await showOwnerAsk(driver, step, ask);
  const ok = await waitForOwner(step, args, driver, gate);
  if (ok) return finishHandoff(driver, gate, step.id);
  endHandoff(driver, gate, step.id);
  await driver.clearConfirm?.(gate.runId || "");
  return { ok: false, repairs: [], failure: await fail(driver, step, "expect", "waiting for you", undefined, secrets) };
}

async function waitForOwner(step: WorkflowStep, args: ReplayArgs, driver: Driver, gate: ApplyGate): Promise<boolean> {
  const timeout = actWaitMs(step.timeoutMs, gate.actTimeoutMs);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (driver.loginContinued?.() || driver.ownerContinued?.()) return true;
    if (driver.shouldStop?.()) return false;
    const tree = await driver.tree().catch(() => undefined);
    if (tree && step.action === "handoff" && step.check && step.check.kind !== "settled" && checkHolds(step.check, tree, args)) return true;
    await (driver.sleep ? driver.sleep(100) : sleep(100));
  }
  if (driver.loginContinued?.() || driver.ownerContinued?.()) return true;
  const tree = await driver.tree().catch(() => undefined);
  return !!tree && step.action === "handoff" && !!step.check && step.check.kind !== "settled" && checkHolds(step.check, tree, args);
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
  const human = !secretArg(workflow, args, stepInputName(step))
    || Object.values(loginValues(workflow, args, stepInputName(step))).some(hasStrippedSecret);
  if (loginSatisfied(workflow, step, seen, args) && !miss) {
    if (gate.humanReady) endHandoff(driver, gate, step.id);
    return { ok: true, repairs: [] };
  }
  if (human && (gate.humanReady || gate.yieldHuman)) {
    const ask = personAsk(gate, step, "login");
    if (!gate.humanReady) {
      await driver.showAsk?.(ask);
      await driver.showLoginWait?.(stepTitle(step) || "Sign in on the site window");
    }
    beginHandoff(driver, gate, step.id);
    return { ok: false, paused: "signin", repairs: [], ask };
  }
  const filled = await settleLogin(workflow, step, args, driver, gate, human);
  const startedLoggedOut = !!miss || (workflow.precondition?.phase === "auth" && !loginSatisfied(workflow, step, seen, args));
  if (filled) return { ok: true, repairs: [], authRecovered: startedLoggedOut };
  const phase = workflow.precondition?.phase === "auth" || miss ? "auth" : "expect";
  const reason = phase === "auth" ? (miss || "redirected to login") : "waiting for you to log in";
  return { ok: false, repairs: [], failure: await fail(driver, step, phase, reason, undefined, secrets) };
}

function loginSatisfied(workflow: WorkflowV2, step: WorkflowStep, tree: LiveTree, args: ReplayArgs): boolean {
  if (workflow.precondition?.phase === "auth") return pathMatches(tree.url, workflow.precondition.match);
  if (step.action !== "handoff" || step.reason !== "sign-in" || !step.check || step.check.kind === "settled") return false;
  return checkHolds(step.check, tree, args);
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
  const values = loginValues(workflow, args, stepInputName(step));
  if (!human && values.password) {
    try {
      await fillSecretLogin(values, driver, gate, step.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "login failed";
      if (message === "could not fill the secret field" || message === "password field missing") return false;
      return false;
    }
  } else {
    const ask = personAsk(gate, step, "login");
    beginHandoff(driver, gate, step.id);
    gate.onPause?.(ask);
    await driver.showAsk?.(ask);
    await driver.showLoginWait?.(stepTitle(step) || "Sign in on the site window");
  }
  let finished = false;
  try {
    const ok = await waitForLogin(workflow, step, args, driver, gate);
    if (human) endHandoff(driver, gate, step.id);
    finished = true;
    return ok;
  } finally {
    if (finished) await driver.clearLoginWait?.(gate.runId || "");
  }
}

function personAsk(gate: ApplyGate, step: WorkflowStep, kind: "login" | "confirm"): HumanAsk {
  const workflow = gate.workflow;
  const code = step.action === "handoff" && step.reason === "code";
  const ask = makeAsk({
    kind,
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepId: step.id,
    stepIndex: step.index + 1,
    stepCount: workflow.steps.length,
    label: stepTitle(step),
    button: kind === "confirm" && !code ? confirmButton({ label: stepTitle(step), identity: stepQuery(step) }) : undefined,
    site: siteHost(workflow.startUrl),
    timeoutMs: actWaitMs(step.timeoutMs, gate.actTimeoutMs),
    runId: gate.runId,
  });
  if (code) {
    ask.instruction = `Enter the code on ${ask.site} in the Bao window`;
    ask.button = undefined;
  }
  return ask;
}

async function showOwnerAsk(driver: Driver, step: WorkflowStep, ask: HumanAsk): Promise<void> {
  await driver.showAsk?.(ask);
  if (step.action === "handoff" && step.reason === "owner-press") await driver.showConfirm?.(stepTitle(step));
}

function finishHandoff(driver: Driver, gate: ApplyGate, stepId: string): StepOutcome {
  endHandoff(driver, gate, stepId);
  if (!gate.trail.some((event) => event.kind === "human-confirm" && event.stepId === stepId)) {
    gate.trail.push({ kind: "human-confirm", stepId, ts: Date.now(), text: "Owner confirmed" });
  }
  void driver.clearConfirm?.(gate.runId || "");
  return { ok: true, repairs: [] };
}

function beginHandoff(driver: Driver, gate: ApplyGate, stepId: string): void {
  const started = gate.trail.some((event) => event.kind === "handoff" && event.phase === "start" && event.stepId === stepId);
  const ended = gate.trail.some((event) => event.kind === "handoff" && event.phase === "end" && event.stepId === stepId);
  gate.shotsPaused = true;
  if (started && !ended) return;
  const ts = Date.now();
  gate.trail.push({
    kind: "handoff",
    stepId,
    phase: "start",
    ts,
    text: `Handoff started ${formatClock(ts)}`,
  });
  driver.pauseCapture?.();
}

function endHandoff(driver: Driver, gate: ApplyGate, stepId: string): void {
  const ended = gate.trail.some((event) => event.kind === "handoff" && event.phase === "end" && event.stepId === stepId);
  if (!ended) {
    const ts = Date.now();
    gate.trail.push({
      kind: "handoff",
      stepId,
      phase: "end",
      ts,
      text: `Handoff ended ${formatClock(ts)}`,
    });
  }
  gate.shotsPaused = false;
  driver.resumeCapture?.();
}

async function recoverAuth(
  workflow: WorkflowV2,
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  _secrets: string[],
  gate: ApplyGate,
): Promise<boolean> {
  const human = !secretArg(workflow, args, stepInputName(step))
    || Object.values(loginValues(workflow, args, stepInputName(step))).some(hasStrippedSecret);
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

function loginValues(workflow: WorkflowV2, args: ReplayArgs, preferred?: string) {
  return {
    username: textArg(args, "username") || workflow.inputs.find((input) => input.name === "username")?.default || "",
    password: secretArg(workflow, args, preferred),
    verifyCode: textArg(args, "code"),
  };
}

async function fillSecretLogin(
  { username, password, verifyCode }: ReturnType<typeof loginValues>,
  driver: Driver,
  gate: ApplyGate,
  stepId: string,
): Promise<void> {
  let tree = await driver.tree();
  const user = tree.nodes.find((node) => node.id === "username" || node.nameAttr === "username");
  if (user && username) await driver.fill(user, username, false);
  const cont = tree.nodes.find((node) => node.id === "continue" || node.testId === "login-continue");
  if (cont && !await recordedClick(driver, gate, stepId, cont)) return;
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
  if (sign && !await recordedClick(driver, gate, stepId, sign)) return;
  await (driver.sleep ? driver.sleep(50) : sleep(50));
  tree = await driver.tree();
  const code = tree.nodes.find((node) => node.id === "code" || node.testId === "verify-code");
  if (code && verifyCode) {
    await driver.fill(code, verifyCode, false);
    const button = tree.nodes.find((node) => node.id === "verify" || node.testId === "verify-submit");
    if (button && !await recordedClick(driver, gate, stepId, button)) return;
  }
}

function recordedSteps(workflow: WorkflowV2): WorkflowStep[] {
  return workflow.steps.flatMap((step) => [step, ...(stepForEach(step)?.steps || [])]);
}

async function recordedClick(driver: Driver, gate: ApplyGate, stepId: string, node: Identity, requested = false): Promise<boolean> {
  const steps = recordedSteps(gate.workflow);
  const index = steps.findIndex((step) => step.id === stepId);
  const reserved = steps.slice(index + 1).some((step) => {
    if (step.action !== "handoff" || step.reason !== "owner-press") return false;
    const identity = stepQuery(step);
    const locators = stepLocators(step);
    return (identity && (sameRecordedControl(identity, node) || lookup(identity, [node]).ok))
      || !!locators?.some((locator) => matchLocator(locator, [node]));
  });
  if (!requested && reserved) return false;
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
): Promise<{ nodes: Identity[]; hit: ReturnType<typeof lookup>; via?: LocatorHit; tried: TriedLocator[]; boxes?: LiveTree["boxes"]; hidden?: boolean[] }> {
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
): { nodes: Identity[]; hit: ReturnType<typeof lookup>; via?: LocatorHit; tried: TriedLocator[] } {
  const selection = step.action === "click" ? step.selection : undefined;
  let nodes = tree.nodes;
  if (selection) {
    const want = String(args[selection.input] ?? "");
    const picked = nodes.filter((node) => {
      const got = node[selection.by];
      return typeof got === "string" && got.replace(/\s+/g, " ").trim() === want;
    });
    const wantRole = stepQuery(step)?.role;
    const roleHits = wantRole ? picked.filter((node) => rolesCompatible(wantRole, node.role)) : [];
    // The listbox and the option both show the typed word. The option is the choice.
    const chosen = roleHits.length === 1 ? roleHits[0] : picked.length === 1 ? picked[0] : undefined;
    if (chosen && (!wantRole || rolesCompatible(wantRole, chosen.role))) {
      const index = nodes.indexOf(chosen);
      const label = chosen.name || chosen.text || chosen.role || "selection";
      return {
        nodes,
        hit: { ok: true, index, ranked: [] },
        via: { stepId: step.id, kind: "role", detail: `selection ${selection.input}` },
        tried: [{ kind: "role", label, score: 100 }],
      };
    }
    nodes = picked;
  }
  const identity = stepQuery(step);
  const list = locatorList(step, locatorMode);
  if (list) {
    const tried = list.map((locator) => {
      const scored = scoreLocator(locator, nodes, tree.boxes, tree.hidden);
      return { kind: locator.kind, label: scored.label, score: scored.score };
    });
    const perfect = tried
      .map((item, index) => ({ index, score: item.score }))
      .filter((row) => row.score === 100);
    // A glossary button can share the field's visible name and score 100
    // before the id. The recorded id is that field. A durable id that is not
    // on the page yet is a miss, so the run waits instead of typing into the button.
    const recordedId = identity?.id;
    const idAt = recordedId
      ? tried.findIndex((_, index) => list[index]?.kind === "css" && cssNamesId(list[index]?.value || "", recordedId))
      : -1;
    let preferred = -1;
    if (idAt >= 0 && recordedId && durableId(recordedId) && tried[idAt]!.score < 100) {
      // Present id with a real box: the control can be aria-hidden and still be the target.
      // Absent id: wait, instead of using a glossary button with the same words.
      // A revealed field drops the id and keeps the role, so that hit is still the control.
      // A 0×0 id stays a miss here so the reveal click can open it.
      const indexes = locatorIndexes(list[idAt]!, nodes);
      const sized = indexes.find((index) => {
        const box = tree.boxes?.[index];
        return !!box && box.w > 2 && box.h > 2;
      });
      if (sized != null) {
        return {
          nodes,
          hit: { ok: true, index: sized, ranked: [] },
          via: { stepId: step.id, kind: "css", detail: `css ${recordedId}` },
          tried,
        };
      }
      const recordedRole = identity?.role || "";
      const compatible = perfect.find((row) => {
        const found = matchLocator(list[row.index]!, nodes, tree.boxes, tree.hidden);
        const node = found ? nodes[found.index] : undefined;
        return !!node && rolesCompatible(recordedRole, node.role);
      });
      if (indexes.length === 0 && !compatible) {
        return {
          nodes,
          hit: { ok: false, reason: "below-threshold", brokenAttr: "id", ranked: [] },
          tried,
        };
      }
      if (compatible) preferred = compatible.index;
    }
    const idWinner = idAt >= 0 && tried[idAt]!.score === 100 ? idAt : -1;
    const winner = idWinner >= 0 ? idWinner : (preferred >= 0 ? preferred : (perfect[0]?.index ?? -1));
    if (winner >= 0) {
      const found = matchLocator(list[winner]!, nodes, tree.boxes, tree.hidden);
      if (found) {
        return {
          nodes,
          hit: { ok: true, index: found.index, ranked: [] },
          via: { stepId: step.id, kind: list[winner]!.kind, detail: found.detail },
          tried,
        };
      }
    }
    const labeled = matchLabeledControl(list, identity, nodes, tree.boxes, tree.hidden);
    if (labeled) {
      return {
        nodes,
        hit: { ok: true, index: labeled.index, ranked: [] },
        via: { stepId: step.id, kind: labeled.kind, detail: labeled.detail },
        tried,
      };
    }
    if (identity) {
      const hit = lookup(identity, nodes);
      if (hit.ok && hit.index != null && !isCollapsedBox(hit.index, tree.boxes, tree.hidden)) {
        const node = nodes[hit.index];
        const detail = node?.name || node?.label || node?.text || node?.nameAttr || node?.id || "identity";
        return {
          nodes,
          hit,
          via: { stepId: step.id, kind: "identity", detail: `identity ${detail}` },
          tried,
        };
      }
    }
    return {
      nodes,
      hit: { ok: false, reason: "below-threshold", brokenAttr: list[0]?.kind || "locator", ranked: [] },
      tried,
    };
  }
  if (!identity) {
    return { nodes: [], hit: { ok: false, reason: "no-candidates", brokenAttr: "identity", ranked: [] }, tried: [] };
  }
  const hit = lookup(identity, nodes);
  const tried = hit.ranked.slice(0, 5).map((score, index) => {
    const node = nodes[score.index];
    const name = node?.name || node?.text || node?.label || node?.testId || node?.id || `candidate ${index + 1}`;
    const label = node?.role && name ? `${node.role} ${name}` : name;
    return { kind: "identity", label, score: score.score };
  });
  return { nodes, hit, tried };
}

function durableId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && !/\d/.test(id);
}

function cssNamesId(selector: string, id: string): boolean {
  if (!id || !selector.startsWith("#")) return false;
  return selector.slice(1).replace(/\\(.)/g, "$1") === id;
}

function rolesCompatible(recorded: string, live: string): boolean {
  const left = normRole(recorded);
  const right = normRole(live);
  if (left === right) return true;
  const links = new Set(["a", "link"]);
  if (links.has(left) && links.has(right)) return true;
  // Wikipedia's search box is a textbox until suggestions open, then a combobox.
  // A button that only shares the words is still not the field.
  const fields = new Set(["textbox", "input", "combobox", "searchbox"]);
  return fields.has(left) && fields.has(right);
}

function locatorList(step: WorkflowStep, mode: LocatorMode): StepLocator[] | undefined {
  const list = stepLocators(step);
  if (!list || list.length === 0) return undefined;
  return mode === "primary" ? list.slice(0, 1) : list;
}

async function act(step: WorkflowStep, node: Identity, args: ReplayArgs, driver: Driver, gate: ApplyGate): Promise<void> {
  const input = stepInputName(step);
  if (step.action === "type") {
    const text = input ? String(args[input] ?? "") : String(stepValueTemplate(step) ?? "");
    await driver.fill(node, text, step.sensitive === true || stepQuery(step)?.role === "password");
    return;
  }
  if (step.action === "upload") {
    await driver.upload(node, boundFiles(step, args, gate));
    return;
  }
  if (step.action === "drop") {
    await driver.drop(node, boundFiles(step, args, gate));
    return;
  }
  if (step.action === "check") {
    await driver.check(node, !!(step.action === "check" ? step.checked : undefined));
    return;
  }
  if (step.action === "select") {
    const text = input ? String(args[input] ?? "") : String(stepValueTemplate(step) ?? "");
    if (!driver.select) throw new Error("select is not supported");
    await driver.select(node, text);
    return;
  }
  if (step.action === "navigate") {
    const url = stepValueTemplate(step) || "";
    if (!url || !driver.goto) return;
    await driver.goto(url);
    return;
  }
  if (step.action === "key") {
    await driver.focus?.(node);
    await driver.key(stepKey(step) || "Enter");
    return;
  }
  if (input && driver.answerDialog) {
    const answer = String(args[input] ?? "");
    if (answer) driver.answerDialog(answer);
  }
  const original = recordedSteps(gate.workflow).find((recorded) => recorded.id === step.id);
  const recorded = original ? stepQuery(original) : undefined;
  const recordedLocators = original ? stepLocators(original) : undefined;
  const requested = recorded
    ? sameRecordedControl({ ...recorded, cssPath: undefined }, node) || lookup(recorded, [node]).ok
    : !!recordedLocators?.some((locator) => locator.kind !== "anchor"
      && matchLocator(locator, [{ ...node, cssPath: undefined, xpath: undefined }]));
  if (!await recordedClick(driver, gate, step.id, node, requested)) {
    throw new Error("Target belongs to a recorded human confirm step");
  }
}

type CheckView = Check & { identity?: Identity };

export function checkHolds(check: CheckView, tree: LiveTree, args: ReplayArgs): boolean {
  if (check.kind === "settled") return pageSettled(tree);
  if (check.kind === "url") return urlIncludes(tree.url || "", expectedText(check.match || "", args));
  if (check.kind === "text") return tree.texts.some((text) => text.includes(expectedText(check.match || "", args)));
  if (check.kind === "value") {
    const expected = expectedText(check.match || "", args);
    return tree.values.some((item) => item.value === expected || item.value.includes(expected))
      || tree.texts.some((text) => text === expected || text.includes(expected));
  }
  const identity = check.identity;
  const locators = "locators" in check ? check.locators : undefined;
  const indexes = identity && lookup(identity, tree.nodes).ok
    ? [lookup(identity, tree.nodes).index].filter((index): index is number => index != null)
    : locators?.flatMap((locator) => locatorIndexes(locator, tree.nodes)) ?? [];
  const present = indexes.length > 0;
  if (check.kind === "absent") return !present;
  if (check.kind === "element" || check.kind === "state") {
    if (!identity && !locators?.length) return check.kind === "element";
    if (!present) return false;
    if (check.kind !== "state") return true;
    const flag = tree.flags?.[indexes[0]!];
    if (check.state === "checked") return !!flag?.checked;
    if (check.state === "unchecked") return !flag?.checked;
    if (check.state === "disabled") return flag?.enabled === false;
    if (check.state === "enabled") return flag?.enabled !== false;
    return true;
  }
  return false;
}

export function holdsExpect(expect: CheckView, tree: LiveTree, args: ReplayArgs): boolean {
  return checkHolds(expect, tree, args);
}

export function holds(post: CheckView, tree: LiveTree, args: ReplayArgs): boolean {
  return checkHolds(post, tree, args);
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

function boundFiles(step: WorkflowStep, args: ReplayArgs, gate: ApplyGate): FileArg[] {
  const bound = filesFor(gate.runId || "", step, gate.workflow);
  if (bound) return bound;
  return files(args, stepInputName(step));
}

async function runFilesDatesStep(
  step: WorkflowStep,
  args: ReplayArgs,
  driver: Driver,
  secrets: string[],
  repairs: RepairLog[],
  gate: ApplyGate,
  recovery: RecoveryBudget,
): Promise<StepOutcome> {
  const run = filesRun(gate.runId || "");
  if (!run) {
    return { ok: false, repairs, failure: await fail(driver, step, "action", "files run was not started", undefined, secrets) };
  }
  try {
    if (step.action === "download") {
      const spec = stepDownload(step);
      if (!spec) throw new Error("download");
      if (!driver.download) throw new Error("download needs a browser");
      mkdirSync(run.downloadDir, { recursive: true });
      const staging = path.join(run.downloadDir, "incoming");
      mkdirSync(staging, { recursive: true });
      const saved = await driver.download({
        dir: staging,
        filename: "pending",
        timeoutMs: step.timeoutMs || 30_000,
        url: spec.url ? renderTemplate(spec.url, templateScope(run)) : undefined,
        node: spec.url ? undefined : stepQuery(step),
      });
      const filename = downloadFileName(spec.name, templateScope(run, saved.suggestedFilename));
      const dest = placeDownload(saved.path, run.downloadDir, filename);
      const output = fileDigest(dest);
      run.outputs.set(spec.output, output);
      const held = await readExpect(step, args, driver, repairs, gate, recovery);
      if (!held.ok) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
      return { ok: true, repairs, note: `${output.name} ${output.sha256}` };
    }
    if (step.action === "open") {
      const spec = stepOpen(step);
      if (!spec) throw new Error("open");
      if (spec.target === "url") {
        const url = renderTemplate(spec.url || "", templateScope(run));
        if (!driver.goto) throw new Error("open url needs a browser");
        await driver.goto(url);
        const held = await readExpect(step, args, driver, repairs, gate, recovery);
        if (!held.ok) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
        return { ok: true, repairs };
      }
      const file = renderTemplate(spec.file || "", templateScope(run));
      const plan = await openTarget({ target: "file", path: file, app: spec.app }, { exec: run.openExec });
      return { ok: true, repairs, note: plan.needsMacTest };
    }
    const picker = stepDate(step);
    if (!picker) throw new Error("date picker");
    const start = run.dates.get(picker.input);
    if (!start) throw new Error(`date ${picker.input}`);
    const end = picker.endInput ? run.dates.get(picker.endInput) : undefined;
    if (picker.endInput && !end) throw new Error(`date ${picker.endInput}`);
    if (!driver.pickDate) throw new Error("date picker needs a browser");
    await driver.pickDate({ iso: start.iso, endIso: end?.iso, formatted: start.formatted, node: stepQuery(step) });
    const held = await readExpect(step, args, driver, repairs, gate, recovery);
    if (!held.ok) return { ok: false, repairs, failure: await fail(driver, step, "expect", expectReason(step), undefined, secrets) };
    return { ok: true, repairs, acted: stepQuery(step) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, repairs, failure: await fail(driver, step, "action", reason, undefined, secrets) };
  }
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
    target: targetKey(acted || stepQuery(step)),
    postcondition: ok ? post : `missed ${post}`,
    timing: timingBucket(Math.max(0, elapsedMs)),
  });
}

function pageSettled(tree: LiveTree): boolean {
  const url = tree.url || "";
  if (!url || /^chrome-error:/i.test(url) || /chromewebdata/i.test(url) || /^about:neterror/i.test(url)) return false;
  const blob = tree.texts.join("\n");
  if (/this site can.t be reached|dns_probe|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(blob)) return false;
  return true;
}

function urlIncludes(url: string, expected: string): boolean {
  if (!expected) return false;
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep the raw url */ }
  if (decoded.includes(expected)) return true;
  const parts = expected.split(/\s+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return false;
  return new RegExp(parts.join("(?:\\s|\\+|_|%20)"), "i").test(decoded);
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
  const expected = expectedText(read.match, args);
  let actual = "";
  let pass = false;
  const start = Date.now();
  const timeout = read.timeoutMs || 0;
  do {
    try {
      const seen = await readActual(read, args, driver);
      actual = clipRead(seen);
      pass = readMatches(expected, actual);
    } catch (err) {
      actual = err instanceof Error ? err.message : String(err);
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
  if (read.locators?.length) {
    const hit = matchLocator(read.locators[0]!, tree.nodes);
    if (hit) {
      const value = tree.values.find((item) => item.identity === tree.nodes[hit.index]);
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

function clipRead(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

function phaseReason(failure: StepFailure): string {
  return `${failure.phase}: ${failure.reason}`;
}

function expectReason(step: WorkflowStep): string {
  const expect = stepCheck(step);
  if (expect && (expect.kind === "text" || expect.kind === "url")) return expect.match || expect.kind;
  if (expect?.kind === "settled") return expect.kind;
  if (expect?.kind === "state") return expect.state;
  if (stepCheck(step)) return "postcondition";
  return "expect";
}

async function fail(
  driver: Driver,
  step: WorkflowStep,
  phase: ReplayPhase,
  reason: string,
  brokenAttr: string | undefined,
  _secrets: string[],
): Promise<StepFailure> {
  const snapshot = await driver.snapshot();
  return {
    stepId: step.id,
    index: step.index,
    intent: step.caption.text || stepTitle(step),
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

async function classifyLive(driver: Driver, workflow: WorkflowV2, step?: WorkflowStep): Promise<PageClassDecision> {
  const recorded = recordingExpectsLogin(workflow.steps);
  const startedUrl = workflow.startUrl;
  const targetPresent = await targetHere(driver, step);
  if (driver.pageSignals) {
    const signals = await driver.pageSignals().catch(() => undefined);
    if (signals) {
      return classifyPage({
        ...signals,
        startedUrl,
        recordedPassword: recorded.password,
        recordedLogin: recorded.login,
        targetPresent,
      });
    }
  }
  const tree = await driver.tree().catch(() => undefined);
  const texts = [...(tree?.texts || [])];
  const nodes = tree?.nodes || [];
  for (const node of nodes) {
    for (const bit of [node.text, node.name, node.label]) if (bit) texts.push(bit);
  }
  return classifyPage({
    url: tree?.url,
    startedUrl,
    texts,
    nodes,
    hasPassword: nodes.some((node) => node.role === "password" || node.nameAttr === "password" || node.id === "password"),
    recordedPassword: recorded.password,
    recordedLogin: recorded.login,
    targetPresent,
  });
}

/** True when the recorded control is on the page, including an ambiguous match. */
async function targetHere(driver: Driver, step?: WorkflowStep): Promise<boolean | undefined> {
  if (!step || step.action === "note" || step.action === "navigate" || step.action === "verify" || step.action === "wait" || step.action === "finish") {
    return undefined;
  }
  if (step.action === "handoff" && !step.target) return undefined;
  const locators = stepLocators(step);
  const identity = stepQuery(step);
  if (locators?.length && driver.probe) {
    const probed = await driver.probe(queriesForLocators(locators)).catch(() => undefined);
    if (probed) return probed.hits.some((hit) => hit.count > 0);
  }
  const tree = await driver.tree().catch(() => undefined);
  if (!tree) return undefined;
  if (locators?.length) return locators.some((locator) => locatorIndexes(locator, tree.nodes).length > 0);
  if (!identity) return undefined;
  const hit = lookup(identity, tree.nodes);
  return hit.ok || hit.reason === "tie";
}

async function dismissNamed(driver: Driver, decision: PageClassDecision): Promise<boolean> {
  const label = `${decision.dismiss?.text || ""} ${decision.dismiss?.name || ""} ${decision.dismiss?.testId || ""}`;
  if (/captcha|recaptcha|hcaptcha|turnstile|not a robot|verify you are human/i.test(label)) return false;
  const tree = await driver.tree().catch(() => undefined);
  const want = decision.dismiss;
  const node = tree?.nodes.find((item) => {
    if (want?.testId && item.testId === want.testId) return true;
    const text = (item.text || item.name || item.label || "").replace(/\s+/g, " ").trim();
    return !!want?.text && text.toLowerCase() === want.text.toLowerCase();
  });
  if (node) {
    await driver.click(node);
    return true;
  }
  if (driver.dismissClutter) return driver.dismissClutter();
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedShotTarget(step: WorkflowStep): NonNullable<RunResult["steps"][number]["target"]> | undefined {
  const box = step.caption?.targetBox;
  if (!box || box.viewport.width <= 0 || box.viewport.height <= 0) return undefined;
  return { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: box.viewport };
}

async function writeStepShot(driver: Driver, dir: string | undefined, step: WorkflowStep, which: "before" | "after"): Promise<{ ref?: string; error?: string; viewport?: boolean }> {
  if (!dir) return {};
  if (!driver.shot && !driver.pageShot) return { error: "This driver cannot take page pictures." };
  let bytes: Buffer | undefined;
  let viewport = false;
  try {
    if (process.env.BAO_PROOF_PAGE === "1" && which === "before" && /delete account/i.test(stepTitle(step) || "")) {
      const full = await driver.pageShot?.();
      if (full && full.length > 24 && full[0] === 0x89) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "identity.png"), full);
      }
    }
    if (which === "before" && step.caption?.targetBox && driver.pageShot) {
      bytes = await driver.pageShot().catch(() => undefined);
      viewport = !!bytes?.length;
    }
    if (!bytes?.length) {
      bytes = await driver.shot?.({
        identity: stepQuery(step),
        action: step.action,
        label: stepTitle(step),
      });
    }
    if (!bytes?.length && driver.pageShot) {
      bytes = await driver.pageShot();
      viewport = !!bytes?.length;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const reason = /rate.?limit|MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(message) ? "Chrome's picture rate limit was reached."
      : /cannot take|unsupported|not supported/i.test(message) ? "This driver cannot take page pictures."
      : /timeout|timed out/i.test(message) ? "Chrome timed out taking this picture."
      : /closed|no tab|not attached/i.test(message) ? "The Chrome page is no longer available."
      : "Chrome could not take this picture.";
    return { error: reason };
  }
  if (!bytes?.length) return { error: "Chrome returned no picture." };
  const format = shotFormat(bytes);
  if (!format) return { error: "Chrome returned an unsupported picture format." };
  try {
    mkdirSync(dir, { recursive: true });
    const name = shotFile(step.id, which, format);
    writeFileSync(path.join(dir, name), bytes);
    return { ref: name, viewport };
  } catch {
    return { error: "The picture could not be saved." };
  }
}
