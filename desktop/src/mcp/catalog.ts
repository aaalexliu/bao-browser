// Search, describe, and run. The MCP server exposes these four operations
// and does not add a tool per workflow.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import type { RunTrailEvent } from "../v1/apply-guard";
import { BrowserDriver } from "../v1/browser-driver";
import { llmHealFromEnv, scriptedHeal, type HealProvider } from "../v1/heal";
import { TIMED_OUT, TIMED_OUT_STATUS } from "../v1/pending-prompt";
import { expectedText, replay, type RunResult } from "../v1/replay";
import { formatClock } from "../v1/time";
import { migrate, type ReplayArgs, type WorkflowStep, type WorkflowV2 } from "../v1/schema";
import { shotFile } from "../v1/shots";
import { Library } from "../v1/store";
import { loadState, type SyncState } from "../v1/sync";
import { prepareImport, publicSamples } from "../../../web/src/lib/import-sheet";
import { categoryFor, domainsOf, releaseHash, summaryOf } from "../../../web/src/lib/publish";
import { rankHits, SEARCH_LIMIT } from "../../../web/src/lib/rank";

export type OutcomeName = "ok" | "needs_human" | "needs_signin" | "failed";

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
  source: "mine" | "team" | "public";
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

export async function searchWorkflows(
  library: Library,
  query: string,
  filters: { source?: string; site?: string; category?: string } = {},
): Promise<SearchHit[]> {
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
  }));
  const rankedLocal = rankHits(local, query, filters);
  const remote = await remoteHits(library, query, filters);
  const byId = new Map<string, SearchHit>();
  for (const hit of [...rankedLocal, ...remote]) {
    const prev = byId.get(hit.id);
    if (!prev || hit.source === "mine" || hit.score > prev.score) {
      byId.set(hit.id, {
        id: hit.id,
        title: hit.title,
        summary: hit.summary,
        site: hit.site,
        category: hit.category,
        source: hit.source,
        score: hit.score,
        inputs: hit.inputs,
        link: hit.link || linkFor(hit.id),
      });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, SEARCH_LIMIT);
}

export async function describeWorkflow(library: Library, id: string, auth?: RemoteAuth): Promise<{
  workflow: WorkflowV2;
  inputs: InputField[];
  link: string;
  importLink: string;
  source: "mine" | "team" | "public";
}> {
  const found = await loadWorkflow(library, id, auth);
  const workflow = stripSecretDefaults(found.document);
  return { workflow, inputs: inputSchema(workflow), link: linkFor(id), importLink: `bao://import/${id}`, source: found.source };
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
  const loaded = request.document ? migrate(request.document) : (await loadWorkflow(library, id, auth)).document;
  const workflow = request.startUrl ? { ...loaded, startUrl: request.startUrl } : loaded;
  const inputs: ReplayArgs = {
    ...(request.rerun || resumed ? library.readPublicInputs(id) : {}),
    ...(resumed?.publicInputs ?? {}),
    ...(request.inputs ?? {}),
  };
  const missing = missingHuman(workflow, inputs);
  if (missing) return remember(library, workflow, "needs_human", missing.reason, missing.stepId, inputs);
  const secrets = secretStrings(workflow, inputs);
  try {
    const played = await replayInBrowser(library, workflow, inputs, secrets);
    if (played.held) return played.outcome;
    library.savePublicInputs(id, publicInputs(workflow, inputs));
    saveWorkflowRun(library, workflow, played.run, inputs, played.outcome);
    return played.outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return remember(library, workflow, "failed", reason, workflow.steps[0]?.id || id, inputs);
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
  const found = await loadWorkflow(library, id, opts);
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
): Promise<{ run: RunResult; outcome: WorkflowOutcome; held: boolean }> {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const shotDir = path.join(library.root, "shots", "runs", runId);
  const record = process.env.BAO_RUN_VIDEO === "1";
  const videoDir = record ? path.join(library.root, "videos", "incoming") : undefined;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
    videoDir,
  });
  const page = context.pages()[0] || await context.newPage();
  const video = record ? page.video() : null;
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
      saveWorkflowRun(library, workflow, run, args, outcome);
      return { run, outcome, held: true };
    }
    return { run, outcome, held: false };
  } finally {
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

function saveWorkflowRun(library: Library, workflow: WorkflowV2, run: RunResult, inputs: ReplayArgs, outcome: WorkflowOutcome): void {
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

async function loadWorkflow(library: Library, id: string, auth?: RemoteAuth): Promise<{ document: WorkflowV2; source: "mine" | "team" | "public" }> {
  try {
    return { document: library.read(id), source: "mine" };
  } catch {
    /* not on this Mac */
  }
  const state = loadState(library.root);
  const owned = await remoteFetch<{ document?: unknown }>(state, "GET", `/api/workflows/${encodeURIComponent(id)}`, undefined, auth);
  if (owned?.document) return { document: migrate(owned.document), source: "mine" };
  const pub = await remoteFetch<{ document?: unknown }>(state, "GET", `/api/marketplace/${encodeURIComponent(id)}`, undefined, auth);
  if (pub?.document) return { document: migrate(pub.document), source: "public" };
  throw new Error("workflow not found");
}

async function remoteHits(library: Library, query: string, filters: { source?: string; site?: string; category?: string }): Promise<SearchHit[]> {
  const state = loadState(library.root);
  if (!state.server || !state.deviceToken) return [];
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filters.source) params.set("source", filters.source);
  if (filters.site) params.set("site", filters.site);
  if (filters.category) params.set("category", filters.category);
  const body = await remoteFetch<{ hits?: SearchHit[] }>(state, "GET", `/api/catalog?${params.toString()}`);
  return (body?.hits ?? []).map((hit) => ({ ...hit, link: hit.link || linkFor(hit.id), inputs: hit.inputs ?? [] }));
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
