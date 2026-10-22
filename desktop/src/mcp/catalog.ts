// Search, describe, and run. The MCP server exposes these four operations
// and does not add a tool per workflow.

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome, pidsForDataDir } from "../launch";
import type { RunTrailEvent } from "../v1/apply-guard";
import { BrowserDriver } from "../v1/browser-driver";
import { llmHealFromEnv, scriptedHeal, type HealProvider } from "../v1/heal";
import { TIMED_OUT, TIMED_OUT_STATUS } from "../v1/pending-prompt";
import { expectedText, replay, type RunResult } from "../v1/replay";
import { openReplayVideo } from "../v1/replay-video";
import { formatClock, when } from "../v1/time";
import { migrate, toJson, type ReplayArgs, type WorkflowStep, type WorkflowV2 } from "../v1/schema";
import { shotFile } from "../v1/shots";
import { originOf, trustMode } from "../v1/site-trust";
import { Library } from "../v1/store";
import { loadState, saveState, type SyncState } from "../v1/sync";
import { prepareImport, publicSamples } from "../../../web/src/lib/import-sheet";
import { permissionPreview, type PermissionPreview } from "../../../web/src/lib/permissions";
import { categoryFor, domainsOf, releaseHash, summaryOf } from "../../../web/src/lib/publish";
import { rankHits, SEARCH_LIMIT } from "../../../web/src/lib/rank";

export type OutcomeName = "ok" | "needs_human" | "needs_signin" | "needs_approval" | "failed";

export interface InputField {
  name: string;
  type: string;
  label: string;
  required: boolean;
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
  receipts: { id: string; status: string; readBack: string }[];
  stops: { stepId: string; outcome: OutcomeName; reason: string }[];
  link: string;
  source?: string;
  lastGreen?: string;
  /** Set when a marketplace listing has not been allowed. */
  permissions?: PermissionPreview;
  /** Structured human step. `completed` is the same run after resume. */
  status?: OutcomeName | "completed" | "timed-out" | "stopped" | "ok";
  run_id?: string;
  step?: string;
  ask?: string;
  /** Local-zone clock, or "No timeout". */
  deadline?: string | null;
  resume_token?: string;
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

export async function searchWorkflows(
  library: Library,
  query: string,
  filters: { source?: string; site?: string; category?: string } = {},
): Promise<SearchHit[]> {
  const thisDevice = loadState(library.root).deviceName || "";
  const local = library.list().map((doc) => ({
    id: doc.id,
    title: doc.name,
    summary: summaryOf(doc),
    site: domainsOf(doc)[0] || "",
    category: categoryFor(doc),
    steps: doc.steps.map((step) => step.label),
    source: "mine" as const,
    inputs: inputSchema(doc),
    link: linkFor(doc.id),
    local: true,
  }));
  const rankedLocal = rankHits(local, query, filters);
  const remote = await remoteHits(library, query, filters);
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
}> {
  const found = await locateWorkflow(library, id, auth);
  const workflow = stripSecretDefaults(found.document);
  return {
    workflow,
    inputs: inputSchema(workflow),
    link: linkFor(id),
    importLink: `bao://import/${id}`,
    source: originLabel(found),
    lastGreen: greenLabel(originLabel(found), found.lastGreenAt, localGreenAt(library, id)),
  };
}

export async function runWorkflow(
  library: Library,
  request: { id?: string; inputs?: ReplayArgs; resume?: string; rerun?: boolean; cancel?: boolean; startUrl?: string; document?: WorkflowV2 },
  auth?: RemoteAuth,
): Promise<WorkflowOutcome> {
  if (request.cancel) return cancelWorkflow(library, request.resume || "");
  const peeked = request.resume ? peekResume(library, request.resume) : undefined;
  if (request.resume && !peeked) return emptyOutcome("", "failed", "resume token");
  const live = request.resume ? liveRuns.get(request.resume) : undefined;
  if (live) {
    if (live.deadline !== null && Date.now() >= live.deadline) return stopLive(library, live, "timed-out", TIMED_OUT);
    return continueLive(library, live, request.inputs ?? {});
  }
  if (peeked && (peeked.kind === "signin" || peeked.kind === "confirm")) {
    dropResume(library, request.resume || "");
    return emptyOutcome(peeked.workflowId, "failed", "the run's browser is gone");
  }
  const resumed = request.resume ? takeResume(library, request.resume) : undefined;
  const id = request.id || resumed?.workflowId || "";
  if (!id) return emptyOutcome("", "failed", "workflow id");
  const placed = request.document ? undefined : await locateWorkflow(library, id, auth);
  if (placed && (placed.bucket === "public" || placed.forkedFrom)) {
    const listingId = placed.forkedFrom || placed.document.id;
    const access = await marketplaceAccess(library, listingId, placed.document);
    if (!access.allowed) {
      return {
        outcome: "needs_approval",
        status: "needs_approval",
        workflowId: id,
        source: "marketplace",
        reason: "Allow this listing before it can run.",
        link: linkFor(id),
        receipts: [],
        stops: [],
        permissions: access.preview,
      };
    }
    rememberListingTrust(library, access.preview);
  }
  if (placed && !placed.local) materializeWorkflow(library, placed);
  const loaded = request.document ? migrate(request.document) : placed!.document;
  const workflow = request.startUrl ? { ...loaded, startUrl: request.startUrl } : loaded;
  const stamp = (outcome: WorkflowOutcome): WorkflowOutcome => {
    const workflowId = outcome.workflowId || placed?.document.id || "";
    const source = placed ? originLabel(placed) : "";
    const lastGreen = greenLabel(source, placed?.lastGreenAt, workflowId ? localGreenAt(library, workflowId) : undefined);
    return placed ? { ...outcome, source, lastGreen } : { ...outcome, lastGreen };
  };
  const inputs: ReplayArgs = {
    ...(request.rerun || resumed ? library.readPublicInputs(id) : {}),
    ...(resumed?.publicInputs ?? {}),
    ...(request.inputs ?? {}),
  };
  const missing = missingHuman(workflow, inputs);
  if (missing) return stamp(remember(library, workflow, "needs_human", missing.reason, missing.stepId, inputs));
  const secrets = secretStrings(workflow, inputs);
  try {
    const played = await replayInBrowser(library, workflow, inputs, secrets);
    if (played.held) return stamp(played.outcome);
    library.savePublicInputs(id, publicInputs(workflow, inputs));
    saveWorkflowRun(library, workflow, played.run, inputs, played.outcome, played.clip);
    return stamp(played.outcome);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return stamp(remember(library, workflow, "failed", reason, workflow.steps[0]?.id || id, inputs));
  }
}

/** The scripted proof signs in on the held page. Resume then continues that same run. */
export async function withHeldPage(token: string, run: (page: Page) => Promise<void>): Promise<void> {
  const live = liveRuns.get(token);
  if (!live) throw new Error("resume token");
  await run(live.page);
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
  const recorded = await remoteFetch<{ ok?: boolean }>(
    state,
    "POST",
    `/api/workflows/${encodeURIComponent(id)}/review`,
    {
      documentHash,
      shots: outcome.runId ? redactedStepShots(library, replayDoc, outcome.runId) : [],
      samples: publicSamples(inputs),
    },
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

function redactedStepShots(library: Library, workflow: WorkflowV2, runId: string): { stepId: string; png: string; redacted: true }[] {
  const dir = path.join(library.root, "shots", "runs", runId);
  const secrets = new Set((workflow.inputs || []).filter((input) => input.type === "secret").map((input) => input.name));
  const shots: { stepId: string; png: string; redacted: true }[] = [];
  for (const step of workflow.steps) {
    if (step.sensitive || (step.input && secrets.has(step.input))) continue;
    const after = path.join(dir, shotFile(step.id, "after"));
    const before = path.join(dir, shotFile(step.id, "before"));
    const file = existsSync(after) ? after : before;
    if (!existsSync(file)) continue;
    const png = readFileSync(file);
    if (png.length < 32 || png[0] !== 0x89 || png[1] !== 0x50) continue;
    shots.push({ stepId: step.id, png: png.toString("base64"), redacted: true });
  }
  return shots;
}

export function getRun(library: Library, runId: string): WorkflowOutcome {
  const file = reportPath(library, runId);
  if (!existsSync(file)) throw new Error("run not found");
  return JSON.parse(readFileSync(file, "utf8")) as WorkflowOutcome;
}

interface LiveRun {
  token: string;
  context: BrowserContext;
  page: Page;
  profile: string;
  video: { path(): Promise<string> } | null;
  runId: string;
  shotDir: string;
  workflow: WorkflowV2;
  inputs: ReplayArgs;
  secrets: string[];
  trail: RunTrailEvent[];
  steps: RunResult["steps"];
  stepId: string;
  kind: "signin" | "confirm";
  deadline: number | null;
  ask: string;
}

const liveRuns = new Map<string, LiveRun>();

async function replayInBrowser(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  secrets: string[],
): Promise<{ run: RunResult; outcome: WorkflowOutcome; held: boolean; clip?: { video: string; videoStartedAt: number } }> {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const shotDir = path.join(library.root, "shots", "runs", runId);
  const windowVideo = process.platform === "darwin" && process.env.BAO_HEADED === "1";
  const record = !windowVideo && process.env.BAO_RUN_VIDEO === "1";
  const videoDir = record ? path.join(library.root, "videos", "incoming") : undefined;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
    videoDir,
  });
  const page = context.pages()[0] || await context.newPage();
  const video = record ? page.video() : null;
  const videoStartedAt = Date.now();
  const owned = windowVideo
    ? await openReplayVideo(pidsForDataDir(profile), path.join(library.root, "videos", `${runId}.webm`))
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
      await page.goto(workflow.startUrl, { waitUntil: "domcontentloaded" });
    }
    const trail: RunTrailEvent[] = [];
    const driver = new BrowserDriver(page);
    const run = await replay(workflow, args, driver, {
      runId,
      shotDir,
      settings: library.settings(),
      heal: healProvider(),
      now: () => Date.now(),
      yieldHuman: true,
      trail,
      siteTrust: trustMode(library.settings(), originOf(workflow.startUrl)),
    });
    const outcome = rememberRun(library, workflow, run, args, secrets);
    if (run.status === "paused" && run.pausedKind && run.ask && outcome.resume) {
      hold = true;
      const live: LiveRun = {
        token: outcome.resume,
        context,
        page,
        profile,
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
      };
      liveRuns.set(outcome.resume, live);
      await finishVideo();
      saveWorkflowRun(library, workflow, run, args, outcome, clip);
      return { run, outcome, held: true, clip };
    }
    await finishVideo();
    return { run, outcome, held: false, clip };
  } finally {
    await finishVideo();
    if (!hold) await releaseBrowser(library, { context, video, profile, runId });
  }
}

async function continueLive(library: Library, live: LiveRun, extra: ReplayArgs): Promise<WorkflowOutcome> {
  live.inputs = { ...live.inputs, ...extra };
  const run = await replay(live.workflow, live.inputs, new BrowserDriver(live.page), {
    runId: live.runId,
    shotDir: live.shotDir,
    settings: library.settings(),
    heal: healProvider(),
    now: () => Date.now(),
    fromStepId: live.stepId,
    yieldHuman: true,
    humanReady: true,
    trail: live.trail,
  });
  if (run.status === "paused" && run.pausedKind && run.ask) {
    live.stepId = run.pausedStepId || run.ask.stepId;
    live.kind = run.pausedKind;
    live.deadline = run.ask.deadline;
    live.ask = run.ask.instruction;
    live.trail = run.trail;
    live.steps = run.steps;
    const outcome = rememberRun(library, live.workflow, run, live.inputs, live.secrets, live.token);
    saveWorkflowRun(library, live.workflow, run, live.inputs, outcome);
    return outcome;
  }
  liveRuns.delete(live.token);
  dropResume(library, live.token);
  await releaseBrowser(library, live);
  library.savePublicInputs(live.workflow.id, publicInputs(live.workflow, live.inputs));
  const outcome = rememberRun(library, live.workflow, run, live.inputs, live.secrets);
  if (run.status === "passed") outcome.status = "completed";
  saveWorkflowRun(library, live.workflow, run, live.inputs, outcome);
  return storeOutcome(library, outcome, live.secrets);
}

async function cancelWorkflow(library: Library, token: string): Promise<WorkflowOutcome> {
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
  return stopLive(library, live, "stopped", "nothing applied");
}

async function stopLive(library: Library, live: LiveRun, status: "timed-out" | "stopped", reason: string): Promise<WorkflowOutcome> {
  liveRuns.delete(live.token);
  dropResume(library, live.token);
  await releaseBrowser(library, live);
  const result = baseOutcome(live.workflow, undefined, "failed", reason, live.stepId, live.inputs);
  result.runId = live.runId;
  result.run_id = live.runId;
  result.status = status;
  result.step = live.stepId;
  result.ask = live.ask;
  result.reason = reason;
  result.deadline = live.deadline ? formatClock(live.deadline) : "No timeout";
  library.saveRun({
    id: live.runId,
    workflowId: live.workflow.id,
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
  return storeOutcome(library, result, live.secrets);
}

async function releaseBrowser(
  library: Library,
  open: { context: BrowserContext; video: { path(): Promise<string> } | null; profile: string; runId: string },
): Promise<void> {
  await open.context.close().catch(() => undefined);
  if (open.video) {
    const src = await open.video.path().catch(() => "");
    if (src && existsSync(src)) {
      const dest = path.join(library.root, "videos", `${open.runId}.webm`);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
  await rm(open.profile, { recursive: true, force: true }).catch(() => undefined);
}

function rememberRun(
  library: Library,
  workflow: WorkflowV2,
  run: RunResult,
  inputs: ReplayArgs,
  secrets: string[],
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
  } else if (run.status === "paused") {
    outcome = "needs_human";
    status = "needs_human";
    reason = run.steps.some((step) => step.reason === "always ask")
      ? "Always ask before this step."
      : "Approve the heal before the run can continue";
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
  if (outcome !== "ok") {
    result.resume = resumeToken || writeResume(library, workflow.id, publicInputs(workflow, inputs), stepId, {
      kind: run.pausedKind,
      deadline: run.ask?.deadline ?? null,
      ask: run.ask?.instruction,
      runId: run.runId,
    });
    result.resume_token = result.resume;
  }
  return storeOutcome(library, result, secrets);
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
  library.saveRun({
    id: run.runId,
    workflowId: workflow.id,
    status: paused ? "paused" : outcome.status === "completed" ? "passed" : run.status,
    at: Date.now(),
    heals: run.heals,
    failure: run.failure,
    steps: run.steps,
    modelCalls: run.modelCalls,
    trail: run.trail,
    inputs: Object.fromEntries(Object.entries(publicInputs(workflow, inputs)).map(([key, value]) => [key, String(value)])),
    envelope: outcome.status && outcome.status !== "ok" ? {
      status: outcome.status,
      run_id: outcome.run_id || run.runId,
      step: outcome.step,
      reason: outcome.reason,
      ask: outcome.ask,
      deadline: outcome.deadline,
      resume_token: outcome.resume_token,
    } : undefined,
    ...(clip ?? {}),
  });
}

function remember(
  library: Library,
  workflow: WorkflowV2,
  outcome: OutcomeName,
  reason: string,
  stepId: string,
  inputs: ReplayArgs,
): WorkflowOutcome {
  const result = baseOutcome(workflow, undefined, outcome, reason, stepId, inputs);
  result.runId = result.runId || `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const deadline = library.settings().actTimeoutMs > 0 ? Date.now() + library.settings().actTimeoutMs : null;
  result.resume = writeResume(library, workflow.id, publicInputs(workflow, inputs), stepId, {
    kind: "input",
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
  return storeOutcome(library, result, secretStrings(workflow, inputs));
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
  };
}

function readBack(step: WorkflowStep, status: string, inputs: ReplayArgs): string {
  if (status === "pending") return "";
  if (step.sensitive) return "[secret]";
  const input = step.input ? inputs[step.input] : undefined;
  if (typeof input === "string" && step.sensitive) return "[secret]";
  if (step.postcondition?.match) return expectedText(step.postcondition.match, inputs);
  if (step.value?.includes("{{")) return expectedText(step.value, inputs);
  return step.label;
}

function missingHuman(workflow: WorkflowV2, inputs: ReplayArgs): { stepId: string; reason: string } | null {
  for (const input of workflow.inputs) {
    if (input.required === false) continue;
    const value = inputs[input.name];
    const empty = value === undefined || value === "";
    if (!empty) continue;
    if (input.type === "secret") return { stepId: input.name, reason: `Enter ${input.label || input.name} on this device` };
    if (input.type === "file") return { stepId: input.name, reason: `Choose ${input.label || input.name} on this device` };
  }
  return null;
}

function signInStep(step: WorkflowStep | undefined): boolean {
  if (!step) return false;
  return SIGN_IN.test(`${step.id} ${step.label} ${step.input || ""}`) || step.sensitive === true;
}

function inputSchema(doc: { inputs?: WorkflowV2["inputs"] }): InputField[] {
  return (doc.inputs ?? []).map((input) => ({
    name: input.name,
    type: input.type,
    label: input.label || input.name,
    required: input.required !== false,
    choices: input.choices,
  }));
}

function stripSecretDefaults(doc: WorkflowV2): WorkflowV2 {
  const copy = structuredClone(doc);
  for (const input of copy.inputs) {
    if (input.type === "secret") delete input.default;
  }
  return copy;
}

function publicInputs(workflow: WorkflowV2, inputs: ReplayArgs): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file") continue;
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

function storeOutcome(library: Library, outcome: WorkflowOutcome, secrets: string[]): WorkflowOutcome {
  let json = JSON.stringify(outcome);
  for (const secret of secrets) json = json.split(secret).join("[secret]");
  const parsed = JSON.parse(json) as WorkflowOutcome;
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
  stepId: string;
  publicInputs: Record<string, string | number>;
  kind?: "signin" | "confirm" | "input";
  deadline?: number | null;
  ask?: string;
  runId?: string;
}

function writeResume(
  library: Library,
  workflowId: string,
  inputs: Record<string, string | number>,
  stepId: string,
  extra: { kind?: ResumeFile["kind"]; deadline?: number | null; ask?: string; runId?: string } = {},
): string {
  const token = `r_${randomBytes(16).toString("hex")}`;
  const file = path.join(library.root, "resumes", `${token}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  const body: ResumeFile = { workflowId, stepId, publicInputs: inputs, ...extra };
  writeFileSync(file, JSON.stringify(body));
  return token;
}

function peekResume(library: Library, token: string): ResumeFile | undefined {
  const file = resumePath(library, token);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as ResumeFile;
}

function dropResume(library: Library, token: string): void {
  rmSync(resumePath(library, token), { force: true });
}

function takeResume(library: Library, token: string): { workflowId: string; publicInputs: Record<string, string | number> } {
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
    if (run.status !== "passed" && run.status !== "ok") continue;
    if (run.at > latest) latest = run.at;
  }
  return latest || undefined;
}

function latestGreen(...values: unknown[]): number | undefined {
  let best = 0;
  for (const value of values) {
    const at = epoch(value);
    if (at > best) best = at;
  }
  return best || undefined;
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

function materializeWorkflow(library: Library, found: Located): void {
  const doc = migrate(found.document);
  library.save(doc);
  if (!found.version) return;
  const state = loadState(library.root);
  state.workflows[doc.id] = {
    version: found.version,
    hash: createHash("sha256").update(toJson(doc)).digest("hex"),
  };
  saveState(library.root, state);
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

async function remoteHits(library: Library, query: string, filters: { source?: string; site?: string; category?: string }): Promise<DraftHit[]> {
  const state = loadState(library.root);
  if (!state.server || !state.deviceToken) return [];
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filters.source) params.set("source", filters.source);
  if (filters.site) params.set("site", filters.site);
  if (filters.category) params.set("category", filters.category);
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

async function marketplaceAccess(
  library: Library,
  id: string,
  document: WorkflowV2,
): Promise<{ allowed: boolean; preview: PermissionPreview }> {
  const state = loadState(library.root);
  let remote: { allowed?: boolean; preview?: PermissionPreview } | null = null;
  try {
    remote = await remoteFetch<{ allowed?: boolean; preview?: PermissionPreview }>(
      state,
      "GET",
      `/api/marketplace/${encodeURIComponent(id)}/allow`,
    );
  } catch {
    remote = null;
  }
  const preview = remote?.preview || permissionPreview(document);
  if (remote?.allowed) {
    writeAllow(library, id);
    return { allowed: true, preview };
  }
  if (remote && remote.allowed === false) return { allowed: false, preview };
  if (hasAllow(library, id)) return { allowed: true, preview };
  return { allowed: false, preview };
}

function rememberListingTrust(library: Library, preview: PermissionPreview): void {
  if (preview.trust !== "ask") return;
  const siteTrust = { ...(library.settings().siteTrust || {}) };
  let changed = false;
  for (const site of preview.sites) {
    if (siteTrust[site] === "ask") continue;
    siteTrust[site] = "ask";
    changed = true;
  }
  if (changed) library.updateSettings({ siteTrust });
}

function allowFile(library: Library, id: string): string {
  return path.join(library.root, "allows", `${safeToken(id)}.json`);
}

function hasAllow(library: Library, id: string): boolean {
  try {
    return existsSync(allowFile(library, id));
  } catch {
    return false;
  }
}

function writeAllow(library: Library, id: string): void {
  const file = allowFile(library, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id, at: Date.now() }));
}

function linkFor(id: string): string {
  return `bao://workflow/${id}`;
}

function safeToken(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("bad id");
  return value;
}
