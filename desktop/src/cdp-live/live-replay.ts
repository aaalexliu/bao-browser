// The one runner for a cdp-live workflow. The app's replay, bao mcp's
// run_workflow, and the relay all call replayLiveWorkflow. It takes the CDP
// lock, opens its own connection and its own window in the live target, and
// runs the standard replay() engine with no heal provider, so it never calls a
// model. Every act goes through the live session's guards in live-act.ts. The
// hosts, labels, and stop paths come from the preset of the workflow's start url.

import { navigationGuard, originsFor } from "./allowlist";
import { chromeHelper, closeInspectTab, type ChromeAx } from "./ax";
import type { CdpLiveDriver } from "./driver";
import { clickLive, pressLiveKey, typeLive, watchNewTargets, type LiveActOutcome, type LiveActTarget } from "./live-act";
import { buildView, pageHalt, readLivePage, type LabelGuard, type LiveRead, type PageFacts } from "./live-ops";
import { connectTarget, prepareTarget, type LiveTarget, type OpenProfileWindow } from "./live-target";
import { setRemoteDebugging } from "./remote-debugging";
import { acquireCdpLock, CDP_LOCK_PATH, releaseCdpLock, rememberLockTarget, takeDeadTarget } from "./lock";
import { guardPreset, presetForUrl, type PresetName } from "./presets";
import { unavailableHeal, type FailureSnapshot } from "../v1/heal";
import { makeAsk, siteHost } from "../v1/human-ask";
import type { PageSignals } from "../v1/page-class";
import { replay, type Driver, type LiveTree, type RunResult } from "../v1/replay";
import type { FileArg, Identity, ReplayArgs, WorkflowV2 } from "../v1/schema";

/** The lock holder name for a replay. A live session holds the same lock as bao-live. */
export const REPLAY_AGENT = "bao-live-replay";

/** What a live page may do: the preset's labels and stop paths, and the hosts and origins it may load. */
export interface LiveScope {
  preset: PresetName;
  guard: LabelGuard;
  stopPath: string;
  hosts: string[];
  origins: string[];
}

/** The scope of a start url. A known host always gets its own preset. Other hosts use `asked`, else generic. */
export function liveScope(url: string, asked = ""): LiveScope {
  const preset = presetForUrl(url, asked);
  if (!preset) throw new Error("unknown preset");
  const flags = guardPreset(preset);
  const hosts = [...new Set([new URL(url).hostname, ...flags.hosts])];
  return {
    preset,
    guard: { commit: flags.commit, deny: flags.deny, submit: flags.submit },
    stopPath: flags.stopPath,
    hosts,
    origins: originsFor(url, hosts),
  };
}

/** Recorded defaults, then the caller's inputs. An empty value keeps the default. */
export function liveReplayArgs(workflow: Pick<WorkflowV2, "inputs">, inputs: ReplayArgs): ReplayArgs {
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file" || !input.default) continue;
    args[input.name] = input.type === "number" ? Number(input.default) : input.default;
  }
  for (const [name, value] of Object.entries(inputs)) {
    if (value === "" || value === undefined || value === null) continue;
    args[name] = value;
  }
  return args;
}

/** A guard stop. A halt pauses the run for a person. A refusal fails the step. */
class LiveStop extends Error {
  constructor(readonly reason: string, readonly halt: boolean) {
    super(reason);
  }
}

/** What the guarded driver uses of a live window. */
export type LiveWindow = LiveActTarget["driver"] & Pick<
  CdpLiveDriver,
  "tree" | "snapshot" | "pageSignals" | "waitIdle" | "goto" | "handleOf" | "upload" | "drop" | "digits"
>;

/**
 * The replay engine's driver for a live window. It reads and waits through the
 * CdpLiveDriver, and it clicks, types, and presses keys only through live-act.ts.
 * A control the live view does not list is refused, as live_click refuses it.
 */
export class GuardedLiveDriver implements Driver {
  private epoch = 0;
  private focused: Identity | undefined;
  /** Set when the window opened a new page. The next act stops. */
  halted = "";
  /** The last guard stop, so the runner can tell a halt from a refusal. */
  stopped: LiveStop | undefined;

  constructor(private readonly inner: LiveWindow, private readonly scope: LiveScope) {}

  tree(): Promise<LiveTree> {
    return this.inner.tree();
  }

  snapshot(): Promise<FailureSnapshot> {
    return this.inner.snapshot();
  }

  pageSignals(): Promise<PageSignals> {
    return this.inner.pageSignals();
  }

  async notify(): Promise<void> {}

  sleep(ms: number): Promise<void> {
    return this.inner.sleep(ms);
  }

  waitIdle(timeoutMs: number): Promise<void> {
    return this.inner.waitIdle(timeoutMs);
  }

  async goto(url: string): Promise<void> {
    const why = navigationGuard(url, this.scope.hosts, this.scope.origins, this.scope.stopPath);
    if (why) throw this.stop(why, false);
    await this.inner.goto(url);
  }

  async click(node: Identity): Promise<void> {
    await this.act(node, (target, ref) => clickLive(target, ref));
  }

  async check(node: Identity): Promise<void> {
    await this.click(node);
  }

  async fill(node: Identity, text: string, secret: boolean): Promise<void> {
    if (secret) throw this.stop("cdp-live does not fill secrets", false);
    await this.act(node, (target, ref) => typeLive(target, ref, text, true));
  }

  async focus(node: Identity): Promise<void> {
    this.focused = node;
  }

  /** The key goes to the control the last focus() named, else to whatever has focus. */
  async key(key: string): Promise<void> {
    const node = this.focused;
    this.focused = undefined;
    await this.act(node, (target, ref) => pressLiveKey(target, key, ref));
  }

  upload(node: Identity, files: FileArg[]): Promise<void> {
    return this.inner.upload(node, files);
  }

  drop(node: Identity, files: FileArg[]): Promise<void> {
    return this.inner.drop(node, files);
  }

  digits(): Promise<void> {
    return this.inner.digits();
  }

  private stop(reason: string, halt: boolean): LiveStop {
    this.stopped = new LiveStop(reason, halt);
    return this.stopped;
  }

  private async read(handle: string): Promise<{ read: LiveRead; facts: PageFacts }> {
    this.epoch += 1;
    const facts = await this.inner.evaluateFunction<PageFacts>(readLivePage, handle ? { markIndex: -1, markHandle: handle } : { markIndex: -1 });
    return { read: buildView(facts, this.epoch, this.scope.guard), facts };
  }

  private target(read: LiveRead): LiveActTarget {
    return {
      driver: this.inner,
      read,
      guard: this.scope.guard,
      stopPath: this.scope.stopPath,
      hosts: this.scope.hosts,
      origins: this.scope.origins,
      before: async () => undefined,
      reread: async () => (await this.read("")).read,
    };
  }

  /** Reads the page, halts on a wall or a stop path, then acts on the control tree() named, if the live view lists it. */
  private async act(node: Identity | undefined, run: (target: LiveActTarget, ref: string) => Promise<LiveActOutcome>): Promise<void> {
    if (this.halted) throw this.stop(this.halted, true);
    const handle = node ? this.inner.handleOf(node) : "";
    if (node && !handle) throw this.stop("element handle expired", false);
    const { read, facts } = await this.read(handle);
    const halt = pageHalt({
      blocked: facts.blocked,
      path: facts.path,
      passwordFields: read.view.credentialFields,
      text: facts.text,
      stopPath: this.scope.stopPath,
    });
    if (halt) throw this.stop(halt, true);
    const marked = facts.marked ?? -1;
    if (node && marked < 0) throw this.stop("not_a_live_control", false);
    const ref = node ? `e${read.view.epoch}.c${marked}` : "";
    const outcome = await run(this.target(read), ref);
    if (outcome.kind === "applied") return;
    throw this.stop(outcome.reason, outcome.kind === "halted");
  }
}

function haltLine(reason: string, site: string): string {
  if (reason === "login_wall") return `Sign in to ${site} in Chrome, then run the workflow again.`;
  if (reason === "bot_wall") return `${site} is showing a bot check. Complete it in Chrome, then run the workflow again.`;
  if (reason === "stop-path") return `The page went to a path on ${site} that Bao does not drive, so Bao stopped.`;
  if (reason === "new_target") return "The page opened a new window. Bao closed it and stopped.";
  if (reason === "credential_field") return `Bao stopped at a credential field on ${site}.`;
  return "Focus left the field Bao was typing in, so Bao stopped.";
}

/** A guard halt becomes a pause for a person at that step, as a wall the engine finds is. */
function pausedAt(workflow: WorkflowV2, run: RunResult, stepId: string, reason: string): RunResult {
  const index = Math.max(0, workflow.steps.findIndex((step) => step.id === stepId));
  const step = workflow.steps[index];
  const site = siteHost(workflow.startUrl);
  const ask = {
    ...makeAsk({
      kind: "wall",
      wall: reason === "bot_wall" ? "bot" : "login",
      workflowId: workflow.id,
      workflowName: workflow.name,
      stepId,
      stepIndex: index + 1,
      stepCount: workflow.steps.length,
      label: step?.label || "",
      site: workflow.startUrl,
      timeoutMs: 0,
      windowName: "Chrome",
      runId: run.runId,
    }),
    instruction: haltLine(reason, site),
  };
  return {
    ...run,
    status: "paused",
    pausedKind: "wall",
    pausedStepId: stepId,
    ask,
    steps: run.steps.map((item) => (item.id === stepId ? { ...item, status: "paused", reason } : item)),
  };
}

function settle(workflow: WorkflowV2, run: RunResult, driver: GuardedLiveDriver): RunResult {
  const stop = driver.stopped;
  if (run.status === "failed" && run.failure && stop?.halt && run.failure.reason === stop.reason) {
    return pausedAt(workflow, run, run.failure.stepId, stop.reason);
  }
  if (run.status === "passed" && driver.halted) {
    const last = [...run.steps].reverse().find((step) => step.status === "passed" && step.reason !== "other branch");
    return pausedAt(workflow, run, last?.id || workflow.steps[0]?.id || workflow.id, driver.halted);
  }
  return run;
}

/** replay() on a guarded live window, with no heal provider and no approval step. A guard halt pauses the run. */
export async function replayGuarded(workflow: WorkflowV2, inputs: ReplayArgs, guarded: GuardedLiveDriver, runId: string): Promise<RunResult> {
  const run = await replay(workflow, liveReplayArgs(workflow, inputs), guarded, {
    runId,
    now: () => Date.now(),
    heal: unavailableHeal(),
    siteTrust: "allow",
    yieldHuman: true,
    holdForPerson: false,
  });
  return settle(workflow, run, guarded);
}

export interface LiveReplayDeps {
  /** The Chrome to drive: the serve-level live target. */
  target: LiveTarget;
  lockFile?: string;
  /** BaoOSHelper, for the daily Chrome's Allow dialog. Tests pass a fake. */
  helper?: () => ChromeAx;
  openProfile: OpenProfileWindow;
  /** Where the Allow press logs what the helper saw. */
  axLog: string;
  connectTimeoutMs?: number;
  /** Opens chrome://inspect/#remote-debugging in the daily Chrome when its remote debugging is off. */
  openInspect?: (pid: number) => Promise<void | { windowId?: string }>;
  screenLocked?: () => Promise<boolean>;
  closeOpenedTab?: (pid: number) => Promise<void>;
}

/**
 * Replays a cdp-live workflow in a new window of the live target. A recorded
 * workflow runs with no approval step. A confirm or sign-in step, a wall, and a
 * guard halt pause the run for a person. A guard refusal fails the step. The run
 * never calls a model, so modelCalls is 0.
 */
export async function replayLiveWorkflow(
  workflow: WorkflowV2,
  inputs: ReplayArgs,
  deps: LiveReplayDeps,
  runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): Promise<RunResult> {
  if (workflow.driver !== "cdp-live") throw new Error("not a live workflow");
  const scope = liveScope(workflow.startUrl);
  const blocked = navigationGuard(workflow.startUrl, scope.hosts, scope.origins, scope.stopPath);
  if (blocked) throw new Error(blocked);
  const lockFile = deps.lockFile || CDP_LOCK_PATH;
  await acquireCdpLock(REPLAY_AGENT, { file: lockFile, timeoutMs: 5_000 });
  let prepared;
  try {
    prepared = await prepareTarget(deps.target, deps.helper, deps.openInspect ? {
      openInspect: deps.openInspect,
      axLog: deps.axLog,
      screenLocked: deps.screenLocked,
      closeOpenedTab: deps.closeOpenedTab,
    } : undefined);
  } catch (err) {
    releaseCdpLock(REPLAY_AGENT, lockFile);
    throw err;
  }
  let cdp: Awaited<ReturnType<typeof connectTarget>>["cdp"] | undefined;
  let driver: CdpLiveDriver | undefined;
  try {
    const opened = await connectTarget(prepared, scope.hosts, {
      openProfile: deps.openProfile,
      axLog: deps.axLog,
      connectTimeoutMs: deps.connectTimeoutMs,
    });
    cdp = opened.cdp;
    driver = opened.driver;
    driver.setOrigins(scope.origins);
    driver.setStopPath(scope.stopPath);
    rememberLockTarget(REPLAY_AGENT, driver.targetId, lockFile);
    const leftover = takeDeadTarget(lockFile);
    if (leftover && leftover !== driver.targetId) {
      await cdp.send("Target.closeTarget", { targetId: leftover }).catch(() => undefined);
    }
    const guarded = new GuardedLiveDriver(driver, scope);
    await watchNewTargets(cdp, driver.targetId, () => true, () => {
      guarded.halted = "new_target";
    });
    await driver.goto(workflow.startUrl);
    return await replayGuarded(workflow, inputs, guarded, runId);
  } finally {
    await driver?.end().catch(() => undefined);
    cdp?.close();
    if (prepared.turnedOn && deps.openInspect) {
      const ax = deps.helper ? deps.helper() : chromeHelper();
      await setRemoteDebugging(false, {
        helper: ax,
        portFile: prepared.target.portFile,
        axLog: deps.axLog,
        openInspect: deps.openInspect,
        screenLocked: deps.screenLocked,
        closeOpenedTab: deps.closeOpenedTab || ((pid) => closeInspectTab(chromeHelper(), deps.axLog, pid)),
      }).catch(() => undefined);
    }
    releaseCdpLock(REPLAY_AGENT, lockFile);
  }
}
