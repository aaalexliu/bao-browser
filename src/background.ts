// Bao M0 — service worker.
// The record/replay core lives in content.ts (one instance per frame, since the
// manifest injects with all_frames). This worker's job for cross-origin frames:
//  1) collect each frame's recorded steps (a parent content script can't read a
//     cross-origin child's DOM, but every frame can message the SW), and
//  2) at replay, route each step to the live frame it was recorded in — resolving
//     the recorded FrameRef (origin/url) to a current frameId via webNavigation.

import type { FrameRef, Msg, RecState, ReplayResponse, RunRecord, RunState, Step, StepResult, Value, Workflow, WorkflowSummary } from "./types";

// The SW's harness-visible API: the e2e tests drive these via sw.evaluate, so they
// must live on the worker global under exactly these names.
declare global {
  var __baoSteps: Step[];
  var baoRecStart: (tabId: number) => Promise<{ ok: boolean }>;
  var baoRecStop: () => Promise<{ steps: Step[]; workflow: WorkflowSummary | null }>;
  var baoRunStart: (tabId: number, steps: Step[], meta?: RunMeta) => Promise<{ ok: boolean; runId: string }>;
  var baoRunStatus: () => Promise<RunState | null>;
  var baoRunContinue: () => Promise<{ ok: boolean }>;
  var baoDrainSteps: () => Step[];
  var baoSetForceOpen: (on: boolean) => Promise<{ ok: boolean; on?: boolean; error?: string }>;
  var baoReplayAcrossFrames: (tabId: number, steps: Step[]) => Promise<ReplayResponse>;
  var __baoRecentDownloads: { id: number; filename: string; ts: number }[];
  var baoGetGolden: (ref: string) => Promise<{ type: string; size: number; width: number; height: number } | null>;
  var baoSaveWorkflow: (name: string, startUrl: string, steps: Step[]) => Promise<{ ok: boolean; id: string }>;
  var baoListWorkflows: () => Promise<WorkflowSummary[]>;
  var baoDeleteWorkflow: (id: string) => Promise<{ ok: boolean }>;
  var baoRunWorkflow: (tabId: number, id: string, inputs?: Record<string, Value>) => Promise<{ ok: boolean; runId?: string; error?: string }>;
  var baoGetWorkflow: (id: string) => Promise<Workflow | null>;
  var baoUpdateWorkflow: (id: string, patch: { name?: string; pinned?: boolean }) => Promise<{ ok: boolean }>;
  var baoUpdateWorkflowSteps: (id: string, steps: Step[]) => Promise<{ ok: boolean; error?: string }>;
  var baoImportWorkflow: (workflow: Workflow) => Promise<{ ok: boolean; id: string }>;
  // T16 run history
  var baoListRuns: (workflowId?: string) => Promise<RunRecord[]>;
  var baoGetRun: (id: string) => Promise<RunRecord | null>;
  var baoDeleteRun: (id: string) => Promise<{ ok: boolean }>;
  var baoClearRuns: (workflowId?: string) => Promise<{ ok: boolean }>;
}

// Workflow identity carried into a run so its history record can be attributed.
// `inputs` seeds the M4 variable bindings (the prompted `kind:"input"` variables).
type RunMeta = { workflowId?: string; workflowName?: string; startUrl?: string; inputs?: Record<string, Value> };

chrome.runtime.onInstalled.addListener(() => {
  console.log("[bao-m0] service worker installed");
  migrateLegacy(); // import a pre-T14 recording as "Untitled workflow", once
});

// T15: the toolbar icon toggles the side panel — declarative, no action.onClicked
// listener (chrome.sidePanel.open() would need a user gesture anyway). Top-level so
// it re-arms on every SW wake.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("[bao-t15]", e));

// Cross-frame recording buffer. The e2e harness resets it before a run and reads it
// after, so it lives on `self` (the SW global) rather than in chrome.storage for M0.
self.__baoSteps = self.__baoSteps || [];

chrome.runtime.onMessage.addListener((msg: Msg | undefined, sender, sendResponse) => {
  if (!msg) return;
  if (msg.cmd === "bao-reset") { self.__baoSteps = []; return; }
  if (msg.cmd === "bao-frame-steps" && Array.isArray(msg.steps)) {
    // sender.frameId / sender.url are authoritative (the content script can lie about
    // neither); merge them onto the frame ref the content script reported.
    for (const step of msg.steps) {
      self.__baoSteps.push({
        ...step,
        frame: { ...(step.frame || {}), frameId: sender.frameId, url: sender.url, top: sender.frameId === 0 },
      });
    }
    return;
  }
  // ---- M1 messages (recording stream, boot handshake, panel controls) ----
  if (msg.cmd === "bao-step" && msg.step) { onRecStep(msg.step, sender); return; }
  if (msg.cmd === "bao-boot") { onBoot(sender).then(sendResponse); return true; }
  if (msg.cmd === "bao-rec-start") { baoRecStart(msg.tabId).then(sendResponse); return true; }
  if (msg.cmd === "bao-rec-stop") { baoRecStop().then(sendResponse); return true; }
  if (msg.cmd === "bao-run-start") { baoRunStart(msg.tabId, msg.steps).then(sendResponse); return true; }
  if (msg.cmd === "bao-run-status") { getRun().then(sendResponse); return true; }
  if (msg.cmd === "bao-run-continue") { baoRunContinue().then(sendResponse); return true; }
  // ---- named workflows (T14) ----
  if (msg.cmd === "bao-wf-save") { baoSaveWorkflow(msg.name, msg.startUrl, msg.steps).then(sendResponse); return true; }
  if (msg.cmd === "bao-wf-list") { baoListWorkflows().then(sendResponse); return true; }
  if (msg.cmd === "bao-wf-delete") { baoDeleteWorkflow(msg.id).then(sendResponse); return true; }
  if (msg.cmd === "bao-wf-run") { baoRunWorkflow(msg.tabId, msg.id, msg.inputs).then(sendResponse); return true; }
  // ---- side panel (T15) ----
  if (msg.cmd === "bao-wf-get") { baoGetWorkflow(msg.id).then(sendResponse); return true; }
  if (msg.cmd === "bao-wf-update") { baoUpdateWorkflow(msg.id, msg.patch).then(sendResponse); return true; }
  if (msg.cmd === "bao-wf-import") { baoImportWorkflow(msg.workflow).then(sendResponse); return true; }
  // ---- full-page dashboard (T16) ----
  if (msg.cmd === "bao-wf-update-steps") { baoUpdateWorkflowSteps(msg.id, msg.steps).then(sendResponse); return true; }
  if (msg.cmd === "bao-runs-list") { baoListRuns(msg.workflowId).then(sendResponse); return true; }
  if (msg.cmd === "bao-run-get") { baoGetRun(msg.id).then(sendResponse); return true; }
  if (msg.cmd === "bao-run-delete") { baoDeleteRun(msg.id).then(sendResponse); return true; }
  if (msg.cmd === "bao-runs-clear") { baoClearRuns(msg.workflowId).then(sendResponse); return true; }
});

// ============================ M1 — cross-navigation ============================
// Every full-document navigation destroys the content script, and MV3 kills this
// worker whenever it likes. So neither holds state: the recording trace lives in
// chrome.storage.session and the replay RunState in chrome.storage.local; both the
// SW and the content script rehydrate from storage on every wake (m1-design §0).
const REC_KEY = "baoRec";
const RUN_KEY = "baoRun";
const NAV_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const basename = (p: string) => (p || "").split(/[\\/]/).pop() || "";
// The download's identity is its URL's last path segment (e.g. "report.csv"), NOT the
// on-disk filename — the latter is environment-specific (a random UUID under a managed
// downloads dir, "report (1).csv" on a name collision) and differs record-vs-replay.
const downloadName = (item: { finalUrl?: string; url?: string }) => {
  try { return basename(new URL(item.finalUrl || item.url || "").pathname); } catch { return ""; }
};
// A download that completed can beat the tick that transitions us into
// awaiting_download (click → download → complete, all within one SW turn). Keep the
// most-recent completions in SW memory so that transition can catch an already-done
// one. SW death loses this, but so does the in-flight download — the watchdog fails
// such a run honestly rather than hanging.
self.__baoRecentDownloads = self.__baoRecentDownloads || [];
const noteDownloadDone = (id: number, filename: string) => {
  self.__baoRecentDownloads.push({ id, filename, ts: Date.now() });
  if (self.__baoRecentDownloads.length > 20) self.__baoRecentDownloads.shift();
};

// All state transitions are read-modify-write on storage; serialize them so two
// events (boot ping + onCompleted, say) can't interleave and double-advance.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch((e) => console.warn("[bao-m1]", e));
  return p;
}

const getRec = async (): Promise<RecState | null> =>
  ((await chrome.storage.session.get(REC_KEY))[REC_KEY] as RecState | undefined) || null;
const setRec = (rec: RecState | null) =>
  rec ? chrome.storage.session.set({ [REC_KEY]: rec }) : chrome.storage.session.remove(REC_KEY);
const getRun = async (): Promise<RunState | null> =>
  ((await chrome.storage.local.get(RUN_KEY))[RUN_KEY] as RunState | undefined) || null;
const setRun = (run: RunState | null) =>
  run ? chrome.storage.local.set({ [RUN_KEY]: run }) : chrome.storage.local.remove(RUN_KEY);

// Record-time id ≠ replay-time id: wildcard digit runs when matching URLs (same
// normalization the T7 soft-nav markers use).
function urlMatches(pattern: string, url: string): boolean {
  try { return new RegExp(`^${pattern}$`).test(url); } catch (_) { return false; }
}
const urlPatternOf = (u: string) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+");

// ---- M4: {{variable}} substitution ----
// The entire runtime cost of parameterization: resolve `{{name}}` refs against the
// run's bindings on the string fields a step dispatches (value / url / urlPattern),
// immediately before it runs. Returns the step unchanged when nothing to do, so the
// persisted template (run.steps) is preserved for history and loop re-dispatch — the
// resolved copy is ephemeral. A ref with no binding is left verbatim, so a mis-templated
// step fails visibly at the target instead of silently blanking a field.
const TEMPLATE = /\{\{\s*([\w.$]+)\s*\}\}/g;
const subst = (s: string, bindings: Record<string, Value>): string =>
  s.replace(TEMPLATE, (m, name) => (name in bindings ? String(bindings[name]) : m));
function resolveStep(step: Step, bindings: Record<string, Value>): Step {
  if (!bindings || !Object.keys(bindings).length) return step;
  let out = step;
  for (const k of ["value", "url", "urlPattern"] as const) {
    const v = step[k];
    if (typeof v === "string" && v.includes("{{")) {
      if (out === step) out = { ...step };
      out[k] = subst(v, bindings);
    }
  }
  return out;
}

// ---- recording across navigations (T8 phase 1) ----
self.baoRecStart = async (tabId) => {
  await setRec({ tabId, steps: [] });
  // Arm content scripts already alive in the tab; documents created later re-arm
  // themselves via the boot handshake.
  try { await chrome.tabs.sendMessage(tabId, { cmd: "start-record" }); } catch (_) {}
  return { ok: true };
};
// Stop auto-saves (T15): the captured trace used to be returned and hoped-saved by
// the (now-deleted) popup, which lost it the moment the popup closed. Now a
// non-empty recording becomes a persisted Workflow right here; the panel renames
// it afterwards.
self.baoRecStop = async () => {
  const rec = await getRec();
  await setRec(null);
  if (!rec) return { steps: [], workflow: null };
  try { await chrome.tabs.sendMessage(rec.tabId, { cmd: "stop-record" }); } catch (_) {}
  const steps = rec.steps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (!steps.length) return { steps, workflow: null };
  const startUrl = steps.find((s) => s.frame?.url)?.frame?.url || "";
  const wf = makeWorkflow(autoName(startUrl), startUrl, steps);
  await putWorkflow(wf);
  return { steps, workflow: summarize(wf) };
};
function onRecStep(step: Step, sender: chrome.runtime.MessageSender): void {
  enqueue(async () => {
    const rec = await getRec();
    if (!rec || !sender.tab || sender.tab.id !== rec.tabId) return;
    const merged: Step = {
      ...step,
      frame: { ...(step.frame || {}), frameId: sender.frameId, url: sender.url, top: sender.frameId === 0 },
    };
    const i = rec.steps.findIndex((s) => s.seq === step.seq);
    if (i >= 0) rec.steps[i] = merged; else rec.steps.push(merged);
    await setRec(rec);
    // T12: grab a golden frame for element steps (markers have no visual target).
    // T1: skip sensitive steps — the secret is often on-screen (SSN/card in a plain
    // field), and a full-viewport screenshot would recapture what we just withheld.
    if (merged.target && merged.seq && !merged.sensitive) scheduleGolden(rec.tabId, merged.seq);
  });
}

// ---- replay across navigations (T8 phase 2): the RunState machine ----
// phases: executing → (navigate step) awaiting_nav → executing … → done | failed,
// with paused_for_user as the resumable pause (T8 phase 3). Event-driven only:
// element waits live in the content script, navigation waits on webNavigation,
// timeouts on chrome.alarms — never a long timer in here.
self.baoRunStart = async (tabId, steps, meta) => {
  const run: RunState = {
    runId: "run-" + Math.random().toString(36).slice(2, 10), tabId, steps,
    stepIndex: 0, phase: "executing", dispatched: false, results: [], lastError: null,
    bindings: meta?.inputs || {},
    startedAt: Date.now(),
    workflowId: meta?.workflowId, workflowName: meta?.workflowName, startUrl: meta?.startUrl,
  };
  runFrames.set(run.runId, new Set()); // fresh per-step screenshot buffer (T16)
  await setRun(run);
  tick();
  return { ok: true, runId: run.runId };
};
self.baoRunStatus = getRun;
self.baoRunContinue = async () => {
  const resumed = await enqueue(async () => {
    const run = await getRun();
    if (!run || run.phase !== "paused_for_user") return false;
    run.results.push({ i: run.stepIndex, ok: true, via: "waitForUser (user continued)" });
    run.stepIndex++; run.phase = "executing";
    await setRun(run);
    return true;
  });
  if (resumed) tick();
  return { ok: resumed };
};

// ============================ T14 — named workflows ============================
// A recording becomes a first-class Workflow {id,name,version,startUrl,variables,steps}
// instead of an anonymous `steps` array. Stored as an id→Workflow map under one local
// key; the pre-T14 single-recording `steps` key migrates once as "Untitled workflow".
const WF_KEY = "baoWorkflows";
const LEGACY_STEPS_KEY = "steps";

async function getWorkflows(): Promise<Record<string, Workflow>> {
  return ((await chrome.storage.local.get(WF_KEY))[WF_KEY] as Record<string, Workflow> | undefined) || {};
}
function makeWorkflow(name: string, startUrl: string, steps: Step[]): Workflow {
  const id = "wf-" + Math.random().toString(36).slice(2, 10);
  return {
    id, name: name || "Untitled workflow", version: 1, startUrl, variables: [],
    steps: steps.map((s, i) => ({ ...s, id: s.id || `${id}-${i}`, index: i })),
    createdAt: Date.now(),
  };
}
function putWorkflow(wf: Workflow): Promise<void> {
  return enqueue(async () => {
    const all = await getWorkflows();
    all[wf.id] = wf;
    await chrome.storage.local.set({ [WF_KEY]: all });
  });
}
const summarize = (w: Workflow): WorkflowSummary => ({
  id: w.id, name: w.name, startUrl: w.startUrl, count: w.steps.length,
  createdAt: w.createdAt, pinned: w.pinned, updatedAt: w.updatedAt,
});
// T15 auto-save names: "{hostname} — {Mon D, h:mma}". No collision handling — ids
// are the identity, duplicate names are harmless.
function autoName(startUrl: string): string {
  const d = new Date();
  const time = `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}, ` +
    `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "am" : "pm"}`;
  let host = "";
  try { host = new URL(startUrl).hostname; } catch (_) {}
  return `${host || "Recording"} — ${time}`;
}
// One-time import of the pre-T14 recording. Idempotent: runs only while no workflows
// exist and clears the legacy key so it can't re-import.
async function migrateLegacy(): Promise<void> {
  await enqueue(async () => {
    const all = await getWorkflows();
    if (Object.keys(all).length) return;
    const legacy = (await chrome.storage.local.get(LEGACY_STEPS_KEY))[LEGACY_STEPS_KEY] as Step[] | undefined;
    if (!legacy || !legacy.length) return;
    const startUrl = legacy.find((s) => s.frame?.url)?.frame?.url || "";
    const wf = makeWorkflow("Untitled workflow", startUrl, legacy);
    all[wf.id] = wf;
    await chrome.storage.local.set({ [WF_KEY]: all });
    await chrome.storage.local.remove(LEGACY_STEPS_KEY);
  });
}

self.baoSaveWorkflow = async (name, startUrl, steps) => {
  const wf = makeWorkflow(name, startUrl, steps);
  await putWorkflow(wf);
  return { ok: true, id: wf.id };
};
self.baoGetWorkflow = async (id) => (await getWorkflows())[id] || null;
self.baoUpdateWorkflow = async (id, patch) => {
  const ok = await enqueue(async () => {
    const all = await getWorkflows();
    const wf = all[id];
    if (!wf) return false;
    if (typeof patch.name === "string" && patch.name.trim()) wf.name = patch.name.trim();
    if (typeof patch.pinned === "boolean") wf.pinned = patch.pinned;
    wf.updatedAt = Date.now();
    await chrome.storage.local.set({ [WF_KEY]: all });
    return true;
  });
  return { ok };
};
// T16 light editing: the only mutation that touches a workflow's steps. Deliberately
// narrow to protect the T14 IR invariants without reopening the M2 re-record story:
//  - ids are identity: the new list must be a SUBSET of existing step ids (delete +
//    reorder only) — no fabricated ids, no duplicates, no additions.
//  - index is position: re-derived 0..N-1 from the incoming order.
//  - field edits are whitelisted: only `value` (input/select) and `assert` may change;
//    action/target/selectors/frame are copied from the stored step, never the payload,
//    so the editor can't silently rewrite how a step resolves.
self.baoUpdateWorkflowSteps = async (id, incoming) => {
  return enqueue(async () => {
    const all = await getWorkflows();
    const wf = all[id];
    if (!wf) return { ok: false, error: "no such workflow" };
    const byId = new Map(wf.steps.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const rebuilt: Step[] = [];
    for (const inc of incoming) {
      const base = inc.id ? byId.get(inc.id) : undefined;
      if (!base) return { ok: false, error: `unknown step id: ${inc.id}` };
      if (seen.has(inc.id!)) return { ok: false, error: `duplicate step id: ${inc.id}` };
      seen.add(inc.id!);
      const merged: Step = { ...base }; // action/target/selectors/frame come from storage
      if ((base.action === "input" || base.action === "select") && typeof inc.value === "string") {
        merged.value = inc.value;
      }
      if (base.action === "assert" && inc.assert && typeof inc.assert.kind === "string") {
        merged.assert = { kind: inc.assert.kind, value: inc.assert.value };
      }
      rebuilt.push(merged);
    }
    rebuilt.forEach((s, i) => { s.index = i; });
    wf.steps = rebuilt;
    wf.version = (wf.version || 1) + 1;
    wf.updatedAt = Date.now();
    await chrome.storage.local.set({ [WF_KEY]: all });
    return { ok: true };
  });
};
// Import assigns a fresh id + createdAt (never trust/collide on the file's id —
// importing the same file twice yields two workflows) and strips pinned; step
// ids/indexes are re-derived from the new workflow id by makeWorkflow.
self.baoImportWorkflow = async (workflow) => {
  const steps = (workflow.steps || []).map((s) => { const { id: _i, index: _x, ...rest } = s; return rest as Step; });
  const wf = makeWorkflow(workflow.name, workflow.startUrl || "", steps);
  await putWorkflow(wf);
  return { ok: true, id: wf.id };
};
self.baoListWorkflows = async () => {
  await migrateLegacy();
  return Object.values(await getWorkflows())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(summarize);
};
self.baoDeleteWorkflow = async (id) => {
  await enqueue(async () => {
    const all = await getWorkflows();
    delete all[id];
    await chrome.storage.local.set({ [WF_KEY]: all });
  });
  return { ok: true };
};
self.baoRunWorkflow = async (tabId, id, inputs) => {
  const wf = (await getWorkflows())[id];
  if (!wf) return { ok: false, error: "no such workflow" };
  // Land on the workflow's start page first if the tab isn't already there.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (wf.startUrl && !urlMatches(urlPatternOf(wf.startUrl), tab.url || "")) {
      await navigateAndWait(tabId, wf.startUrl);
    }
  } catch (_) {}
  return baoRunStart(tabId, wf.steps, { workflowId: wf.id, workflowName: wf.name, startUrl: wf.startUrl, inputs });
};
// Drive a bare navigation and wait for the tab to settle on it (not part of the replay
// state machine — this is the pre-run "get to startUrl" hop).
async function navigateAndWait(tabId: number, url: string, timeout = 15_000): Promise<boolean> {
  await chrome.tabs.update(tabId, { url });
  const pattern = urlPatternOf(url);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === "complete" && urlMatches(pattern, t.url || "")) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function fail(run: RunState, reason: string): Promise<void> {
  run.phase = "failed";
  run.lastError = { stepIndex: run.stepIndex, reason };
  await setRun(run);
  await finalizeRun(run); // T16: persist the failed run for the history filmstrip
}

type TickTodo = { kind: "check-nav" } | { kind: "dispatch"; run: RunState; step: Step } | null;

// One turn of the machine. Reads state, acts on the current step, writes state.
// The actual dispatch (which can take seconds of in-page element waiting) happens
// OUTSIDE the serialized chain so wake events aren't blocked behind it.
async function tick(): Promise<void> {
  const todo = await enqueue<TickTodo>(async () => {
    const run = await getRun();
    if (!run || run.phase !== "executing") return null;
    if (run.stepIndex >= run.steps.length) {
      run.phase = "done"; await setRun(run); await finalizeRun(run); return null;
    }
    // Resolve {{variable}} refs against the run's bindings just before use; the raw
    // step in run.steps stays a template (history, loop re-dispatch).
    const step = resolveStep(run.steps[run.stepIndex], run.bindings);
    if (step.action === "navigate") {
      run.phase = "awaiting_nav";
      run.expectedNav = { pattern: urlPatternOf(step.url || ""), deadline: Date.now() + NAV_TIMEOUT_MS };
      await setRun(run);
      chrome.alarms.create("bao-run-watchdog", { when: Date.now() + NAV_TIMEOUT_MS });
      return { kind: "check-nav" }; // the nav may already have finished — check now
    }
    if (step.action === "waitForUser") {
      run.phase = "paused_for_user"; await setRun(run); return null;
    }
    run.dispatched = true; run.dispatchedAt = Date.now();
    await setRun(run);
    return { kind: "dispatch", run, step };
  });
  if (!todo) return;
  if (todo.kind === "check-nav") return maybeResumeAfterNav();

  const { run, step } = todo;
  let res: ReplayResponse | null = null;
  try {
    res = await chrome.tabs.sendMessage(run.tabId, { cmd: "replay", steps: [step] }, { frameId: 0 });
  } catch (_) { /* document torn down mid-step, or no content script yet */ }
  // T16: snapshot this step's resulting page while it's still on screen (before we
  // advance). null res means the document went away — nothing meaningful to capture.
  if (res) await captureRunFrame(run.runId, run.tabId, run.stepIndex);

  const proceed = await enqueue<"tick" | "await-download" | false>(async () => {
    const cur = await getRun();
    // The world may have moved while we were dispatching (SW respawn advanced the
    // run via boot ping). Only record a result if we're still on the same step.
    if (!cur || cur.runId !== run.runId || cur.stepIndex !== run.stepIndex || cur.phase !== "executing") return false;
    if (res && res.ok === true) {
      // The click fired; if it was tagged as producing a download (T10), don't advance
      // yet — park in awaiting_download until chrome.downloads reports completion.
      if (cur.steps[cur.stepIndex]?.download) {
        cur.phase = "awaiting_download";
        cur.expectedDownload = { deadline: Date.now() + DOWNLOAD_TIMEOUT_MS, filename: cur.steps[cur.stepIndex].download!.filename };
        await setRun(cur);
        chrome.alarms.create("bao-run-watchdog", { when: Date.now() + DOWNLOAD_TIMEOUT_MS });
        return "await-download";
      }
      // M4 extract: commit the value the content script read into the run's bindings,
      // so a later {{into}} ref resolves to it. The template step is untouched.
      const r0 = res.results?.[0];
      const tmpl = cur.steps[cur.stepIndex];
      if (tmpl?.action === "extract" && tmpl.extract && typeof r0?.extracted === "string") {
        cur.bindings = { ...cur.bindings, [tmpl.extract.into]: r0.extracted };
      }
      cur.results.push({ i: cur.stepIndex, ok: true, via: r0?.via, extracted: r0?.extracted });
      cur.stepIndex++; cur.dispatched = false;
      await setRun(cur);
      return "tick";
    }
    // No response and the trace says this click navigates (the next step is its
    // navigate marker): the port died because the document did — that IS success.
    const next = cur.steps[cur.stepIndex + 1];
    if (!res && next && next.action === "navigate") {
      cur.results.push({ i: cur.stepIndex, ok: true, via: "assumed-nav" });
      cur.stepIndex++; cur.dispatched = false;
      await setRun(cur);
      return "tick";
    }
    await fail(cur, res ? (res.results?.[0]?.reason || "step failed") : "content script unreachable");
    return false;
  });
  if (proceed === "tick") tick();
  else if (proceed === "await-download") maybeCompleteDownload(); // catch a completion that beat us here
}

// Resume out of awaiting_nav once the destination document exists AND answers —
// reached either from the boot ping (readyState complete) or from
// webNavigation.onCompleted, whichever lands; the phase check makes it idempotent.
async function maybeResumeAfterNav(): Promise<void> {
  const run = await getRun();
  if (!run || run.phase !== "awaiting_nav") return;
  let url: string;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    url = tab.url || "";
    if (!urlMatches(run.expectedNav!.pattern, url)) return;
    await chrome.tabs.sendMessage(run.tabId, { cmd: "status" }, { frameId: 0 });
    await captureRunFrame(run.runId, run.tabId, run.stepIndex); // T16: the nav step's landing page
  } catch (_) { return; } // not there yet — a later wake retries
  const resumed = await enqueue(async () => {
    const cur = await getRun();
    if (!cur || cur.phase !== "awaiting_nav") return false;
    cur.results.push({ i: cur.stepIndex, ok: true, via: "navigation", url });
    cur.stepIndex++; cur.phase = "executing"; cur.dispatched = false;
    delete cur.expectedNav;
    await setRun(cur);
    return true;
  });
  if (resumed) tick();
}

// Resume out of awaiting_download once a download reports state:complete — reached
// from chrome.downloads.onChanged, or from the dispatch tick catching a completion
// that finished before we transitioned (the recent-downloads buffer). The phase check
// makes it idempotent against both firing.
async function maybeCompleteDownload(done?: { id: number; filename: string }): Promise<void> {
  const run = await getRun();
  if (!run || run.phase !== "awaiting_download") return;
  // Prefer the completion we were handed; else the newest one seen since we dispatched.
  const hit = done || self.__baoRecentDownloads
    .filter((d) => d.ts >= (run.dispatchedAt || 0) - 500)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!hit) return; // not done yet — a later onChanged will call us again
  const got = basename(hit.filename);
  const want = run.expectedDownload?.filename ? basename(run.expectedDownload.filename) : "";
  // Chrome dedups filename collisions as "report (1).csv"; treat that as the same file.
  const canon = (n: string) => n.replace(/ \(\d+\)(\.[^.]*)?$/, "$1");
  const matched = !want || got === want || canon(got) === want;
  const advanced = await enqueue(async () => {
    const cur = await getRun();
    if (!cur || cur.phase !== "awaiting_download") return false;
    if (!matched) { await fail(cur, `download completed as "${got}", expected "${want}"`); return false; }
    cur.results.push({ i: cur.stepIndex, ok: true, via: "download", filename: got });
    cur.stepIndex++; cur.phase = "executing"; cur.dispatched = false;
    delete cur.expectedDownload;
    await setRun(cur);
    return true;
  });
  if (advanced) tick();
}

// Boot handshake from every fresh document (content.ts sends it at readyState
// complete). Recording: tell the new document to re-arm. Replay: this is the
// primary awaiting_nav wake, and the re-execution guard for the riskiest race —
// SW killed after dispatching a click, before its completion was recorded.
async function onBoot(sender: chrome.runtime.MessageSender): Promise<{ record?: boolean }> {
  if (!sender.tab) return {};
  const rec = await getRec();
  if (rec && sender.tab.id === rec.tabId) return { record: true };
  const run = await getRun();
  if (run && sender.tab.id === run.tabId && sender.frameId === 0) {
    if (run.phase === "awaiting_nav") maybeResumeAfterNav();
    else if (run.phase === "executing" && run.dispatched) {
      // Dispatched but never confirmed, and the document has since been replaced.
      // If the trace expected this step to navigate, treat it as completed.
      const advanced = await enqueue(async () => {
        const cur = await getRun();
        if (!cur || cur.phase !== "executing" || !cur.dispatched) return false;
        const next = cur.steps[cur.stepIndex + 1];
        const stepUrl = cur.steps[cur.stepIndex]?.frame?.url;
        if (next && next.action === "navigate" && sender.url !== stepUrl) {
          cur.results.push({ i: cur.stepIndex, ok: true, via: "assumed-nav (SW respawn)" });
          cur.stepIndex++; cur.dispatched = false;
          await setRun(cur);
          return true;
        }
        return false;
      });
      if (advanced) tick();
    }
  }
  return {};
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  // Recording: a full-document nav in the recorded tab becomes a navigate step the
  // replay state machine will wait on (the recorder itself dies with the document).
  const rec = await getRec();
  if (rec && d.tabId === rec.tabId) {
    enqueue(async () => {
      const cur = await getRec();
      if (!cur || d.tabId !== cur.tabId) return;
      cur.steps.push({
        action: "navigate", label: `Navigate to ${d.url}`, url: d.url,
        wait: { type: "navigation" }, ts: Date.now(), seq: `nav-${Date.now()}`,
        frame: { url: d.url, top: true },
      });
      await setRec(cur);
    });
  }
  // Replay: make sure the fresh document gets a content script early (the manifest
  // injects at document_idle anyway; this is belt-and-braces, and idempotent).
  const run = await getRun();
  if (run && d.tabId === run.tabId && !["done", "failed"].includes(run.phase)) {
    try { await chrome.scripting.executeScript({ target: { tabId: d.tabId }, files: ["dist/content.js"] }); } catch (_) {}
  }
});
chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) maybeResumeAfterNav();
});

// ---- downloads (T10): correlate at record, wait for completion at replay ----
chrome.downloads.onCreated.addListener((item) => {
  // Record: tag the click that just fired as download-producing. onCreated's filename
  // is often empty; the URL is enough for a first guess, backfilled on completion.
  getRec().then((rec) => {
    if (!rec) return;
    enqueue(async () => {
      const cur = await getRec();
      if (!cur) return;
      const now = Date.now();
      for (let i = cur.steps.length - 1; i >= 0; i--) {
        const s = cur.steps[i];
        if (now - (s.ts || 0) > 3000) break; // correlation window (m1-design §5.1)
        if (s.action === "click") {
          s.download = { id: item.id, filename: downloadName(item) || undefined };
          await setRec(cur);
          return;
        }
      }
    });
  });
});
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== "complete") return;
  chrome.downloads.search({ id: delta.id }).then((items) => {
    const filename = downloadName(items[0] || {});
    noteDownloadDone(delta.id, filename);
    // Record: backfill the now-known name onto the step tagged at onCreated (onCreated's
    // finalUrl can lag behind the original url).
    getRec().then((rec) => {
      if (!rec || !filename) return;
      enqueue(async () => {
        const cur = await getRec();
        const s = cur?.steps.find((st) => st.download?.id === delta.id);
        if (s) { s.download!.filename = filename; await setRec(cur!); }
      });
    });
    // Replay: advance if the run is parked waiting on this download.
    maybeCompleteDownload({ id: delta.id, filename });
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "bao-run-watchdog") return;
  await enqueue(async () => {
    const run = await getRun();
    if (run?.phase === "awaiting_nav") {
      if (Date.now() < (run.expectedNav?.deadline || 0)) return;
      await fail(run, `expected navigation to ${run.steps[run.stepIndex]?.url} never completed`);
    } else if (run?.phase === "awaiting_download") {
      if (Date.now() < (run.expectedDownload?.deadline || 0)) return;
      await fail(run, `expected download never completed: ${run.steps[run.stepIndex]?.label}`);
    }
  });
});

// ============================ T12 — golden screenshots ============================
// One full-viewport frame per recorded step, stored LOCAL-ONLY in IndexedDB (never
// leaves the machine — the privacy stance). Later feeds the audit filmstrip's
// record-time half and the VLM-heal crop source (fullFrame ✂ bbox, T11). Chrome
// hard-throttles captureVisibleTab to 2/s, so we coalesce: a burst of steps keeps only
// the latest pending frame, and real captures are spaced ≥550ms apart.
const GOLDEN_DB = "bao-golden", GOLDEN_STORE = "shots", GOLDEN_MAX_W = 1000;

function goldenDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GOLDEN_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(GOLDEN_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function goldenPut(key: string, blob: Blob): Promise<void> {
  const db = await goldenDB();
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(GOLDEN_STORE, "readwrite");
      tx.objectStore(GOLDEN_STORE).put(blob, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function goldenGet(key: string): Promise<Blob | null> {
  const db = await goldenDB();
  try {
    return await new Promise<Blob | null>((res, rej) => {
      const tx = db.transaction(GOLDEN_STORE, "readonly");
      const r = tx.objectStore(GOLDEN_STORE).get(key);
      r.onsuccess = () => res((r.result as Blob) || null); r.onerror = () => rej(r.error);
    });
  } finally { db.close(); }
}

let lastCaptureAt = 0;
let pendingGolden: { tabId: number; seq: string } | null = null;
let goldenTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGolden(tabId: number, seq: string): void {
  pendingGolden = { tabId, seq }; // latest wins on a burst
  if (goldenTimer) return;
  goldenTimer = setTimeout(runGolden, Math.max(0, 550 - (Date.now() - lastCaptureAt)));
}
async function runGolden(): Promise<void> {
  goldenTimer = null;
  const job = pendingGolden; pendingGolden = null;
  if (!job) return;
  lastCaptureAt = Date.now();
  try { await captureGolden(job.tabId, job.seq); } catch (e) { console.warn("[bao-t12]", e); }
  // A step may have arrived during the capture; drain it. (Cast: TS narrows the
  // module-level `let` to null across the awaits and can't see it was reassigned.)
  const next = pendingGolden as { tabId: number; seq: string } | null;
  if (next) scheduleGolden(next.tabId, next.seq);
}
async function captureGolden(tabId: number, seq: string): Promise<void> {
  const rec = await getRec();
  if (!rec || rec.tabId !== tabId) return; // recording ended / different tab
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "jpeg", quality: 75 });
  const src = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, GOLDEN_MAX_W / src.width);
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(src, 0, 0, w, h);
  src.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  await goldenPut(seq, blob);
  // Stamp the ref onto the recorded step (only element steps carry meta; T1-sensitive
  // steps never reach here — scheduleGolden is skipped for them in onRecStep).
  await enqueue(async () => {
    const cur = await getRec();
    const s = cur?.steps.find((st) => st.seq === seq);
    if (s?.meta) { s.meta.goldenScreenshotRef = seq; await setRec(cur!); }
  });
}
// Harness read-side: decode a stored golden and report its shape (a Blob can't cross
// sw.evaluate, but these plain fields can).
self.baoGetGolden = async (ref) => {
  const blob = await goldenGet(ref);
  if (!blob) return null;
  const bmp = await createImageBitmap(blob);
  const out = { type: blob.type, size: blob.size, width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
};

// ============================ T16 — run history ============================
// A finished run becomes a durable RunRecord + one replay-time screenshot per step, so
// the dashboard can re-watch it against the record-time golden frames. Mirrors the
// golden IndexedDB pattern above; kept in a separate DB (two stores: runs, frames) so
// the audit trail is self-contained. Retention is capped so disk stays bounded.
const HIST_DB = "bao-history", RUNS_STORE = "runs", FRAMES_STORE = "frames";
const HIST_MAX_RUNS = 50, HIST_MAX_W = 1000;

function historyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HIST_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RUNS_STORE)) db.createObjectStore(RUNS_STORE);
      if (!db.objectStoreNames.contains(FRAMES_STORE)) db.createObjectStore(FRAMES_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function histPut(store: string, key: string, val: unknown): Promise<void> {
  const db = await historyDB();
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function histGet<T>(store: string, key: string): Promise<T | null> {
  const db = await historyDB();
  try {
    return await new Promise<T | null>((res, rej) => {
      const tx = db.transaction(store, "readonly");
      const r = tx.objectStore(store).get(key);
      r.onsuccess = () => res((r.result as T) ?? null); r.onerror = () => rej(r.error);
    });
  } finally { db.close(); }
}
async function histDelete(store: string, key: string): Promise<void> {
  const db = await historyDB();
  try {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
async function histAllRuns(): Promise<RunRecord[]> {
  const db = await historyDB();
  try {
    return await new Promise<RunRecord[]>((res, rej) => {
      const tx = db.transaction(RUNS_STORE, "readonly");
      const r = tx.objectStore(RUNS_STORE).getAll();
      r.onsuccess = () => res((r.result as RunRecord[]) || []); r.onerror = () => rej(r.error);
    });
  } finally { db.close(); }
}
// Drop a run and every frame it owns.
async function histDeleteRun(rec: RunRecord): Promise<void> {
  await histDelete(RUNS_STORE, rec.id);
  for (const key of rec.frames) if (key) await histDelete(FRAMES_STORE, key);
}

// Per-run buffer of which step frames actually captured (frames[i] = key | null on the
// record). Lives in SW memory for the duration of a run; SW death loses it, which only
// costs a frameless record — the run state itself is storage-backed and resumes fine.
const runFrames = new Map<string, Set<number>>();
let runLastCaptureAt = 0;
// Capture the visible tab as this step's replay frame. Best-effort: throttled to respect
// Chrome's 2/s captureVisibleTab cap (a too-soon call is skipped → null frame, never a
// stall) and captured inline so the shot reflects THIS step's page, not a later one.
async function captureRunFrame(runId: string, tabId: number, i: number): Promise<void> {
  if (Date.now() - runLastCaptureAt < 550) return; // throttle guard → leave frame null
  try {
    const tab = await chrome.tabs.get(tabId);
    runLastCaptureAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "jpeg", quality: 75 });
    const src = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, HIST_MAX_W / src.width);
    const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(src, 0, 0, w, h);
    src.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    await histPut(FRAMES_STORE, `${runId}:${i}`, blob);
    (runFrames.get(runId) ?? runFrames.set(runId, new Set()).get(runId)!).add(i);
  } catch (e) { console.warn("[bao-t16]", e); } // headless / throttle / torn-down tab → null frame
}

// Assemble + persist the RunRecord at a terminal phase (done | failed). Idempotent on
// runId so a double-finalize (two paths racing to fail) can't write twice. Not enqueue'd:
// callers already hold the state chain, and this only touches IndexedDB.
async function finalizeRun(run: RunState): Promise<void> {
  try {
    if (await histGet(RUNS_STORE, run.runId)) return; // already recorded
    const set = runFrames.get(run.runId) ?? new Set<number>();
    const startUrl = run.startUrl || run.steps.find((s) => s.frame?.url)?.frame?.url || "";
    const rec: RunRecord = {
      id: run.runId,
      workflowId: run.workflowId || "",
      workflowName: run.workflowName || autoName(startUrl),
      startUrl,
      startedAt: run.startedAt || Date.now(),
      finishedAt: Date.now(),
      outcome: run.phase === "failed" ? "failed" : "passed",
      results: run.results,
      steps: run.steps,
      frames: run.steps.map((_, i) => (set.has(i) ? `${run.runId}:${i}` : null)),
    };
    await histPut(RUNS_STORE, rec.id, rec);
    // Retention: keep the newest HIST_MAX_RUNS, prune the rest + their frames.
    const all = (await histAllRuns()).sort((a, b) => b.finishedAt - a.finishedAt);
    for (const old of all.slice(HIST_MAX_RUNS)) await histDeleteRun(old);
  } catch (e) { console.warn("[bao-t16]", e); }
  finally { runFrames.delete(run.runId); }
}

self.baoListRuns = async (workflowId) => {
  const all = (await histAllRuns()).sort((a, b) => b.finishedAt - a.finishedAt);
  return workflowId ? all.filter((r) => r.workflowId === workflowId) : all;
};
self.baoGetRun = (id) => histGet<RunRecord>(RUNS_STORE, id);
self.baoDeleteRun = async (id) => {
  const rec = await histGet<RunRecord>(RUNS_STORE, id);
  if (rec) await histDeleteRun(rec);
  return { ok: true };
};
self.baoClearRuns = async (workflowId) => {
  const all = await histAllRuns();
  for (const rec of all) if (!workflowId || rec.workflowId === workflowId) await histDeleteRun(rec);
  return { ok: true };
};

// The merged, time-ordered recording across all frames.
self.baoDrainSteps = () => self.__baoSteps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

// Tier-C item 6: opt-in "aggressive capture" — dynamically register a MAIN-world,
// document_start script that forces closed shadow roots open so Tier-A piercing can
// reach inside (e.g. salesforce.com's closed <cs-native-frame-holder>). Off by
// default; applies to navigations after it's enabled (reload to take effect).
const FORCE_OPEN_ID = "bao-forceopen";
self.baoSetForceOpen = async (on) => {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FORCE_OPEN_ID] });
    if (on && !existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: FORCE_OPEN_ID,
        matches: ["<all_urls>"],
        js: ["dist/forceopen.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (!on && existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [FORCE_OPEN_ID] });
    }
    return { ok: true, on: !!on };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
};

// Map a recorded FrameRef onto a live frameId. Prefer an exact URL match, fall back
// to same-origin (the cross-origin child case), then the top frame.
function pickFrameId(frames: chrome.webNavigation.GetAllFrameResultDetails[], ref: FrameRef | undefined): number | null {
  if (!ref) return 0;
  let f = frames.find((fr) => fr.url === ref.url);
  if (!f && ref.origin) f = frames.find((fr) => { try { return new URL(fr.url).origin === ref.origin; } catch { return false; } });
  if (!f && ref.top) f = frames.find((fr) => fr.frameId === 0);
  return f ? f.frameId : null;
}

// Replay a recording that may span frames: send each step to the one frame it belongs
// to (chrome.tabs.sendMessage with an explicit frameId), in order. Callable from the
// harness via sw.evaluate.
self.baoReplayAcrossFrames = async (tabId, steps) => {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const results: StepResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const frameId = pickFrameId(frames, step.frame);
    if (frameId == null) {
      results.push({ i, ok: false, reason: `frame not found: ${step.frame && step.frame.origin}` });
      return { ok: false, failedAt: i, results };
    }
    let res: ReplayResponse | undefined;
    try {
      res = await chrome.tabs.sendMessage(tabId, { cmd: "replay", steps: [step] }, { frameId });
    } catch (e) {
      results.push({ i, ok: false, frameId, reason: String(e instanceof Error ? e.message : e) });
      return { ok: false, failedAt: i, results };
    }
    const r0 = (res && res.results && res.results[0]) || ({} as StepResult);
    results.push({ i, ok: !!res && res.ok === true, via: r0.via, frameId });
    if (!res || res.ok !== true) return { ok: false, failedAt: i, results };
  }
  return { ok: true, results };
};
