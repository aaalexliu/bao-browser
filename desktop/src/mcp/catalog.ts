// Search, describe, and run. The MCP server exposes these four operations
// and does not add a tool per workflow.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { RecordedAgentBrowserCommand } from "../engines/agent-browser-record";
import type { BrowserChoice } from "../browser-choice";
import { navigateWorkflowBrowser, openWorkflowBrowser, type WorkflowBrowser } from "../engines/workflow-browser";
import { receiptLink } from "../app/deeplink";
import { replayRefusal, workflowSearchEligible, type WorkflowSearchContext } from "../cdp-live/launch-guard";
import { hasStrippedSecret, reusableInputs, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { hasPrivatePictureInput, scrubSaved } from "../../../shared/outbound-secrets";
import { launchOwnedChrome, pidsForDataDir, productHeadless } from "../launch";
import type { RunTrailEvent } from "../v1/apply-guard";
import { BrowserDriver, type PersonPrompts } from "../v1/browser-driver";
import { llmHealFromEnv, scriptedHeal, type HealProvider } from "../v1/heal";
import { healFromSource } from "../v1/heal-source";
import { TIMED_OUT, TIMED_OUT_STATUS } from "../v1/pending-prompt";
import { expectedText, holds, replay, withInputDefaults, type RunResult } from "../v1/replay";
import { openReplayVideo } from "../v1/replay-video";
import { formatClock, when } from "../v1/time";
import { migrate, toJson, type ReplayArgs, type WorkflowReceipt, type WorkflowStep, type WorkflowV2 } from "../v1/schema";
import { shotFile } from "../v1/shots";
import { Library, secretInputNames } from "../v1/store";
import { loadState, saveState, type SyncState } from "../v1/sync";
import { privateReviewStep } from "./review-step-privacy";
import { markImported, prepareImport, publicSamples } from "../../../web/src/lib/import-sheet";
import { savedValueLine } from "../v1/saved-inputs";
import { fitPictureBody } from "../v1/sync-pictures";
import { categoryFor, domainsOf, releaseHash, summaryOf } from "../../../web/src/lib/publish";
import { rankHits, SEARCH_LIMIT } from "../../../web/src/lib/rank";

export type OutcomeName = "ok" | "needs_human" | "needs_signin" | "needs_approval" | "failed";

export interface InputField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  /** Present when Bao fills the owner's saved value if the agent omits this input. */
  saved?: true;
  /** Why the agent can omit this input. The saved text is not included. */
  description?: string;
  choices?: string[];
}

export interface SearchHit {
  id: string;
  title: string;
  summary: string;
  site: string;
  category: string;
  /** "this Mac", the other device's name, or "marketplace". */
  source: string;
  /** Local-zone clock, or "Not replayed yet". */
  lastGreen: string;
  score: number;
  inputs: InputField[];
  link: string;
}

export interface WorkflowOutcome {
  outcome: OutcomeName;
  reason?: string;
  resume?: string;
  runId?: string;
  workflowId: string;
  receipts: WorkflowReceipt[];
  stops: { stepId: string; outcome: OutcomeName; reason: string }[];
  link: string;
  source?: string;
  lastGreen?: string;
  /** Saved status spelling; may differ from the normalized outcome. `completed` follows resume. */
  status?: OutcomeName | "completed" | "timed-out" | "timeout" | "stopped" | "passed" | "paused" | "running" | "idle" | "needs-sign-in";
  run_id?: string;
  step?: string;
  ask?: string;
  /** Local-zone clock, or "No timeout". */
  deadline?: string | null;
  resume_token?: string;
  /** Declared workflow outputs filled by this run. */
  outputs?: import("../v1/data-steps").OutputValue[];
  /** Saved values this run used. A secret is "saved password", never the value. */
  savedValues?: string;
  pageLeftOpen?: boolean;
  /** The page class that stopped this run, with the evidence that named it. */
  pageClass?: {
    class: string;
    reason: string;
    vendor?: string;
    stepId: string;
    evidence: { source: string; detail: string }[];
    line?: string;
  };
}

export interface RemoteAuth {
  server?: string;
  cookie?: string;
  authorization?: string;
}

const SIGN_IN = /login|sign[\s-]?in|password/i;

type Bucket = "mine" | "team" | "public";

interface Located {
  document: WorkflowV2;
  local: boolean;
  bucket: Bucket;
  deviceName?: string | null;
  forkedFrom?: string | null;
  lastGreenAt?: unknown;
  version?: number;
  thisDevice?: string | null;
}

export function originLabel(input: {
  local: boolean;
  bucket: Bucket;
  deviceName?: string | null;
  forkedFrom?: string | null;
  thisDevice?: string | null;
}): string {
  if (input.forkedFrom || input.bucket === "public") return "marketplace";
  const device = (input.deviceName || "").trim();
  const mine = (input.thisDevice || "").trim();
  if (input.local || (device && mine && device === mine)) return "this Mac";
  if (device) return device;
  return "this Mac";
}

/** Equal scores: this Mac, then another device, then marketplace. */
export function sourceRank(source: string): number {
  if (source === "this Mac") return 0;
  if (source === "marketplace") return 2;
  return 1;
}

export function compareSearchHits(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || sourceRank(a.source) - sourceRank(b.source) || a.title.localeCompare(b.title);
}

export function workflowReplayRefusal(library: Library, workflow: WorkflowV2): string | null {
  return replayRefusal(workflow.driver, { extensionLinked: false, pageEngine: library.settings().pageEngine });
}

export async function searchWorkflows(
  library: Library,
  query: string,
  filters: { source?: string; site?: string; category?: string } = {},
  context: Pick<WorkflowSearchContext, "extensionLinked" | "relay"> = { extensionLinked: false },
): Promise<SearchHit[]> {
  const replayContext = { ...context, pageEngine: library.settings().pageEngine };
  const thisDevice = loadState(library.root).deviceName || "";
  const workflows = library.list().workflows;
  const excluded = new Set(workflows.filter((doc) => !workflowSearchEligible(doc, replayContext)).map((doc) => doc.id));
  const local = workflows.filter((doc) => !excluded.has(doc.id)).map((doc) => ({
    id: doc.id,
    title: doc.name,
    summary: summaryOf(doc),
    site: domainsOf(doc)[0] || "",
    category: categoryFor(doc),
    steps: doc.steps.map((step) => step.label),
    source: "mine" as const,
    inputs: inputSchema(doc, agentSavedDefaults(doc)),
    link: linkFor(doc.id),
    local: true,
  }));
  const rankedLocal = rankHits(local, query, filters);
  const remote = (await remoteHits(library, query, filters, replayContext)).filter((hit) => !excluded.has(hit.id));
  const byId = new Map<string, DraftHit>();
  for (const hit of [...rankedLocal.map((item) => draftFromLocal(item)), ...remote]) {
    const prev = byId.get(hit.id);
    byId.set(hit.id, prev ? mergeDraft(prev, hit) : hit);
  }
  return [...byId.values()]
    .map((hit) => toSearchHit(hit, thisDevice, library))
    .sort(compareSearchHits)
    .slice(0, SEARCH_LIMIT);
}

export async function describeWorkflow(library: Library, id: string, auth?: RemoteAuth): Promise<{
  workflow: WorkflowV2;
  inputs: InputField[];
  link: string;
  importLink: string;
  source: string;
  lastGreen: string;
  outputs?: WorkflowV2["outputs"];
}> {
  const found = await locateWorkflow(library, id, auth);
  const workflow = scrubSaved(found.document);
  const checks: { step: WorkflowStep; field: "postcondition" | "expect"; value: string }[] = [];
  const collect = (steps: WorkflowStep[]): void => {
    for (const step of steps) {
      if (step.action !== "note" && step.action !== "verify") {
        for (const field of ["postcondition", "expect"] as const) {
          const check = step[field];
          if (check && (check.kind === "text" || check.kind === "value") && check.match) {
            checks.push({ step, field, value: check.match });
          }
        }
      }
      if (step.forEach) collect(step.forEach.steps);
    }
  };
  collect(workflow.steps);
  const projected = scrubSaved(checks.map(({ value }) => ({ op: "type", value })), { workflow: found.document });
  checks.forEach(({ step, field, value }, index) => {
    if (projected[index]?.value === STRIPPED_SECRET && value !== STRIPPED_SECRET) delete step[field];
  });
  const inputs = inputSchema(workflow, found.local ? agentSavedDefaults(found.document) : {});
  workflow.inputs.forEach((input, index) => {
    if (!inputs[index]!.required) input.required = false;
    if (input.type === "secret") delete input.default;
  });
  return {
    workflow,
    inputs,
    link: linkFor(id),
    importLink: `bao://import/${id}`,
    source: originLabel(found),
    lastGreen: greenLabel(originLabel(found), found.lastGreenAt, localGreenAt(library, id)),
    ...(workflow.outputs ? { outputs: workflow.outputs } : {}),
  };
}

export interface RunControl {
  prompts?: PersonPrompts;
  confirmCompleted?: boolean;
  onContext?: (context: BrowserContext) => void;
}

export async function runWorkflow(
  library: Library,
  request: { id?: string; inputs?: ReplayArgs; resume?: string; rerun?: boolean; cancel?: boolean; leaveOpen?: boolean; startUrl?: string; document?: WorkflowV2; browser?: BrowserChoice },
  auth?: RemoteAuth,
  control?: RunControl,
): Promise<WorkflowOutcome> {
  if (request.cancel) return cancelWorkflow(library, request.resume || "", control);
  const peeked = request.resume ? peekResume(library, request.resume) : undefined;
  if (request.resume && !peeked) return emptyOutcome("", "failed", "resume token");
  const live = request.resume ? liveRuns.get(request.resume) : undefined;
  if (live) {
    if (live.continuing) return live.continuing;
    live.continuing = Promise.resolve(live.observing)
      .catch(() => undefined)
      .then(() => {
        if (liveRuns.get(live.token) !== live) return emptyOutcome(live.workflow.id, "failed", "the run's browser is gone");
        if (live.deadline !== null && Date.now() >= live.deadline) return stopLive(library, live, "timed-out", TIMED_OUT, control);
        return continueLive(library, live, request.inputs ?? {}, control);
      })
      .finally(() => { live.continuing = undefined; });
    return live.continuing;
  }
  if (peeked && (peeked.kind === "signin" || peeked.kind === "confirm" || peeked.kind === "wall")) {
    dropResume(library, request.resume || "");
    return emptyOutcome(peeked.workflowId, "failed", "the run's browser is gone");
  }
  const resumed = request.resume ? takeResume(library, request.resume) : undefined;
  const browser = request.browser ?? resumed?.browser;
  const id = request.id || resumed?.workflowId || "";
  if (!id) return emptyOutcome("", "failed", "workflow id");
  const placed = request.document ? undefined : await locateWorkflow(library, id, auth);
  const refusal = workflowReplayRefusal(library, request.document ?? placed!.document);
  if (refusal) return emptyOutcome(id, "failed", refusal);
  const savedCopy = placed && !placed.local ? materializeWorkflow(library, placed) : undefined;
  const loaded = request.document ? migrate(request.document) : (savedCopy ?? placed!.document);
  const workflow = request.startUrl ? { ...loaded, startUrl: request.startUrl } : loaded;
  const stamp = (outcome: WorkflowOutcome): WorkflowOutcome => {
    const workflowId = outcome.workflowId || placed?.document.id || "";
    const source = placed ? originLabel(placed) : "";
    const lastGreen = greenLabel(source, placed?.lastGreenAt, workflowId ? localGreenAt(library, workflowId) : undefined);
    return placed ? { ...outcome, source, lastGreen } : { ...outcome, lastGreen };
  };
  const given: ReplayArgs = {
    ...reusableInputs(workflow, {
      ...(request.rerun && !resumed ? library.readPublicInputs(id) : {}),
      ...(resumed?.publicInputs ?? {}),
    }),
    ...(request.inputs ?? {}),
  };
  const inputs = withInputDefaults(workflow, given);
  const missing = missingHuman(workflow, inputs, given);
  if (missing) return stamp(remember(library, workflow, "needs_human", missing.reason, missing.stepId, given, browser));
  const secrets = secretStrings(workflow, inputs);
  try {
    const played = await replayInBrowser(library, workflow, inputs, secrets, control, browser);
    if (played.held) return stamp(played.outcome);
    library.savePublicInputs(id, publicInputs(workflow, inputs));
    saveWorkflowRun(library, workflow, played.run, inputs, played.outcome, played.clip);
    return stamp(played.outcome);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return stamp(remember(library, workflow, "failed", reason, workflow.steps[0]?.id || id, inputs, browser));
  }
}

/** The scripted proof signs in on the held page. Resume then continues that same run. */
export async function withHeldPage(token: string, run: (page: Page) => Promise<void>): Promise<void> {
  const live = liveRuns.get(token);
  if (!live) throw new Error("resume token");
  await run(live.page);
}

export function heldConfirmStep(token: string): { stepId: string; stepLabel: string; stepNumber: number; stepCount: number; canDetectCompletion: boolean } | undefined {
  const live = liveRuns.get(token);
  if (!live || live.kind !== "confirm" || live.continuing) return undefined;
  const index = live.workflow.steps.findIndex((step) => step.id === live.stepId);
  return {
    stepId: live.stepId,
    stepLabel: live.workflow.steps[index]?.label || "the site interaction",
    stepNumber: index + 1,
    stepCount: live.workflow.steps.length,
    canDetectCompletion: live.confirmPending === true,
  };
}

export async function heldConfirmReady(token: string): Promise<boolean> {
  const live = liveRuns.get(token);
  if (!live || live.kind !== "confirm" || live.continuing || !live.confirmPending) return false;
  if (live.observing) return live.observing;
  const stepId = live.stepId;
  const post = live.workflow.steps.find((step) => step.id === stepId)?.postcondition;
  if (!post) return false;
  live.observing = (async () => {
    const tree = await (live.observer ??= new BrowserDriver(live.page)).tree();
    return liveRuns.get(token) === live && live.stepId === stepId && !live.continuing && holds(post, tree, live.inputs);
  })().finally(() => { live.observing = undefined; });
  return live.observing;
}

export async function reviewWorkflow(
  library: Library,
  id: string,
  inputs: ReplayArgs,
  opts: RemoteAuth & { startUrl?: string } = {},
): Promise<WorkflowOutcome & { reviewed: boolean; documentHash?: string }> {
  const found = await locateWorkflow(library, id, opts);
  const released = prepareImport(found.document);
  const documentHash = releaseHash(released.document);
  const replayDoc = migrate(released.document);
  const outcome = await runWorkflow(library, { id, inputs, startUrl: opts.startUrl, document: replayDoc }, opts);
  if (outcome.outcome !== "ok") return { ...outcome, reviewed: false, documentHash };
  const state = loadState(library.root);
  const fitted = await fitPictureBody({
    documentHash,
    shots: outcome.runId ? stepShots(library, replayDoc, outcome.runId) : [],
    samples: publicSamples(inputs),
  });
  if (fitted.tooLarge) return { ...outcome, reviewed: false, documentHash, reason: "review exceeds transport limit" };
  const recorded = await remoteFetch<{ ok?: boolean }>(
    state,
    "POST",
    `/api/workflows/${encodeURIComponent(id)}/review`,
    fitted.body,
    opts,
  );
  if (!recorded?.ok) return { ...outcome, reviewed: false, documentHash, reason: "review was not recorded" };
  if (outcome.runId) {
    await remoteFetch(state, "POST", `/api/workflows/${encodeURIComponent(id)}/runs`, {
      id: outcome.runId,
      status: "passed",
      at: Date.now(),
      steps: outcome.receipts.map((step) => ({ id: step.id, status: step.status })),
    }, opts);
  }
  return { ...outcome, reviewed: true, documentHash };
}

function stepShots(library: Library, workflow: WorkflowV2, runId: string): { stepId: string; png: string }[] {
  if (hasPrivatePictureInput(workflow)) return [];
  const dir = path.join(library.root, "shots", "runs", runId);
  const run = library.readRun(runId);
  const shots: { stepId: string; png: string }[] = [];
  for (const step of workflow.steps) {
    if (privateReviewStep(workflow, step, run)) continue;
    const after = path.join(dir, shotFile(step.id, "after"));
    const before = path.join(dir, shotFile(step.id, "before"));
    const file = existsSync(after) ? after : before;
    if (!existsSync(file)) continue;
    const png = readFileSync(file);
    if (png.length < 32 || png[0] !== 0x89 || png[1] !== 0x50) continue;
    shots.push({ stepId: step.id, png: png.toString("base64") });
  }
  return shots;
}

const runOutcomes = {
  recording: "recording",
  passed: "ok", ok: "ok", completed: "ok",
  "needs-sign-in": "needs_signin", needs_signin: "needs_signin",
  needs_approval: "needs_approval", needs_human: "needs_human",
  paused: "needs_human", running: "needs_human", idle: "needs_human",
  failed: "failed", "timed-out": "failed", timeout: "failed", stopped: "failed",
} as const satisfies Record<NonNullable<WorkflowOutcome["status"]> | "recording", OutcomeName | "recording">;

export function getRun(library: Library, runId: string): Omit<WorkflowOutcome, "outcome" | "status" | "receipts" | "stops"> & {
  outcome: OutcomeName | "recording" | "unknown";
  status?: string;
  stops: { stepId: string; outcome: OutcomeName | "unknown"; reason: string }[];
  nativeOutputNote?: string;
  receipts: (WorkflowReceipt & Partial<Pick<RecordedAgentBrowserCommand, "label" | "target">> & {
    native?: Omit<RecordedAgentBrowserCommand["native"], "results"> & {
      results: (RecordedAgentBrowserCommand["native"]["results"][number] & {
        stdoutTruncated: boolean; stdoutLength: number; stderrTruncated: boolean; stderrLength: number;
      })[];
    };
  })[];
} {
  const file = reportPath(library, runId);
  if (existsSync(file)) return publicOutcome(library, JSON.parse(readFileSync(file, "utf8")) as WorkflowOutcome);
  const stored = library.readRun(runId);
  const envelope = stored.envelope;
  const status = envelope?.status ?? stored.status;
  const outcome = Object.hasOwn(runOutcomes, status) ? runOutcomes[status as keyof typeof runOutcomes] : "unknown";
  const recording = stored.kind === "capture" && status === "recording";
  const failure = recording ? undefined : stored.failure as RunResult["failure"];
  const stoppedStep = recording ? undefined : (stored.steps as { id?: string; status?: string; reason?: string }[])
    .find((item) => item?.status === "paused" || item?.status === "failed" || item?.status === "timeout");
  const reason = recording ? undefined : envelope?.reason || failure?.reason || stoppedStep?.reason;
  const step = recording ? undefined : envelope?.step || failure?.stepId || stoppedStep?.id;
  const lastClass = stored.pageClasses?.[stored.pageClasses.length - 1];
  const receipts = stored.steps.flatMap((item) => {
    const receipt = item as Partial<RecordedAgentBrowserCommand>;
    return receipt?.id && receipt.status ? [{
      id: receipt.id, status: receipt.status, readBack: "",
      ...(stored.kind === "capture" ? {
        ...(receipt.label !== undefined ? { label: receipt.label } : {}),
        ...(receipt.target !== undefined ? { target: receipt.target } : {}),
        ...(receipt.native !== undefined ? { native: {
          ...receipt.native,
          results: receipt.native.results.map((result) => ({
            ...result,
            stdout: result.stdout.slice(0, 1000),
            stderr: result.stderr.slice(0, 1000),
            stdoutTruncated: result.stdout.length > 1000,
            stdoutLength: result.stdout.length,
            stderrTruncated: result.stderr.length > 1000,
            stderrLength: result.stderr.length,
          })),
        } } : {}),
      } : {}),
    }] : [];
  });
  return publicOutcome(library, {
    outcome,
    reason,
    runId: stored.id,
    run_id: stored.id,
    workflowId: stored.workflowId,
    receipts,
    stops: outcome !== "ok" && outcome !== "recording" && step ? [{ stepId: step, outcome, reason: reason || "" }] : [],
    link: stored.kind === "capture" ? receiptLink(stored.id) : linkFor(stored.workflowId),
    outputs: stored.outputs,
    ...(stored.savedValues ? { savedValues: stored.savedValues } : {}),
    pageLeftOpen: stored.pageLeftOpen,
    status,
    ...(stored.kind === "capture" ? { nativeOutputNote: `For full native output, open ${receiptLink(stored.id)}.` } : {}),
    step,
    ask: recording ? undefined : envelope?.ask || (outcome !== "ok" ? reason : undefined),
    deadline: envelope?.deadline,
    resume: envelope?.resume_token,
    resume_token: envelope?.resume_token,
    ...(lastClass && (lastClass.class === "bot_wall" || lastClass.class === "login_wall") ? {
      pageClass: {
        class: lastClass.class,
        reason: lastClass.reason,
        vendor: lastClass.vendor,
        stepId: lastClass.stepId,
        evidence: lastClass.evidence ?? [],
        line: lastClass.line,
      },
    } : {}),
  }, stored.inputs);
}

interface LiveRun {
  token: string;
  browser: WorkflowBrowser;
  page: Page;
  video: { path(): Promise<string> } | null;
  runId: string;
  shotDir: string;
  workflow: WorkflowV2;
  inputs: ReplayArgs;
  secrets: string[];
  trail: RunTrailEvent[];
  steps: RunResult["steps"];
  stepId: string;
  kind: "signin" | "confirm" | "wall";
  deadline: number | null;
  ask: string;
  prompts?: PersonPrompts;
  observer?: BrowserDriver;
  observing?: Promise<boolean>;
  confirmPending?: boolean;
  continuing?: Promise<WorkflowOutcome>;
}

const liveRuns = new Map<string, LiveRun>();

export function hasHeldRuns(): boolean {
  return liveRuns.size > 0;
}

async function replayInBrowser(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  secrets: string[],
  control: RunControl | undefined,
  choice?: BrowserChoice,
): Promise<{ run: RunResult; outcome: WorkflowOutcome; held: boolean; clip?: { video: string; videoStartedAt: number } }> {
  const runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const shotDir = path.join(library.root, "shots", "runs", runId);
  const windowVideo = process.platform === "darwin" && process.env.BAO_HEADED === "1";
  const record = !windowVideo && process.env.BAO_RUN_VIDEO === "1";
  const videoDir = record ? path.join(library.root, "videos", "incoming") : undefined;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  let browser: WorkflowBrowser;
  if (choice) {
    browser = await openWorkflowBrowser({ browser: choice, home: library.root, site: workflow.startUrl, directory: library.settings().chromeProfile });
  } else {
    const profile = path.join(library.root, "chrome-profile");
    mkdirSync(profile, { recursive: true });
    const context = await launchOwnedChrome({ userDataDir: profile, headless: productHeadless(), videoDir });
    const page = context.pages()[0] || await context.newPage();
    browser = { kind: "owned", choice: "owned", context, page, profile, persistent: true, close: () => context.close() };
  }
  const { context, page } = browser;
  control?.onContext?.(context);
  const video = record ? page.video() : null;
  const videoStartedAt = Date.now();
  const owned = windowVideo && browser.kind === "owned"
    ? await openReplayVideo(pidsForDataDir(browser.profile), path.join(library.root, "videos", `${runId}.webm`))
    : undefined;
  let clip: { video: string; videoStartedAt: number } | undefined;
  let videoDone = false;
  const finishVideo = async () => {
    if (videoDone || !owned) return;
    videoDone = true;
    const recorded = await owned.stop();
    if (recorded.wrote) clip = { video: `${runId}.webm`, videoStartedAt };
  };
  let hold = false;
  try {
    page.setDefaultNavigationTimeout(20000);
    page.setDefaultTimeout(15000);
    if (workflow.startUrl.startsWith("http")) {
      await navigateWorkflowBrowser(browser, workflow.startUrl);
    }
    const trail: RunTrailEvent[] = [];
    const driver = new BrowserDriver(page, undefined, control?.prompts);
    const run = await replay(workflow, args, driver, {
      runId,
      shotDir,
      settings: library.settings(),
      heal: await healFromSource(library.settings().healSource, healProvider),
      now: () => Date.now(),
      yieldHuman: true,
      trail,
    });
    const outcome = rememberRun(library, workflow, run, args, secrets, choice);
    if (run.status === "paused" && run.pausedKind && run.ask && outcome.resume) {
      hold = true;
      const live: LiveRun = {
        token: outcome.resume,
        browser,
        page,
        video,
        runId,
        shotDir,
        workflow,
        inputs: args,
        secrets,
        trail: run.trail,
        steps: run.steps,
        stepId: run.pausedStepId || run.ask.stepId,
        kind: run.pausedKind,
        deadline: run.ask.deadline,
        ask: run.ask.instruction,
        prompts: control?.prompts,
      };
      await observeConfirm(live);
      liveRuns.set(outcome.resume, live);
      await finishVideo();
      saveWorkflowRun(library, workflow, run, args, outcome, clip);
      return { run, outcome, held: true, clip };
    }
    await finishVideo();
    return { run, outcome, held: false, clip };
  } finally {
    await finishVideo();
    if (!hold) await releaseBrowser(library, { browser, video, runId });
  }
}

async function continueLive(library: Library, live: LiveRun, extra: ReplayArgs, control?: RunControl): Promise<WorkflowOutcome> {
  const browser = live.browser.choice === "owned" ? undefined : live.browser.choice;
  live.inputs = { ...live.inputs, ...extra };
  live.prompts = control?.prompts ?? live.prompts;
  const run = await replay(live.workflow, live.inputs, new BrowserDriver(live.page, undefined, live.prompts), {
    runId: live.runId,
    shotDir: live.shotDir,
    settings: library.settings(),
    heal: await healFromSource(library.settings().healSource, healProvider),
    now: () => Date.now(),
    fromStepId: live.stepId,
    yieldHuman: true,
    humanReady: live.kind === "confirm" && control?.confirmCompleted ? "confirmed" : live.kind !== "wall",
    trail: live.trail,
  });
  if (run.status === "paused" && run.pausedKind && run.ask) {
    if (live.stepId === run.ask.stepId && live.kind === run.pausedKind) run.ask.deadline = live.deadline;
    live.stepId = run.pausedStepId || run.ask.stepId;
    live.kind = run.pausedKind;
    live.deadline = run.ask.deadline;
    live.ask = run.ask.instruction;
    live.trail = run.trail;
    live.steps = run.steps;
    await observeConfirm(live);
    const outcome = rememberRun(library, live.workflow, run, live.inputs, live.secrets, browser, live.token);
    saveWorkflowRun(library, live.workflow, run, live.inputs, outcome);
    return outcome;
  }
  liveRuns.delete(live.token);
  dropResume(library, live.token);
  clearLivePrompt(live);
  await releaseBrowser(library, live);
  library.savePublicInputs(live.workflow.id, publicInputs(live.workflow, live.inputs));
  const outcome = rememberRun(library, live.workflow, run, live.inputs, live.secrets, browser);
  if (run.status === "passed") outcome.status = "completed";
  saveWorkflowRun(library, live.workflow, run, live.inputs, outcome);
  return storeOutcome(library, outcome, live.workflow, live.inputs, live.secrets);
}

async function observeConfirm(live: LiveRun): Promise<void> {
  live.confirmPending = false;
  if (live.kind !== "confirm") return;
  const post = live.workflow.steps.find((step) => step.id === live.stepId)?.postcondition;
  if (!post || ((post.kind === "element" || post.kind === "absent") ? !post.identity : !post.match?.trim())) return;
  try {
    live.confirmPending = !holds(post, await (live.observer ??= new BrowserDriver(live.page)).tree(), live.inputs);
  } catch { /* The owner can use Continue if the page cannot be read. */ }
}

async function cancelWorkflow(library: Library, token: string, control?: RunControl): Promise<WorkflowOutcome> {
  if (!token) return emptyOutcome("", "failed", "resume token");
  const live = liveRuns.get(token);
  if (!live) {
    const peeked = peekResume(library, token);
    if (!peeked) return emptyOutcome("", "failed", "resume token");
    dropResume(library, token);
    const result = emptyOutcome(peeked.workflowId, "failed", "nothing applied");
    result.status = "stopped";
    result.step = peeked.stepId;
    result.ask = peeked.ask;
    return result;
  }
  return stopLive(library, live, "stopped", "nothing applied", control);
}

function clearLivePrompt(live: LiveRun): void {
  if (live.kind === "confirm") live.prompts?.clearConfirm?.(live.runId);
  else live.prompts?.clearLoginWait?.(live.runId);
}

async function stopLive(library: Library, live: LiveRun, status: "timed-out" | "stopped", reason: string, control?: RunControl): Promise<WorkflowOutcome> {
  liveRuns.delete(live.token);
  dropResume(library, live.token);
  live.prompts = control?.prompts ?? live.prompts;
  clearLivePrompt(live);
  await releaseBrowser(library, live);
  const result = baseOutcome(live.workflow, undefined, "failed", reason, live.stepId, live.inputs);
  result.runId = live.runId;
  result.run_id = live.runId;
  result.status = status;
  result.step = live.stepId;
  result.ask = live.ask;
  result.reason = reason;
  result.deadline = live.deadline ? formatClock(live.deadline) : "No timeout";
  const savedValues = savedValueLine(live.workflow, live.inputs);
  if (savedValues) result.savedValues = savedValues;
  library.saveRun({
    id: live.runId,
    workflowId: live.workflow.id,
    secretInputNames: secretInputNames(live.workflow),
    inputs: Object.fromEntries(Object.entries(publicInputs(live.workflow, live.inputs)).map(([key, value]) => [key, String(value)])),
    ...(savedValues ? { savedValues } : {}),
    status: status === "timed-out" ? TIMED_OUT_STATUS : "stopped",
    at: Date.now(),
    heals: [],
    failure: { reason },
    steps: live.steps,
    modelCalls: 0,
    trail: live.trail,
    envelope: {
      status,
      run_id: live.runId,
      step: live.stepId,
      reason,
      ask: live.ask,
      deadline: result.deadline,
    },
  });
  return storeOutcome(library, result, live.workflow, live.inputs, live.secrets);
}

async function releaseBrowser(
  library: Library,
  open: { browser: WorkflowBrowser; video: { path(): Promise<string> } | null; runId: string },
): Promise<void> {
  await open.browser.close().catch(() => undefined);
  if (open.video) {
    const src = await open.video.path().catch(() => "");
    if (src && existsSync(src)) {
      const dest = path.join(library.root, "videos", `${open.runId}.webm`);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
  if (open.browser.kind === "owned" && !open.browser.persistent) await rm(open.browser.profile, { recursive: true, force: true }).catch(() => undefined);
}

function rememberRun(
  library: Library,
  workflow: WorkflowV2,
  run: RunResult,
  inputs: ReplayArgs,
  secrets: string[],
  browser?: BrowserChoice,
  resumeToken?: string,
): WorkflowOutcome {
  const failed = run.steps.find((step) => step.status === "failed" || step.status === "paused");
  const step = workflow.steps.find((item) => item.id === (run.pausedStepId || failed?.id));
  let outcome: OutcomeName = "ok";
  let reason = "";
  let status: WorkflowOutcome["status"] = run.trail.some((event) => event.kind === "handoff") ? "completed" : "ok";
  if (run.pausedKind === "signin") {
    outcome = "needs_signin";
    status = "needs_signin";
    reason = run.ask?.instruction || "Sign in";
  } else if (run.pausedKind === "confirm") {
    outcome = "needs_human";
    status = "needs_human";
    reason = run.ask?.instruction || "Press the button";
  } else if (run.pausedKind === "wall") {
    outcome = "needs_human";
    status = "needs_human";
    reason = run.ask?.instruction || "You need to act";
  } else if (run.status === "paused") {
    outcome = "needs_human";
    status = "needs_human";
    reason = "Approve the heal before the run can continue";
  } else if (run.status === "failed") {
    outcome = signInStep(step) ? "needs_signin" : "failed";
    status = outcome;
    const raw = run.failure?.reason || "";
    reason = raw === "nothing applied" ? raw : (failed?.reason || raw || "failed");
  }
  const stepId = step?.id || run.pausedStepId || "";
  const result = baseOutcome(workflow, run, outcome, reason, stepId, inputs);
  result.status = status;
  result.run_id = run.runId;
  result.step = stepId;
  result.ask = run.ask?.instruction || (outcome === "ok" ? undefined : reason);
  result.deadline = run.ask ? (run.ask.deadline ? formatClock(run.ask.deadline) : "No timeout") : undefined;
  const lastClass = run.pageClasses[run.pageClasses.length - 1];
  if (lastClass && (lastClass.class === "bot_wall" || lastClass.class === "login_wall")) {
    result.pageClass = {
      class: lastClass.class,
      reason: lastClass.reason,
      vendor: lastClass.vendor,
      stepId: lastClass.stepId,
      evidence: lastClass.evidence,
      line: lastClass.line,
    };
  }
  if (outcome !== "ok") {
    result.resume = writeResume(library, workflow.id, publicInputs(workflow, inputs), stepId, {
      kind: run.pausedKind,
      browser,
      deadline: run.ask?.deadline ?? null,
      ask: run.ask?.instruction,
      runId: run.runId,
    }, resumeToken);
    result.resume_token = result.resume;
  }
  const savedValues = savedValueLine(workflow, inputs);
  if (savedValues) result.savedValues = savedValues;
  return storeOutcome(library, result, workflow, inputs, secrets);
}

function saveWorkflowRun(
  library: Library,
  workflow: WorkflowV2,
  run: RunResult,
  inputs: ReplayArgs,
  outcome: WorkflowOutcome,
  clip?: { video: string; videoStartedAt: number },
): void {
  const paused = outcome.status === "needs_signin" || outcome.status === "needs_human";
  const needsHuman = run.pausedKind === "wall" || run.pausedKind === "confirm";
  library.saveRun({
    id: run.runId,
    pageEngine: run.pageEngine,
    traceUnavailable: run.traceUnavailable,
    videoTruncated: run.videoTruncated,
    workflowId: workflow.id,
    status: needsHuman ? "needs_human" : paused ? "paused" : outcome.status === "completed" ? "passed" : run.status,
    at: Date.now(),
    heals: run.heals,
    failure: run.failure,
    steps: run.steps,
    modelCalls: run.modelCalls,
    pageClasses: run.pageClasses,
    trail: run.trail,
    inputs: Object.fromEntries(Object.entries(publicInputs(workflow, inputs)).map(([key, value]) => [key, String(value)])),
    secretInputNames: secretInputNames(workflow),
    ...(outcome.savedValues ? { savedValues: outcome.savedValues } : {}),
    ...(run.outputs ? { outputs: run.outputs } : {}),
    ...(run.pageLeftOpen ? { pageLeftOpen: true } : {}),
    envelope: outcome.status && outcome.status !== "ok" ? {
      status: outcome.status,
      run_id: outcome.run_id || run.runId,
      step: outcome.step,
      reason: outcome.reason,
      ask: outcome.ask,
      deadline: outcome.deadline,
      resume_token: outcome.resume_token,
    } : undefined,
    ...(clip ?? (run.video ? { video: run.video, videoStartedAt: run.videoStartedAt } : {})),
  });
}

function remember(
  library: Library,
  workflow: WorkflowV2,
  outcome: OutcomeName,
  reason: string,
  stepId: string,
  inputs: ReplayArgs,
  browser?: BrowserChoice,
): WorkflowOutcome {
  const result = baseOutcome(workflow, undefined, outcome, reason, stepId, inputs);
  result.runId = result.runId || `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const deadline = library.settings().actTimeoutMs > 0 ? Date.now() + library.settings().actTimeoutMs : null;
  result.resume = writeResume(library, workflow.id, publicInputs(workflow, inputs), stepId, {
    kind: "input",
    browser,
    deadline,
    ask: reason,
    runId: result.runId,
  });
  result.status = outcome;
  result.run_id = result.runId;
  result.step = stepId;
  result.ask = reason;
  result.deadline = deadline ? formatClock(deadline) : "No timeout";
  result.resume_token = result.resume;
  return storeOutcome(library, result, workflow, inputs);
}

function baseOutcome(
  workflow: WorkflowV2,
  run: RunResult | undefined,
  outcome: OutcomeName,
  reason: string,
  stepId: string,
  inputs: ReplayArgs,
): WorkflowOutcome {
  const receipts = workflow.steps.map((step) => {
    const status = run?.steps.find((item) => item.id === step.id)?.status || "pending";
    return { id: step.id, status, readBack: readBack(step, status, inputs) };
  });
  return {
    outcome,
    reason: reason || undefined,
    runId: run?.runId,
    workflowId: workflow.id,
    receipts,
    stops: outcome === "ok" ? [] : [{ stepId, outcome, reason }],
    link: linkFor(workflow.id),
    ...(run?.outputs ? { outputs: run.outputs } : {}),
    ...(run?.pageLeftOpen ? { pageLeftOpen: true } : {}),
  };
}

function readBack(step: WorkflowStep, status: string, inputs: ReplayArgs): string {
  if (status === "pending") return "";
  if (step.postcondition?.match) return expectedText(step.postcondition.match, inputs);
  if (step.value?.includes("{{")) return expectedText(step.value, inputs);
  return step.label;
}

function missingHuman(workflow: WorkflowV2, filled: ReplayArgs, given: ReplayArgs): { stepId: string; reason: string } | null {
  for (const input of workflow.inputs) {
    if (input.required === false) continue;
    const value = filled[input.name];
    const empty = value === undefined || value === "";
    const authorOmitted = workflow.imported === true && input.ownerSaved !== true && omitted(given, input.name);
    if (!empty && !authorOmitted) continue;
    if (input.type === "secret") return { stepId: input.name, reason: `Enter ${input.label || input.name} on this device` };
    if (input.type === "file") return { stepId: input.name, reason: `Choose ${input.label || input.name} on this device` };
    if (authorOmitted || workflow.imported) return { stepId: input.name, reason: `Enter ${input.label || input.name}` };
  }
  return null;
}

function omitted(args: ReplayArgs, name: string): boolean {
  const value = args[name];
  return value === undefined || value === "";
}

function agentSavedDefaults(workflow: WorkflowV2): ReplayArgs {
  const filled = withInputDefaults(workflow, {});
  if (workflow.imported !== true) return filled;
  const kept: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.ownerSaved === true && Object.hasOwn(filled, input.name)) kept[input.name] = filled[input.name]!;
  }
  return kept;
}

function usableSaved(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value !== "" && !hasStrippedSecret(value);
}

function signInStep(step: WorkflowStep | undefined): boolean {
  if (!step) return false;
  return SIGN_IN.test(`${step.id} ${step.label} ${step.input || ""}`) || step.sensitive === true;
}

function inputSchema(doc: WorkflowV2, defaults: ReplayArgs): InputField[] {
  return doc.inputs.map((input) => {
    const value = Object.hasOwn(defaults, input.name) ? defaults[input.name] : undefined;
    const saved = usableSaved(value);
    return {
      name: input.name,
      type: input.type,
      label: input.label || input.name,
      required: input.required !== false && !saved,
      ...(saved ? {
        saved: true as const,
        description: input.type === "secret"
          ? "Bao fills the saved password when omitted."
          : "Bao fills the saved value when omitted.",
      } : {}),
      choices: input.choices,
    };
  });
}

function publicInputs(workflow: WorkflowV2, inputs: ReplayArgs): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const input of workflow.inputs) {
    if (input.type === "file") continue;
    const value = inputs[input.name];
    if (typeof value === "string" || typeof value === "number") out[input.name] = value;
  }
  return out;
}

function secretStrings(workflow: WorkflowV2, inputs: ReplayArgs): string[] {
  const out: string[] = [];
  for (const input of workflow.inputs) {
    if (input.type !== "secret") continue;
    const value = inputs[input.name];
    if (typeof value === "string" && value.length >= 4) out.push(value);
  }
  return out;
}

function publicOutcome<T extends Pick<WorkflowOutcome, "workflowId">>(library: Library, outcome: T, inputs?: ReplayArgs): T {
  let workflow: WorkflowV2 | undefined;
  try { workflow = library.read(outcome.workflowId); }
  catch { workflow = undefined; }
  return scrubSaved(outcome, { workflow, args: inputs });
}

function storeOutcome(library: Library, outcome: WorkflowOutcome, workflow: WorkflowV2, inputs: ReplayArgs, secrets = secretStrings(workflow, inputs)): WorkflowOutcome {
  const parsed = scrubSaved(outcome, { workflow, args: inputs, secrets });
  writeReport(library, parsed);
  return parsed;
}

function writeReport(library: Library, outcome: WorkflowOutcome): void {
  if (!outcome.runId) return;
  const file = reportPath(library, outcome.runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(outcome, null, 2));
}

function reportPath(library: Library, runId: string): string {
  return path.join(library.root, "reports", `${safeToken(runId)}.json`);
}

interface ResumeFile {
  workflowId: string;
  browser?: BrowserChoice;
  stepId: string;
  publicInputs: Record<string, string | number>;
  kind?: "signin" | "confirm" | "input" | "wall";
  deadline?: number | null;
  ask?: string;
  runId?: string;
}

function writeResume(
  library: Library,
  workflowId: string,
  inputs: Record<string, string | number>,
  stepId: string,
  extra: { kind?: ResumeFile["kind"]; browser?: BrowserChoice; deadline?: number | null; ask?: string; runId?: string } = {},
  token = `r_${randomBytes(16).toString("hex")}`,
): string {
  const file = path.join(library.root, "resumes", `${token}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  const body: ResumeFile = { workflowId, stepId, publicInputs: inputs, ...extra };
  writeFileSync(file, JSON.stringify(body));
  return token;
}

export function peekResume(library: Library, token: string): ResumeFile | undefined {
  const file = resumePath(library, token);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as ResumeFile;
}

function dropResume(library: Library, token: string): void {
  rmSync(resumePath(library, token), { force: true });
}

function takeResume(library: Library, token: string): ResumeFile {
  const parsed = peekResume(library, token);
  if (!parsed) throw new Error("resume token");
  dropResume(library, token);
  return parsed;
}

function resumePath(library: Library, token: string): string {
  return path.join(library.root, "resumes", `${safeToken(token)}.json`);
}

function emptyOutcome(id: string, outcome: OutcomeName, reason: string): WorkflowOutcome {
  return { outcome, reason, workflowId: id, receipts: [], stops: [{ stepId: id, outcome, reason }], link: linkFor(id) };
}

interface DraftHit {
  id: string;
  title: string;
  summary: string;
  site: string;
  category: string;
  bucket: Bucket;
  score: number;
  inputs: InputField[];
  link: string;
  local: boolean;
  deviceName?: string | null;
  forkedFrom?: string | null;
  lastGreenAt?: unknown;
}

interface RemotePayload {
  document?: unknown;
  version?: number;
  lastGreenAt?: unknown;
  deviceName?: string | null;
  forkedFrom?: string | null;
  visibility?: string;
  owned?: boolean;
}

function draftFromLocal(hit: {
  id: string;
  title: string;
  summary: string;
  site: string;
  category: string;
  source: Bucket;
  score: number;
  inputs: InputField[];
  link: string;
}): DraftHit {
  return {
    id: hit.id,
    title: hit.title,
    summary: hit.summary,
    site: hit.site,
    category: hit.category,
    bucket: hit.source,
    score: hit.score,
    inputs: hit.inputs,
    link: hit.link,
    local: true,
  };
}

function mergeDraft(prev: DraftHit, hit: DraftHit): DraftHit {
  const local = prev.local || hit.local;
  const base = local ? (prev.local ? prev : hit) : (hit.score > prev.score ? hit : prev);
  const forkedFrom = prev.forkedFrom || hit.forkedFrom || null;
  const bucket: Bucket = prev.bucket === "public" || hit.bucket === "public" ? "public" : base.bucket;
  return {
    ...base,
    local,
    score: Math.max(prev.score, hit.score),
    bucket: forkedFrom ? base.bucket : bucket,
    deviceName: hit.deviceName || prev.deviceName || null,
    forkedFrom,
    lastGreenAt: prev.lastGreenAt ?? hit.lastGreenAt,
  };
}

function toSearchHit(hit: DraftHit, thisDevice: string, library: Library): SearchHit {
  const source = originLabel({ ...hit, thisDevice });
  return {
    id: hit.id,
    title: hit.title,
    summary: hit.summary,
    site: hit.site,
    category: hit.category,
    source,
    lastGreen: greenLabel(source, hit.lastGreenAt, localGreenAt(library, hit.id)),
    score: hit.score,
    inputs: hit.inputs,
    link: hit.link || linkFor(hit.id),
  };
}

/** A marketplace clock this Mac has not replayed is the publisher's, not this user's. */
export function greenLabel(source: string, remoteAt: unknown, localAt?: number): string {
  const remote = epoch(remoteAt);
  const local = localAt && localAt > 0 ? localAt : 0;
  if (local > 0 && local >= remote) return when(local);
  const shown = when(remote > 0 ? remote : undefined);
  if (source === "marketplace" && remote > 0) return `publisher green · ${shown}`;
  return shown;
}

function localGreenAt(library: Library, id: string): number | undefined {
  let latest = 0;
  for (const run of library.listRuns()) {
    if (run.workflowId !== id) continue;
    if (run.kind === "capture" || (run.status !== "passed" && run.status !== "ok")) continue;
    if (run.at > latest) latest = run.at;
  }
  return latest || undefined;
}

function epoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function locateWorkflow(library: Library, id: string, auth?: RemoteAuth): Promise<Located> {
  const remote = await remoteWorkflow(library, id, auth);
  let localDoc: WorkflowV2 | undefined;
  try {
    localDoc = library.read(id);
  } catch {
    localDoc = undefined;
  }
  const thisDevice = loadState(library.root).deviceName || "";
  if (localDoc) {
    return {
      document: localDoc,
      local: true,
      bucket: remote?.forkedFrom ? "mine" : remote?.bucket ?? "mine",
      deviceName: remote?.deviceName,
      forkedFrom: remote?.forkedFrom,
      lastGreenAt: remote?.lastGreenAt,
      version: remote?.version,
      thisDevice,
    };
  }
  if (remote?.document) {
    return {
      document: migrate(remote.document),
      local: false,
      bucket: remote.bucket,
      deviceName: remote.deviceName,
      forkedFrom: remote.forkedFrom,
      lastGreenAt: remote.lastGreenAt,
      version: remote.version,
      thisDevice,
    };
  }
  throw new Error("workflow not found");
}

function materializeWorkflow(library: Library, found: Located): WorkflowV2 {
  const migrated = migrate(found.document);
  const legacyFork = Boolean(found.forkedFrom) && migrated.imported !== true;
  const doc = found.bucket === "public" || legacyFork ? markImported(migrated) as WorkflowV2 : migrated;
  library.save(doc);
  const saved = library.read(doc.id);
  if (!found.version) return saved;
  const state = loadState(library.root);
  state.workflows[doc.id] = {
    version: found.version,
    hash: createHash("sha256").update(toJson(saved)).digest("hex"),
  };
  saveState(library.root, state);
  return saved;
}

async function remoteWorkflow(library: Library, id: string, auth?: RemoteAuth): Promise<(RemotePayload & { bucket: Bucket }) | null> {
  const state = loadState(library.root);
  const owned = await remoteFetch<RemotePayload>(state, "GET", `/api/workflows/${encodeURIComponent(id)}`, undefined, auth);
  if (owned?.document) {
    const bucket: Bucket = owned.visibility === "public" && owned.owned === false ? "public" : "mine";
    return { ...owned, bucket };
  }
  const pub = await remoteFetch<RemotePayload>(state, "GET", `/api/marketplace/${encodeURIComponent(id)}`, undefined, auth);
  if (pub?.document) return { ...pub, bucket: "public" };
  return null;
}

async function remoteHits(library: Library, query: string, filters: { source?: string; site?: string; category?: string }, context: WorkflowSearchContext): Promise<DraftHit[]> {
  const state = loadState(library.root);
  if (!state.server || !state.deviceToken) return [];
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filters.source) params.set("source", filters.source);
  if (filters.site) params.set("site", filters.site);
  if (filters.category) params.set("category", filters.category);
  params.set("extensionLinked", String(context.extensionLinked));
  if (context.pageEngine) params.set("pageEngine", context.pageEngine);
  if (context.relay) params.set("relay", "true");
  // fetch encodes "+" as "%2B", and the server then searches for a literal plus.
  const qs = params.toString().replace(/\+/g, "%20");
  const body = await remoteFetch<{ hits?: RemoteCatalogHit[] }>(state, "GET", `/api/catalog?${qs}`);
  return (body?.hits ?? []).map((hit) => ({
    id: hit.id,
    title: hit.title,
    summary: hit.summary,
    site: hit.site,
    category: hit.category,
    bucket: hit.source,
    score: hit.score,
    inputs: hit.inputs ?? [],
    link: hit.link || linkFor(hit.id),
    local: false,
    deviceName: hit.deviceName,
    forkedFrom: hit.forkedFrom,
    lastGreenAt: hit.lastGreenAt,
  }));
}

interface RemoteCatalogHit {
  id: string;
  title: string;
  summary: string;
  site: string;
  category: string;
  source: Bucket;
  score: number;
  inputs?: InputField[];
  link?: string;
  deviceName?: string | null;
  forkedFrom?: string | null;
  lastGreenAt?: string | null;
}

async function remoteFetch<T>(
  state: SyncState,
  method: string,
  pathname: string,
  body?: unknown,
  auth?: RemoteAuth,
): Promise<T | null> {
  const server = (auth?.server || state.server || "").replace(/\/$/, "");
  if (!server) return null;
  const headers: Record<string, string> = {};
  if (auth?.cookie) headers.cookie = auth.cookie;
  else if (auth?.authorization) headers.authorization = auth.authorization;
  else if (state.deviceToken) headers.authorization = `Bearer ${state.deviceToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${server}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return await res.json() as T;
}

function healProvider(): HealProvider {
  if (process.env.BAO_HEAL_FIXTURE === "1") {
    return scriptedHeal({
      patch: { identity: { surface: "dom", role: "button", testId: "login", path: [] } },
      model: { provider: "fixture", name: "bao-heal-fixture", version: "1" },
      prompt: "The login control's test id is login.",
      rawResponse: "{\"identity\":{\"testId\":\"login\"}}",
    });
  }
  return llmHealFromEnv();
}

function linkFor(id: string): string {
  return `bao://workflow/${id}`;
}

function safeToken(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("bad id");
  return value;
}
