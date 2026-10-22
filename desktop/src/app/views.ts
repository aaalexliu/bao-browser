// HTML for the desktop window. The browser script fills these strings in.
// No network, no DOM.

import { importErrorView } from "./import-error";
import type { ImportLoginError } from "../v1/import-login-error";
import { attentionCount, formatWait, pendingHealCount, type HumanAsk } from "../v1/human-ask";
import { formatClock, formatWhen } from "../v1/time";
import { shotFile, workflowShotName } from "../v1/shots";
import { bucketWords, diffTrajectory, type TimingBucket, type TrajectoryStep } from "../v1/trajectory";
import { filmstripSpans, idleSkippedMs, idleSkips, skipLabel } from "../v1/filmstrip";
import { stepsNeedingReview, type StepReview } from "../v1/triage";
import { DEFAULT_PROMOTE_AFTER } from "../v1/promote";
import { tokenFields, type TokenInput } from "../v1/input-token";
import type { ConsoleLine, IdentityView, NetworkLine, SnapshotNode, StepView } from "./view-types";

export interface WorkflowSummary {
  id: string;
  name: string;
  steps: number;
  waits?: number;
  expects?: number;
  heal?: string;
  replayed?: boolean;
  firstStep?: { action?: string; label?: string };
  inputs?: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean }[];
  startUrl?: string;
}

export interface PromotionView {
  healId?: string;
  workflowId?: string;
  stepId?: string;
  status?: string;
  drift?: string;
  replays?: number;
  reason?: string;
  need?: number;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  status: string;
  at?: number;
  modelCalls?: number;
  steps?: StepView[];
  heals?: HealView[];
  decisions?: { ts: number; healId: string; decision: "keep" | "revert" }[];
  failure?: FailureView;
  inputs?: Record<string, string>;
  video?: string;
  videoStartedAt?: number;
  repairs?: { stepId?: string; repair: string; detail?: string }[];
  receipts?: { stepId?: string; source?: string; expected?: string; actual?: string; pass?: boolean }[];
  trajectory?: TrajectoryStep[];
  precondition?: { phase?: string; reason?: string; recovered?: boolean; stepId?: string };
  promotion?: PromotionView;
  console?: ConsoleLine[];
  network?: NetworkLine[];
  trail?: { kind?: string; text?: string; ts?: number; phase?: string; stepId?: string }[];
  envelope?: {
    status: string;
    run_id?: string;
    step?: string;
    reason?: string;
    ask?: string;
    deadline?: string | null;
    resume_token?: string;
  };
}

export interface FailureView {
  stepId?: string;
  index?: number;
  intent?: string;
  reason?: string;
  phase?: string;
  brokenAttr?: string;
  identity?: IdentityView;
  locators?: { kind: string; label: string; score: number }[];
  beforeShot?: string;
  snapshot?: { screenshot?: string; screenshotRef?: string; dom?: SnapshotNode[]; ax?: string };
}

export interface HealView {
  id: string;
  workflowId?: string;
  ts?: number;
  mode?: string;
  intent?: string;
  prompt?: string;
  rawResponse?: string;
  model?: { name?: string; version?: string; provider?: string };
  proposedPatch?: { identity?: { name?: string; text?: string; testId?: string; id?: string; role?: string }; label?: string };
  failedStep?: { id?: string; label?: string; action?: string; identity?: { name?: string; text?: string; testId?: string; id?: string; role?: string } };
  postconditionPassed?: boolean;
  snapshot?: { screenshot?: string; screenshotRef?: string };
  beforeShot?: string;
  identity?: IdentityView;
  executed?: { action?: string };
}

export interface ImportPending {
  id?: string;
  domain?: string;
  phase?: string;
  message?: string;
  error?: unknown;
  profiles?: { directory: string; name: string }[];
  audit?: { domain?: string; count?: number; at?: number };
}

export interface ShellState {
  recording?: boolean;
  capturePaused?: boolean;
  recordingSince?: number;
  helper?: { label: string; platform?: string; accessibility?: boolean; screenCapture?: boolean };
  /** Sidebar dot after the Library card has been dismissed, or on any other screen. */
  permDot?: boolean;
  model?: { label: string };
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
  promotions?: PromotionView[];
  activeAsk?: HumanAsk | null;
  pendingImport?: ImportPending | null;
  teach?: TeachView;
}

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  kind: "screen" | "workflow" | "theme";
  screen?: string;
  workflowId?: string;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

/** A URL for a real PNG. Anything else stays blank so the window never paints a broken image. */
export function imageRef(runId: string, value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("iVBORw0KGgo") && /^[A-Za-z0-9+/=]+$/.test(value)) return `data:image/png;base64,${value}`;
  if (/^[\w.-]+\.png$/.test(value)) return `/api/runs/${encodeURIComponent(runId)}/shots/${encodeURIComponent(value)}`;
  return "";
}

function placeholder(action: string | undefined, label: string): string {
  return `<div class="ph"><span class="ph-ico">${glyph(action)}</span><span class="ph-label">${esc(label)}</span></div>`;
}

function glyph(action: string | undefined): string {
  const paths: Record<string, string> = {
    type: "M5 5h14v3h-5.5v11h-3V8H5V5z",
    login: "M12 8a3 3 0 110 6 3 3 0 010-6zm-6 11a6 6 0 0112 0H6z",
    confirm: "M5 12l5 5L19 7",
    upload: "M12 4v10m0-10l-3.5 3.5M12 4l3.5 3.5M5 16v3h14v-3",
    drop: "M12 4v10m0-10l-3.5 3.5M12 4l3.5 3.5M5 16v3h14v-3",
    verify: "M5 12l4 4L19 7",
    click: "M7 3l6 14-2.4.7L9 22l-1.5-4.6L3 15.8 7 3z",
  };
  const d = paths[action || ""] || paths.click;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="${d || ""}"/></svg>`;
}

export function statusLegend(): string {
  const items = [
    ["passed", "Passed"],
    ["healed", "Healed"],
    ["provisional", "Provisional"],
    ["paused", "Needs you"],
    ["failed", "Failed"],
  ];
  return `<div class="legend">${items.map(([kind, label]) => `<span><i class="swatch ${kind}"></i> ${label}</span>`).join("")}</div>`;
}

export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[secret]");
  }
  return out;
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    library: "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z",
    capture: "M12 8a4 4 0 100 8 4 4 0 000-8zm8.5 4a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0z",
    teach: "M5 4h10l4 4v12H5V4zm9 0v5h5M8 13h8M8 17h5",
    runs: "M4 6h16v3H4V6zm0 5h16v3H4v-3zm0 5h10v3H4v-3z",
    heals: "M12 4l2.2 4.6L19 9.2l-3.5 3.4.8 4.9L12 15.8 7.7 17.5l.8-4.9L5 9.2l4.8-.6L12 4z",
    replay: "M8 5v14l11-7L8 5z",
    logins: "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0H5z",
    settings: "M12 8.5A3.5 3.5 0 1012 15.5 3.5 3.5 0 0012 8.5zM4 12l2-.6.4-1.6-1.2-1.6 1.8-1.8 1.6 1.2 1.6-.4L11 5h2l.4 2.2 1.6.4 1.6-1.2 1.8 1.8-1.2 1.6.4 1.6 2 .6v2l-2 .6-.4 1.6 1.2 1.6-1.8 1.8-1.6-1.2-1.6.4L13 21h-2l-.4-2.2-1.6-.4-1.6 1.2-1.8-1.8 1.2-1.6-.4-1.6L4 14v-2z",
  };
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${paths[name] || ""}"/></svg>`;
}

export function rail(state: ShellState): string {
  const heals = pendingHealCount(state.runs || []);
  const reviews = reviewItems(state.runs);
  const waiting = attentionCount({
    ask: state.activeAsk,
    importPhase: state.pendingImport?.phase,
    pendingHeals: heals,
    reviews: reviews.length,
  });
  const rec = state.recording ? "on" : "";
  const helper = state.helper?.label || "helper off";
  const model = state.model?.label || "no model";
  const healBadge = heals > 0 ? `<span class="count" id="heal-count">${heals}</span>` : "";
  const perm = state.permDot ? permissionDot(state.helper) : "";
  return `<div class="brand"><strong>bao</strong>${waiting > 0 ? `<span class="count" id="attention" data-count="${waiting}">${waiting}</span>` : `<span id="attention" data-count="0"></span>`}</div>
    <nav>
      <button data-screen="library">${icon("library")} Library</button>
      <button data-screen="capture">${icon("capture")} Capture</button>
      <button data-screen="teach">${icon("teach")} Teach</button>
      <button data-screen="runs">${icon("runs")} Runs</button>
      <button data-screen="heals">${icon("heals")} Heals ${healBadge}</button>
      <button data-screen="replay">${icon("replay")} Replay</button>
      <button data-screen="logins">${icon("logins")} Logins</button>
      <button data-screen="settings">${icon("settings")} Settings</button>
    </nav>
    <div class="rail-foot">
      <div id="attention-label">${waiting} waiting</div>
      <div class="channel"><span class="dot ${rec}" id="dot"></span><span id="rec-label">${state.recording ? "recording" : "idle"}</span></div>
      <div class="channel" id="helper-status">${perm}${esc(helper)}</div>
      <div class="channel" id="model-status">${esc(model)}</div>
    </div>`;
}

export function actBar(state: ShellState, now = Date.now()): string {
  const ask = state.activeAsk;
  if (ask?.kind === "confirm" || ask?.kind === "login") {
    const effect = ask.kind === "confirm" ? "run stops, nothing applied" : "run stops, still signed out";
    const kicker = `You need to act · ${ask.workflowName} · step ${ask.stepIndex} of ${ask.stepCount}`;
    const extra = ask.kind === "login"
      ? `<button id="act-continue" type="button">I'm signed in, continue</button>`
      : "";
    return `<section id="act-bar" data-ask="${ask.kind}" data-step="${esc(ask.stepId)}">
      <p class="kicker">${esc(kicker)}</p>
      <p class="instruction">${esc(ask.instruction)}</p>
      <p class="timeout" id="act-timeout" data-deadline="${ask.deadline ?? ""}" data-effect="${esc(effect)}">${esc(formatWait(now, ask.deadline, effect))}</p>
      <div class="row">
        <button id="act-show" type="button">Show window</button>
        ${extra}
        <button id="act-cancel" type="button">Cancel run</button>
      </div>
    </section>`;
  }
  const reviewBar = reviewAct(state);
  if (reviewBar) return reviewBar;
  const pending = state.pendingImport;
  if (pending && (pending.phase === "confirm" || pending.phase === "pick" || pending.phase === "running")) {
    const domain = pending.domain || "the site";
    const instruction = pending.phase === "pick"
      ? `Pick a Chrome profile for ${domain} in this window.`
      : pending.phase === "running"
        ? "Approve the macOS Keychain prompt if it appears. Bao does not save that key."
        : `Press Import in this window to copy cookies for ${domain}, or Cancel. Nothing is read until you do.`;
    return `<section id="act-bar" data-ask="import" data-phase="${esc(pending.phase)}">
      <p class="kicker">You need to act · import ${esc(domain)}</p>
      <p class="instruction">${esc(instruction)}</p>
      <p class="timeout" id="act-timeout">Waiting · nothing is read until you choose</p>
    </section>`;
  }
  return "";
}

function reviewAct(state: ShellState): string {
  const reviews = reviewItems(state.runs);
  const first = reviews[0];
  if (!first) return "";
  const names = new Map((state.workflows || []).map((workflow) => [workflow.id, workflow.name]));
  const workflowName = names.get(first.workflowId) || first.workflowId;
  const extra = reviews.length > 1 ? ` ${reviews.length - 1} more ${reviews.length === 2 ? "step" : "steps"} also need review.` : "";
  return `<section id="act-bar" data-ask="review" data-step="${esc(first.stepId)}">
    <p class="kicker">You need to act · ${esc(workflowName)} · ${esc(first.label)}</p>
    <p class="instruction">${esc(first.label)} needs review. It healed itself on ${first.streak} runs in a row, so auto-heal is off for that step.${esc(extra)}</p>
    <p class="timeout" id="act-timeout">Auto-heal stays off until a run passes this step without a heal.</p>
    <div class="row">
      <button id="act-review" type="button" data-workflow="${esc(first.workflowId)}" data-step="${esc(first.stepId)}">Open the step</button>
    </div>
  </section>`;
}

export function importCard(pending: ImportPending | null | undefined): string {
  if (!pending || pending.phase === "cancelled") return "";
  if (pending.phase === "confirm") {
    return `<section class="card" id="import-confirm">
      <h3>Use your Chrome sign-in for ${esc(pending.domain)}?</h3>
      <p>${esc(pending.message)}</p>
      <p class="quiet">macOS may ask to read Chrome Safe Storage from your Keychain. Click Allow. Bao does not save that key. Nothing is read until you press Import.</p>
      <div class="row"><button class="primary" id="import-yes" type="button">Import</button><button id="import-no" type="button">Cancel</button></div>
    </section>`;
  }
  if (pending.phase === "pick") {
    const buttons = (pending.profiles || []).map((profile) =>
      `<button type="button" data-import-profile="${esc(profile.directory)}">${esc(profile.name)}</button>`).join(" ");
    return `<section class="card" id="import-pick">
      <p>Chrome has more than one profile. Pick one for ${esc(pending.domain)}.</p>
      <div class="row">${buttons}</div>
      <button id="import-no" type="button">Cancel</button>
    </section>`;
  }
  if (pending.phase === "running") {
    return `<section class="card" id="import-running"><p>Approve the macOS Keychain prompt if it appears. Bao does not save that key.</p></section>`;
  }
  if (pending.phase === "error") {
    const view = importErrorView(pending.error);
    return importErrorCard(view);
  }
  if (pending.phase === "done" && pending.audit) {
    const when = typeof pending.audit.at === "number" ? formatClock(pending.audit.at) : "";
    return `<section class="card" id="import-done"><p>Imported ${esc(pending.audit.count)} cookies for ${esc(pending.audit.domain)}${when ? ` at ${esc(when)}` : ""}.</p></section>`;
  }
  return "";
}

export function importErrorCard(view: ImportLoginError): string {
  const detail = view.detail ? `<p class="quiet">Details: ${esc(view.detail)}</p>` : "";
  return `<section class="card" id="import-error" data-error-code="${esc(view.code)}">
    <p><code>${esc(view.code)}</code> ${esc(view.cause)}</p>
    <p>${esc(view.hint)}</p>
    ${detail}
  </section>`;
}

export function stopHeadline(input: {
  stepNumber: number;
  label: string;
  action?: string;
  identity?: IdentityView;
  reason?: string;
  brokenAttr?: string;
}): string {
  const name = input.label || input.action || "step";
  const identity = input.identity;
  const head = `Step ${input.stepNumber} "${name}"`;
  const bits: string[] = [];
  if (identity && identity.candidates.length >= 2 && !identity.accepted) {
    const lead = identity.lead ?? 0;
    bits.push(`${head}: two candidates scored ${identity.candidates[0]!.score} and ${identity.candidates[1]!.score} (lead ${lead} < 25).`);
  } else if (input.reason) {
    bits.push(`${head} stopped: ${input.reason}.`);
  } else {
    bits.push(head);
  }
  if (identity?.changed) bits.push(`What changed since recording: ${identity.changed}.`);
  else if (input.brokenAttr || identity?.brokenAttr) {
    bits.push(`Attribute that changed: ${input.brokenAttr || identity?.brokenAttr}.`);
  }
  return bits.join(" ");
}

function stepLabel(step: StepView, workflowSteps: { id: string; label?: string; action?: string }[]): string {
  const match = workflowSteps.find((item) => item.id === step.id);
  return step.label || match?.label || match?.action || step.id;
}

export interface ViewerContext {
  recent?: RunSummary[];
  recorded?: TrajectoryStep[];
  /** Steps whose auto-heal is off after consecutive heals. */
  reviewStepIds?: string[];
}

function routeRan(
  steps: { id: string; status?: string; reason?: string }[],
  workflow: { inputs?: { name: string; type?: string; choices?: string[] }[]; steps: { id: string; when?: { input?: string; value?: string } }[] },
): string | undefined {
  const choice = (workflow.inputs || []).find((input) => input.type === "choice" && input.choices?.length);
  if (!choice?.choices?.length) return undefined;
  const ran = new Set<string>();
  const skipped = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.when?.value) continue;
    const result = steps.find((item) => item.id === step.id);
    if (!result || result.status === "pending" || result.status === "skipped") continue;
    if (result.reason === "other branch") skipped.add(step.when.value);
    else ran.add(step.when.value);
  }
  if (ran.size >= 1) return [...ran][0];
  const rest = choice.choices.filter((name) => !skipped.has(name));
  if (skipped.size && rest.length === 1) return rest[0];
  return undefined;
}

export function runViewer(
  run: RunSummary,
  workflow: {
    name: string;
    inputs?: { name: string; type?: string; choices?: string[] }[];
    steps: { id: string; label?: string; action?: string; index?: number; when?: { input?: string; value?: string; present?: string } }[];
  },
  selectedId?: string,
  context: ViewerContext = {},
): string {
  const steps = (run.steps || []).map((step) => ({
    ...step,
    label: stepLabel(step, workflow.steps),
    action: step.action || workflow.steps.find((item) => item.id === step.id)?.action,
  }));
  const failed = steps.find((step) => step.status === "failed" || step.status === "paused");
  const selected = steps.find((step) => step.id === selectedId) || failed || steps[steps.length - 1];
  const selectedIndex = Math.max(0, selected ? steps.indexOf(selected) : 0);
  const modelCalls = run.modelCalls ?? (run.heals || []).filter((heal) => heal.model).length;
  const passed = steps.filter((step) => step.status === "passed").length;
  const stopped = failed ? steps.indexOf(failed) + 1 : steps.length;
  const failure = run.failure;
  const identity = selected?.identity || (failure && failure.stepId === selected?.id ? failure.identity : undefined);
  const headline = failed
    ? stopHeadline({
      stepNumber: (failure?.index ?? steps.indexOf(failed)) + 1,
      label: failed.label || failure?.intent || failed.id,
      action: failed.action,
      identity: failed.identity || failure?.identity,
      reason: failed.reason || failure?.reason,
      brokenAttr: failure?.brokenAttr,
    })
    : `${esc(workflow.name)} passed`;
  const statusWord = run.status === "passed" ? "passed" : run.status === "paused" ? "paused" : run.status === "timed-out" ? "stopped, timed out" : "refused";
  const badge = modelCalls === 0
    ? `<span class="badge quiet-badge" id="model-calls">0 model calls</span>`
    : `<span class="badge" id="model-calls">${modelCalls} model call${modelCalls === 1 ? "" : "s"}</span>`;
  const segs = steps.map((step) => `<span class="seg ${esc(step.status)}" data-step="${esc(step.id)}" title="${esc(step.label || step.id)}"></span>`).join("");
  const list = steps.map((step) => {
    const mark = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : step.status === "paused" ? "⏸" : "·";
    const dur = duration(step);
    const review = (context.reviewStepIds || []).includes(step.id) || step.triage === "review";
    const reviewMark = review ? `<em class="review">needs review</em>` : "";
    const recoveredMark = step.reason?.startsWith("recovered:") ? `<em class="recovered">${esc(step.reason)}</em>` : "";
    const askMark = step.reason === "always ask" ? `<em class="ask">always ask</em>` : "";
    const spec = workflow.steps.find((item) => item.id === step.id);
    const routeMark = step.reason === "other branch"
      ? `<em class="route">other branch</em>`
      : spec?.when?.value
        ? `<em class="route">${esc(spec.when.value)}</em>`
        : "";
    return `<button type="button" class="step ${esc(step.status)} ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}" data-at="${step.startedAt ?? ""}"><span>${mark}</span> ${esc(step.label || step.id)} <em>${esc(dur)}</em>${routeMark}${recoveredMark}${askMark}${reviewMark}</button>`;
  }).join("");
  const ran = routeRan(steps, workflow);
  const routeLine = ran ? `<p id="route-ran" data-route="${esc(ran)}">Route: ${esc(ran)}</p>` : "";
  const before = selected ? frameUrl(run.id, selected, failure, "before") : "";
  const after = selected ? frameUrl(run.id, selected, failure, "after") : "";
  const shot = shotPane(before, after, selected?.action, selected?.label || "");
  const table = identityTable(identity);
  const video = videoBar(run, steps);
  const safeHeadline = failed ? esc(headline) : headline;
  const phase = selected?.phase || (failure && failure.stepId === selected?.id ? failure.phase : undefined) || run.precondition?.phase;
  const recoveredRow = selected?.reason?.startsWith("recovered:")
    ? `<p id="recovered-row">${esc(selected.reason)}</p>`
    : "";
  const stepRepairs = (run.repairs || []).filter((item) => !selected || item.stepId === selected.id);
  const stepReceipts = (run.receipts || []).filter((item) => !selected || item.stepId === selected.id);
  const snapDom = selected?.snapshot?.dom || (failure && failure.stepId === selected?.id ? failure.snapshot?.dom : undefined);
  const snapAx = selected?.snapshot?.ax || (failure && failure.stepId === selected?.id ? failure.snapshot?.ax : undefined);
  const triageNote = selected?.triage && selected.triage !== "change"
    ? `<p id="triage">Sorted as ${esc(triageWord(selected.triage))}. Bao did not call a model.</p>`
    : "";
  const showPlain = !!failed || phase === "auth";
  const words = showPlain ? plainFailure({
    phase,
    changed: identity?.changed || (failure && failure.stepId === selected?.id ? failure.identity?.changed : undefined),
    reason: selected?.reason || failure?.reason,
    repairs: stepRepairs.length ? stepRepairs : (run.repairs || []),
    authRecovered: run.precondition?.recovered,
  }) : "";
  const spans = filmstripSpans(steps);
  const skipped = idleSkippedMs(steps);
  const film = spans.map((span) => {
    const step = steps.find((item) => item.id === span.id)!;
    const face = frameFace(run.id, step, failure);
    const marker = span.skippedMs > 0 ? skipMark(span.skippedMs) : "";
    const shotClass = face.src ? " has-shot" : "";
    return `${marker}<button type="button" class="frame${shotClass} ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}" data-at="${step.startedAt ?? ""}" data-skipped="${span.skippedMs}" style="flex:${span.flex} 1 72px">${face.body}</button>`;
  }).join("");
  const idleNote = skipped > 0 ? `<p class="quiet" id="idle-note" data-idle-skipped="${skipped}">Idle longer than 3s is collapsed.</p>` : "";
  const recent = context.recent && context.recent.length ? context.recent : [run];
  return `<section id="run-viewer" data-run="${esc(run.id)}" data-status="${esc(run.status)}">
    <header class="run-head">
      <h2>${esc(workflow.name)} · ${esc(run.id)}</h2>
      <p class="${esc(run.status)}" id="run-status"><strong>${esc(statusWord)}</strong> ${failed ? `at step ${stopped}` : ""} ${badge}</p>
      ${routeLine}
    </header>
    ${envelopePane(run.envelope)}
    ${handoffPane(run.trail)}
    <div class="row" id="run-actions">
      <button id="rerun-run" type="button">Re-run with this run's inputs</button>
      <button id="debug-step" type="button" data-step="${esc(selected?.id || "")}">Debug from this step</button>
    </div>
    ${storedInputsLine(run.inputs)}
    <div class="why" id="why-stopped"><p>${safeHeadline}</p>${words ? `<p id="plain-failure">${esc(words)}</p>` : ""}${triageNote}${failed ? `<p class="quiet">${stopped <= 1 ? "No steps ran." : `Nothing after step ${stopped - 1} ran.`}</p><button type="button" class="link" id="open-failed-step" data-select-step="${esc(failed.id)}">Open this step</button> <button type="button" id="teach-fix" data-workflow="${esc(run.workflowId)}" data-step="${esc(failed.id)}">Teach this step</button>` : ""}</div>
    <div class="bar" id="step-bar" data-steps="${steps.length}" aria-label="${passed}/${steps.length}">${segs}<span class="bar-count">${passed}/${steps.length}</span></div>
    ${idleNote}
    <div class="filmstrip" id="filmstrip" data-idle-skipped="${skipped}">${film}</div>
    <input id="scrubber" type="range" min="0" max="${Math.max(0, steps.length - 1)}" value="${selectedIndex}" aria-label="Step timeline">
    <div class="split${selected?.status === "failed" ? " with-failure" : ""}">
      <div class="step-list" id="step-list">${list}</div>
      <div class="step-detail" id="step-detail">
        <div class="row"><strong>${esc(selected?.label || "")}</strong></div>
        ${recoveredRow}
        ${shot}
        ${stepRepairs.length ? repairLines(stepRepairs) : ""}
        ${stepReceipts.length ? receiptLines(stepReceipts) : ""}
        <h3 class="section">Identity</h3>
        ${table}
        ${snapshotPane(snapDom, snapAx)}
      </div>
      ${failurePanel(selected, failure, identity)}
    </div>
    ${passGrid(recent, workflow.steps)}
    ${trajectoryPane(context.recorded, run.trajectory)}
    ${video}
    <div class="tabs" id="run-tabs">
      <button type="button" data-run-tab="trail">Trail</button>
      <button type="button" data-run-tab="inputs">Inputs</button>
      <button type="button" data-run-tab="console">Console</button>
      <button type="button" data-run-tab="network">Network</button>
    </div>
    <div id="run-extra"></div>
  </section>`;
}

function envelopePane(envelope: RunSummary["envelope"]): string {
  if (!envelope || (envelope.status !== "needs_human" && envelope.status !== "needs_signin" && envelope.status !== "timed-out" && envelope.status !== "stopped" && envelope.status !== "completed")) return "";
  const heading = envelope.status === "completed" ? "Completed" : envelope.status === "timed-out" ? "Stopped, timed out" : envelope.status === "stopped" ? "Stopped" : "Needs you";
  return `<section id="run-envelope" data-status="${esc(envelope.status)}">
    <h3>${heading}</h3>
    <p id="envelope-status"><strong>${esc(envelope.status)}</strong></p>
    ${envelope.ask ? `<p id="envelope-ask">${esc(envelope.ask)}</p>` : ""}
    ${envelope.reason ? `<p id="envelope-reason">${esc(envelope.reason)}</p>` : ""}
    ${envelope.deadline ? `<p id="envelope-deadline">${esc(envelope.deadline)}</p>` : ""}
    ${envelope.step ? `<p id="envelope-step">Step ${esc(envelope.step)}</p>` : ""}
    ${envelope.run_id ? `<p class="mono" id="envelope-run">${esc(envelope.run_id)}</p>` : ""}
    ${envelope.resume_token ? `<p class="mono" id="envelope-token">${esc(envelope.resume_token)}</p>` : ""}
  </section>`;
}

function handoffPane(trail: RunSummary["trail"]): string {
  const rows = (trail || []).filter((event) => event.kind === "handoff" && event.text);
  if (!rows.length) return "";
  return `<ol id="handoff-trail">${rows.map((event) => `<li>${esc(event.text || "")}</li>`).join("")}</ol>`;
}

function duration(step: StepView): string {
  if (typeof step.startedAt !== "number" || typeof step.endedAt !== "number" || step.endedAt < step.startedAt) return "";
  const ms = step.endedAt - step.startedAt;
  if (ms < 1000) {
    const tenths = Math.max(1, Math.round(ms / 100));
    return `${(tenths / 10).toFixed(1)}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function frameFace(runId: string, step: StepView, failure: FailureView | undefined): { src: string; body: string } {
  const before = frameUrl(runId, step, failure, "before");
  const after = frameUrl(runId, step, failure, "after");
  const src = after || before;
  const hold = placeholder(step.action, step.label || step.id);
  if (!src) return { src: "", body: hold };
  return {
    src,
    body: `<img src="${esc(src)}" alt="" data-before="${esc(before)}" data-after="${esc(after)}">${hold}`,
  };
}

function failurePanel(step: StepView | undefined, failure: FailureView | undefined, identity: IdentityView | undefined): string {
  if (!step || step.status !== "failed") return "";
  const phase = step.phase || (failure && failure.stepId === step.id ? failure.phase : "") || "";
  if (!phase) return "";
  const fromFailure = failure && failure.stepId === step.id ? failure.locators : undefined;
  const fromIdentity = (identity?.candidates || []).map((candidate) => ({
    kind: "identity",
    label: candidate.label,
    score: candidate.score,
  }));
  const rows = fromFailure && fromFailure.length ? fromFailure : fromIdentity;
  const list = rows.length
    ? `<ol id="locator-tries">${rows.map((row) => `<li data-kind="${esc(row.kind)}" data-score="${row.score}"><span>${esc(row.label)}</span> <em>${row.score}</em></li>`).join("")}</ol>`
    : `<p class="quiet" id="locator-tries">No locator was tried.</p>`;
  return `<aside id="failure-panel" data-phase="${esc(phase)}">
    <h3>Failure</h3>
    <p id="failure-phase">Phase <strong>${esc(phase)}</strong></p>
    <h4>Locators tried</h4>
    ${list}
  </aside>`;
}

function frameUrl(runId: string, step: StepView, failure: FailureView | undefined, which: "before" | "after"): string {
  if (which === "before") return imageRef(runId, step.beforeShot);
  const own = imageRef(runId, step.afterShot);
  if (own) return own;
  if (!failure || failure.stepId !== step.id) return "";
  return imageRef(runId, failure.snapshot?.screenshot)
    || imageRef(runId, failure.snapshot?.screenshotRef)
    || imageRef(runId, failure.beforeShot);
}

function shotPane(before: string, after: string, action?: string, label?: string): string {
  const which = after ? "after" : "before";
  return `<div class="shots" id="shots">
    <div class="row">
      <button type="button" class="toggle ${which === "before" ? "on" : ""}" data-frame="before" ${before ? "" : "disabled"}>Before</button>
      <button type="button" class="toggle ${which === "after" ? "on" : ""}" data-frame="after" ${after ? "" : "disabled"}>After</button>
    </div>
    <div class="shot-stage" id="shot-stage" data-before="${esc(before)}" data-after="${esc(after)}" data-which="${which}">${placeholder(action, label || "This step")}</div>
  </div>`;
}

export function identityTable(identity: IdentityView | undefined): string {
  if (!identity || identity.candidates.length === 0) {
    return `<p class="quiet" id="identity-table">No identity scores for this step.</p>`;
  }
  const heads = identity.candidates.map((candidate, index) => `<th>#${index + 1} ${esc(candidate.label)}</th>`).join("");
  const scores = identity.candidates.map((candidate) => `<td>${candidate.score}</td>`).join("");
  const lead = `<tr><th>lead</th><td>${identity.lead ?? ""}</td>${identity.candidates.slice(1).map(() => "<td></td>").join("")}</tr>`;
  const attrs = new Map<string, { recorded: string; cells: string[] }>();
  for (const candidate of identity.candidates) {
    for (const attr of candidate.attrs) {
      const row = attrs.get(attr.attr) || { recorded: attr.recorded, cells: [] };
      row.cells.push(`<td>${esc(attr.live || "—")} ${attr.points ?? ""} ${attr.matched ? "✓" : "≠"}</td>`);
      attrs.set(attr.attr, row);
    }
  }
  const body = [...attrs.entries()].map(([attr, row]) =>
    `<tr><th>${esc(attr)}</th>${row.cells.join("")}</tr>`).join("");
  return `<table class="identity" id="identity-table">
    <tr><th></th>${heads}</tr>
    <tr><th>score</th>${scores}</tr>
    ${lead}
    ${body}
  </table>`;
}

export function videoBar(run: RunSummary, steps: StepView[]): string {
  const timed = steps.filter((step) => typeof step.startedAt === "number");
  if (timed.length === 0) return `<div id="video-bar" hidden></div>`;
  const origin = run.videoStartedAt || timed[0]!.startedAt || 0;
  const spans = filmstripSpans(steps);
  const total = spans.reduce((sum, span) => sum + span.flex, 0) || 1;
  let cursor = 0;
  const markers = spans.map((span) => {
    const step = steps.find((item) => item.id === span.id);
    const at = (cursor / total) * 100;
    cursor += span.flex;
    if (!step || typeof step.startedAt !== "number") return "";
    const index = steps.indexOf(step);
    const mark = step.status === "failed" ? "✗" : String(index + 1);
    const gap = span.skippedMs > 0 ? skipMark(span.skippedMs, `${at}%`) : "";
    return `${gap}<button type="button" class="marker ${esc(step.status)}" data-marker="${esc(step.id)}" data-at="${step.startedAt}" style="left:${at}%">${mark}</button>`;
  }).join("");
  const src = run.video ? `/api/runs/${encodeURIComponent(run.id)}/video` : "";
  const skipData = esc(JSON.stringify(idleSkips(steps, origin).map((item) => ({ from: item.from, to: item.to, label: item.label }))));
  if (!src) return `<div id="video-bar" hidden data-origin="${origin}">${markers}</div>`;
  return `<div id="video-bar" data-origin="${origin}">
    <video id="run-video" src="${esc(src)}" data-skips="${skipData}" controls preload="metadata"></video>
    <div class="timeline">${markers}</div>
    <p id="skip-live" class="quiet"></p>
    <div class="row"><button type="button" data-speed="1">1×</button><button type="button" data-speed="2">2×</button><button type="button" data-speed="4">4×</button></div>
  </div>`;
}

function triageWord(value: string): string {
  if (value === "change") return "a real change";
  if (value === "blocker") return "a temporary blocker";
  if (value === "outage") return "an outage";
  if (value === "circuit") return "a circuit break";
  if (value === "review") return "needs review";
  if (value === "never") return "a step set to never heal";
  return value;
}

function skipMark(ms: number, left?: string): string {
  const style = left ? ` style="left:${left}"` : "";
  return `<span class="skip-marker" data-skipped="${ms}"${style}>${esc(skipLabel(ms))}</span>`;
}

/** The re-run form asks for a secret again. The stored mask is not a value. */
export function secretInput(name: string, label: string, hadSecret: boolean): string {
  const hint = hadSecret ? "Last run used a secret" : "";
  return `<label>${esc(label)} <input name="${esc(name)}" type="password" autocomplete="off" placeholder="${esc(hint)}"></label>`;
}

/** The run form. Defaults come from the same token fields the step text shows. */
export function runField(input: TokenInput, previous?: string): string {
  const shown = tokenFields(input);
  const label = esc(shown.label);
  if (shown.masked) return secretInput(input.name, shown.label, Boolean(previous));
  if (input.type === "number") return `<label>${label} <input name="${esc(input.name)}" type="number" value="${esc(previous || shown.default)}"></label>`;
  if (input.type === "choice") {
    const opts = (input.choices || []).map((choice) => `<option ${choice === previous ? "selected" : ""}>${esc(choice)}</option>`).join("");
    return `<label>${label} <select name="${esc(input.name)}">${opts}</select></label>`;
  }
  if (input.type === "file") {
    const hint = previous ? `Last file: ${previous}. Drop a file here, or choose one.` : "Drop a file here, or choose one.";
    return `<label class="drop">${label} <input name="${esc(input.name)}" type="file" ${input.multiple ? "multiple" : ""}> <span>${esc(hint)}</span></label>`;
  }
  const text = previous && previous !== "••••" ? previous : shown.default;
  return `<label>${label} <textarea name="${esc(input.name)}" rows="2">${esc(text)}</textarea></label>`;
}

function storedInputsLine(inputs: Record<string, string> | undefined): string {
  const rows = Object.entries(inputs || {});
  if (!rows.length) return "";
  const bits = rows.map(([key, value]) => `${esc(key)}: ${esc(value)}`);
  return `<p class="quiet" id="stored-inputs">${bits.join(" · ")}. A secret is asked again and is not kept in the run.</p>`;
}

export function reviewItems(runs: RunSummary[] | undefined): StepReview[] {
  return stepsNeedingReview(runs || []);
}

export function snapshotPane(dom: SnapshotNode[] | undefined, ax: string | undefined): string {
  const nodes = dom || [];
  const list = nodes.length
    ? `<ol id="dom-snapshot">${nodes.slice(0, 40).map((node) => `<li><code>${esc(node.role || "node")}</code> ${esc(node.name || node.text || "")}${node.testId ? ` <span class="quiet">testId=${esc(node.testId)}</span>` : ""}${node.id ? ` <span class="quiet">id=${esc(node.id)}</span>` : ""}</li>`).join("")}</ol>`
    : `<p class="quiet" id="dom-snapshot">No DOM snapshot for this step.</p>`;
  const axBlock = ax
    ? `<pre id="ax-snapshot">${esc(ax)}</pre>`
    : `<p class="quiet" id="ax-snapshot">No accessibility snapshot for this step.</p>`;
  return `<div id="snapshot-inspector"><h3 class="section">Snapshot</h3><h4>DOM</h4>${list}<h4>Accessibility</h4>${axBlock}</div>`;
}

export function consolePane(lines: ConsoleLine[] | undefined, stepId?: string): string {
  const all = lines || [];
  const mine = stepId ? all.filter((line) => line.stepId === stepId) : all;
  const shown = mine.length ? mine : all;
  const note = mine.length || !all.length ? "" : `<p class="quiet">No console lines on this step. Showing the page load.</p>`;
  if (!shown.length) return `<p class="quiet" id="console-log">No console lines were captured.</p>`;
  const rows = shown.map((line) => {
    const when = typeof line.ts === "number" ? formatClock(line.ts) : "";
    return `<li><span class="quiet">${esc([when, line.type || "log"].filter(Boolean).join(" "))}</span> ${esc(line.text)}</li>`;
  }).join("");
  return `${note}<ol id="console-log">${rows}</ol>`;
}

export function networkPane(lines: NetworkLine[] | undefined, stepId?: string): string {
  const all = lines || [];
  const mine = stepId ? all.filter((line) => line.stepId === stepId) : all;
  const shown = mine.length ? mine : all;
  const note = mine.length || !all.length ? "" : `<p class="quiet">No network lines on this step. Showing the page load.</p>`;
  if (!shown.length) return `<p class="quiet" id="network-log">No network requests were captured.</p>`;
  const rows = shown.map((line) => {
    const when = typeof line.ts === "number" ? formatClock(line.ts) : "";
    return `<li>${esc([when, line.status ?? "", line.method || ""].filter((part) => part !== "").join(" "))} ${esc(line.url)}</li>`;
  }).join("");
  return `${note}<ol id="network-log">${rows}</ol>`;
}

export function inputsPane(inputs: Record<string, string> | undefined): string {
  const rows = Object.entries(inputs || {});
  if (rows.length === 0) return `<p class="quiet">This run stored no inputs.</p>`;
  return `<table class="identity">${rows.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value)}</td></tr>`).join("")}</table>`;
}

export function trailPane(events: { id?: string; ts?: number; op?: string; kind?: string }[]): string {
  if (events.length === 0) return `<p class="quiet">No trail events.</p>`;
  const lines = events.map((event) => {
    const when = typeof event.ts === "number" ? formatClock(event.ts) : "";
    return [when, event.kind || "", event.op || "", event.id || ""].filter(Boolean).join(" ");
  }).join("\n");
  return `<pre id="trail-view">${esc(lines)}</pre>`;
}

function targetLines(identity: { name?: string; text?: string; testId?: string; id?: string; role?: string } | undefined, label?: string): string {
  if (!identity) return esc(label || "no target");
  const bits = [
    identity.role && identity.name ? `${identity.role} "${identity.name}"` : identity.role,
    identity.text ? `text "${identity.text}"` : "",
    identity.id ? `id=${identity.id}` : "",
    identity.testId ? `testId=${identity.testId}` : "",
  ].filter(Boolean);
  return esc(bits.join(" · ") || label || "target");
}

export function healInbox(runs: RunSummary[], workflows: WorkflowSummary[], filter: "pending" | "kept" | "reverted" = "pending"): string {
  const rows = healRows(runs, workflows).filter((row) => row.bucket === filter);
  const list = rows.map((row) => `<button type="button" class="heal-row" data-heal="${esc(row.heal.id)}" data-run="${esc(row.run.id)}">
      <strong>${esc(row.workflow)}</strong> · ${esc(row.step)} · ${esc(row.bucket === "pending" ? "waiting for you" : row.bucket)}
      <span class="quiet">${esc(row.when)}</span>
    </button>`).join("");
  return `<section id="heal-inbox">
    <header class="row"><h2>Heals</h2>
      <button type="button" data-heal-filter="pending">Pending</button>
      <button type="button" data-heal-filter="kept">Kept</button>
      <button type="button" data-heal-filter="reverted">Reverted</button>
    </header>
    ${list || `<p class="quiet">Nothing ${filter}.</p>`}
    <div id="heal-detail"></div>
  </section>`;
}

function healRows(runs: RunSummary[], workflows: WorkflowSummary[]) {
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const rows: { heal: HealView; run: RunSummary; bucket: "pending" | "kept" | "reverted"; workflow: string; step: string; when: string }[] = [];
  for (const run of runs) {
    for (const heal of run.heals || []) {
      const decisions = (run.decisions || []).filter((item) => item.healId === heal.id);
      const last = decisions[decisions.length - 1];
      const bucket = last?.decision === "keep" ? "kept" : last?.decision === "revert" ? "reverted" : "pending";
      rows.push({
        heal,
        run,
        bucket,
        workflow: healWorkflowName(heal, run, names),
        step: heal.failedStep?.label || heal.intent || heal.failedStep?.id || "step",
        when: typeof heal.ts === "number" ? formatWhen(heal.ts) : "",
      });
    }
  }
  return rows;
}

export function healDetail(run: RunSummary, heal: HealView, secrets: string[] = [], extra: { promotion?: PromotionView; workflowName?: string } = {}): string {
  const recorded = heal.failedStep?.identity;
  const proposed = heal.proposedPatch?.identity;
  const before = imageRef(run.id, heal.beforeShot);
  const after = imageRef(run.id, heal.snapshot?.screenshot) || imageRef(run.id, heal.snapshot?.screenshotRef);
  const slider = before || after
    ? `<div class="compare" id="shot-compare" data-before="${esc(before)}" data-after="${esc(after)}">${placeholder(heal.failedStep?.action, heal.failedStep?.label || "Recorded step")}<input id="shot-slider" type="range" min="0" max="100" value="50" aria-label="Screenshot comparison"></div>`
    : `<div class="compare" id="shot-compare">${placeholder(heal.failedStep?.action, heal.failedStep?.label || "No picture stored")}</div>`;
  const prompt = maskSecrets(heal.prompt || "", secrets);
  const raw = maskSecrets(heal.rawResponse || "", secrets);
  const candidates = heal.identity?.candidates?.map((candidate, index) =>
    `#${index + 1} ${esc(candidate.label)} ${candidate.score}`).join("  ") || "No other candidates stored on this record.";
  const post = heal.postconditionPassed === undefined ? "not run" : heal.postconditionPassed ? "passed" : "failed";
  const decisions = (run.decisions || []).filter((item) => item.healId === heal.id);
  const decisionLine = decisions.map((item) => `${item.decision} at ${formatClock(item.ts)}`).join(", ");
  const model = heal.model ? `${heal.model.name || ""} ${heal.model.version || ""}`.trim() : "no model";
  const name = extra.workflowName || healWorkflowName(heal, run, new Map());
  return `<article id="heal-detail" data-heal="${esc(heal.id)}" data-run="${esc(run.id)}">
    <header class="row"><h3>${esc(heal.intent || heal.failedStep?.label || "Heal")}</h3><span class="quiet">${esc(heal.mode || "")} · ${esc(model)}</span></header>
    <p id="heal-workflow">${esc(name)}</p>
    ${promotionLine(extra.promotion || (run.promotion?.healId === heal.id ? run.promotion : undefined))}
    <p class="quiet">candidate → you keep or revert. The heal record is not edited.</p>
    <div class="split">
      <div><h4>Recorded</h4><p>${targetLines(recorded, heal.failedStep?.label)}</p></div>
      <div><h4>Proposed</h4><p>${targetLines(proposed, heal.proposedPatch?.label)}</p></div>
    </div>
    ${slider}
    <p id="heal-candidates">Candidates ${candidates}</p>
    <p>Postcondition after patch: ${esc(post)}</p>
    <details id="heal-prompt"><summary>Prompt</summary><pre>${esc(prompt)}</pre></details>
    <details id="heal-response"><summary>Raw response</summary><pre>${esc(raw)}</pre></details>
    <div class="row">
      <button type="button" class="primary" data-keep="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}">Keep</button>
      <button type="button" data-revert="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}">Revert</button>
    </div>
    <p class="quiet">Keep saves a draft version. Replay keeps using the live version until you promote it. Revert puts the failed step back on the live workflow. Both are appended. ${esc(decisionLine)}</p>
  </article>`;
}

export function libraryTable(workflows: WorkflowSummary[], runs: RunSummary[], promotions: PromotionView[] = []): string {
  const byWorkflow = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const list = byWorkflow.get(run.workflowId) || [];
    list.push(run);
    byWorkflow.set(run.workflowId, list);
  }
  const cards = workflows.map((workflow) => {
    const history = (byWorkflow.get(workflow.id) || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const run = history[0];
    const kind = run ? runKind(run, promotions.find((item) => item.workflowId === workflow.id)) : "";
    const label = run ? statusLabel(kind) : "never run";
    const inputs = (workflow.inputs || []).map((input) => {
      if (input.type === "secret") return `<span class="chip secret">secret</span>`;
      if (input.type === "file") return `<span class="chip">file</span>`;
      return `<span class="chip">{{${esc(input.name)}}}</span>`;
    }).join("");
    const waits = workflow.waits ? `<span class="chip">you · ${workflow.waits}</span>` : "";
    const expects = workflow.expects ? `<span class="badge expect">expect</span>` : "";
    const poster = run
      ? `/api/runs/${encodeURIComponent(run.id)}/poster`
      : `/api/workflows/${encodeURIComponent(workflow.id)}/poster`;
    const thumbLabel = workflow.firstStep?.label || workflow.name;
    return `<article class="wf-card" data-workflow="${esc(workflow.id)}">
      <h3 class="wf-title"><button type="button" class="link" data-open-workflow="${esc(workflow.id)}">${esc(workflow.name)}</button></h3>
      <div class="thumb" data-shot="${esc(poster)}" data-shot-fallback="/api/workflows/${encodeURIComponent(workflow.id)}/poster">${placeholder(workflow.firstStep?.action, thumbLabel)}</div>
      <div class="wf-mid">
        <div class="chips">${inputs}${waits}${expects}</div>
      </div>
      <div class="wf-foot">
        <span class="status ${esc(kind)}">${esc(label)}</span>
        ${sparkline(history)}
        <button type="button" data-screen="replay" data-workflow="${esc(workflow.id)}">Run</button>
      </div>
    </article>`;
  }).join("");
  const empty = `<div class="empty" id="library-empty"><strong>No workflows yet</strong>Capture a task, or import a workflow JSON file.</div>`;
  return `<section id="library">
    <header><h2>Library</h2><p class="lede">Workflows you can run again.</p></header>
    <div class="tools">
      <input id="library-search" type="search" placeholder="Search workflows" aria-label="Search workflows">
      <button type="button" id="palette-open" class="kbd">⌘K</button>
    </div>
    ${workflows.length ? statusLegend() : ""}
    <div class="wf-grid">${cards || empty}</div>
  </section>`;
}

export function notices(items: { id?: string; title?: string; body?: string }[]): string {
  return items.map((item) => `<div class="toast" data-notice="${esc(item.id || item.title || "")}"><div><strong>${esc(item.title)}</strong><div>${esc(item.body)}</div></div><button type="button" data-dismiss="${esc(item.id || item.title || "")}" aria-label="Dismiss">Close</button></div>`).join("");
}

export function healWorkflowName(
  heal: { workflowId?: string; failedStep?: { label?: string }; intent?: string },
  run: { workflowId?: string },
  names: Map<string, string>,
): string {
  const id = heal.workflowId || run.workflowId || "";
  const named = id ? names.get(id) : undefined;
  if (named) return named;
  return heal.failedStep?.label || heal.intent || "this step";
}

export function runKind(run: RunSummary, promotion?: PromotionView): string {
  if (run.status === "timed-out") return "timed-out";
  if (promotion?.status === "provisional" || run.promotion?.status === "provisional") return "provisional";
  if (run.status === "paused") return "paused";
  if (run.status === "failed") return "failed";
  if ((run.heals || []).length > 0) return "healed";
  return "passed";
}

export function statusLabel(kind: string): string {
  if (kind === "timed-out") return "stopped, timed out";
  if (kind === "paused") return "needs you";
  if (kind === "failed") return "failed";
  if (kind === "healed") return "healed";
  if (kind === "provisional") return "provisional";
  if (kind === "passed") return "passed";
  return kind || "never run";
}

function sparkline(runs: RunSummary[]): string {
  const recent = runs.slice().sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-8);
  if (!recent.length) return `<p class="meta">No runs yet</p>`;
  return `<div class="spark" aria-label="${recent.length} recent runs">${recent.map((run) => {
    const kind = runKind(run);
    return `<i class="swatch ${esc(kind)}" title="${esc(statusLabel(kind))}"></i>`;
  }).join("")}</div>`;
}

export function plainFailure(input: {
  phase?: string;
  changed?: string;
  reason?: string;
  repairs?: { repair: string; detail?: string }[];
  authRecovered?: boolean;
}): string {
  const phase = input.phase || "";
  if (phase === "auth") {
    return input.authRecovered
      ? "Phase auth. The page redirected to a login. Bao waited and continued. It did not heal the redirect."
      : "Phase auth. The page redirected to a login. Bao stopped and did not heal the redirect.";
  }
  const bits = [`Phase ${phase || "the step"}.`];
  if (input.changed) bits.push(`What changed: ${input.changed}.`);
  else if (input.reason) bits.push(`Bao stopped because ${input.reason}.`);
  const repairs = input.repairs || [];
  if (repairs.length === 0) bits.push("Bao did not try a cheap repair.");
  else bits.push(`Bao tried ${repairs.map((item) => `${item.repair}${item.detail ? ` (${item.detail})` : ""}`).join(", then ")}.`);
  return bits.join(" ");
}

export function repairLines(repairs: { repair: string; detail?: string }[]): string {
  if (!repairs.length) return `<p class="quiet" id="repairs">No cheap repair ran on this step.</p>`;
  return `<ul id="repairs">${repairs.map((item) => `<li><span class="chip">${esc(item.repair)}</span> ${esc(item.detail || "")}</li>`).join("")}</ul>`;
}

export function receiptLines(receipts: { source?: string; expected?: string; actual?: string; pass?: boolean }[]): string {
  if (!receipts.length) return `<p class="quiet" id="receipts">No read-back on this step.</p>`;
  return `<ul id="receipts">${receipts.map((item) => {
    const word = item.pass ? "matches" : "does not match";
    return `<li class="${item.pass ? "passed" : "failed"}">Read back ${esc(item.source || "value")}: expected ${esc(item.expected || "")}, saw ${esc(item.actual || "")}. ${word}.</li>`;
  }).join("")}</ul>`;
}

function runClock(at: number | undefined): string {
  return typeof at === "number" ? formatClock(at) : "—";
}

function runTitle(run: RunSummary): string {
  if (typeof run.at !== "number") return run.id;
  return `${run.id} · ${formatWhen(run.at)}`;
}

export function passGrid(runs: RunSummary[], steps: { id: string; label?: string }[]): string {
  const cols = [...runs].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-8);
  if (!cols.length || !steps.length) return "";
  const head = cols.map((run) => {
    return `<th scope="col" title="${esc(runTitle(run))}"><time>${esc(runClock(run.at))}</time></th>`;
  }).join("");
  const body = steps.map((step) => {
    const cells = cols.map((run) => {
      const found = (run.steps || []).find((item) => item.id === step.id);
      const healed = (run.heals || []).some((heal) => heal.failedStep?.id === step.id) && found?.status === "passed";
      const kind = !found ? "empty" : found.status === "paused" ? "paused" : found.status === "failed" ? "failed" : healed ? "healed" : found.status === "passed" ? "passed" : "empty";
      const label = kind === "paused" ? "needs you" : kind === "empty" ? "not run" : kind;
      return `<td title="${esc(`${runTitle(run)} · ${label}`)}"><span class="cell ${kind}"></span></td>`;
    }).join("");
    return `<tr><th scope="row">${esc(step.label || step.id)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="grid-wrap"><h3 class="section">Recent runs</h3>${statusLegend()}<table id="pass-grid" aria-label="Recent runs"><thead><tr><th scope="col"></th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function trajectoryPane(recorded: TrajectoryStep[] | undefined, replayed: TrajectoryStep[] | undefined): string {
  if (!replayed || replayed.length === 0) return `<details id="trajectory"><summary>Trajectory</summary><p class="meta">No trajectory was stored for this run.</p></details>`;
  const lines = recorded && recorded.length
    ? diffTrajectory(recorded, replayed)
    : replayed.map((step) => `Replay ${step.stepId}: ${step.action} on ${step.target}, ${step.postcondition}, ${bucketWords(step.timing as TimingBucket)}.`);
  return `<details id="trajectory"><summary>Trajectory</summary><ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></details>`;
}

export function promotionLine(promotion: PromotionView | undefined): string {
  if (!promotion?.status) return "";
  if (promotion.status === "promoted") {
    return `<p id="promotion" data-status="promoted">Promoted. Drift passed and ${promotion.replays ?? 2} later replays passed.</p>`;
  }
  if (promotion.status === "reverted") {
    return `<p id="promotion" data-status="reverted">Reverted. ${esc(promotion.reason || "A later check failed")} put the saved step back.</p>`;
  }
  const drift = promotion.drift === "passed" ? "Drift passed." : promotion.drift === "failed" ? "Drift failed." : "Drift is still pending.";
  const need = promotion.need && promotion.need > 0 ? promotion.need : DEFAULT_PROMOTE_AFTER;
  return `<p id="promotion" data-status="provisional">Provisional. ${drift} ${promotion.replays ?? 0} of ${need} later real runs have passed.</p>`;
}

export interface StepCard {
  id: string;
  index?: number;
  action?: string;
  label?: string;
  intent?: string;
  human?: boolean;
  sensitive?: boolean;
  input?: string;
  value?: string;
  expect?: { kind?: string };
  readBack?: { source?: string };
  identity?: { role?: string; name?: string; text?: string; testId?: string; id?: string };
  heal?: string;
  when?: { input?: string; value?: string; present?: string };
}

export function identityChip(identity: StepCard["identity"]): string {
  if (!identity) return "";
  const bits = [
    identity.role,
    identity.name || identity.text,
    identity.testId ? `testId ${identity.testId}` : "",
    identity.id ? `id ${identity.id}` : "",
  ].filter(Boolean);
  if (!bits.length) return "";
  return `<span class="chip id-chip">${esc(bits.join(" · "))}</span>`;
}

export function inputToken(input: TokenInput): string {
  const shown = tokenFields(input);
  const bits = [`<span class="token-label">${esc(shown.label)}</span>`, `<span class="token-meta">${esc(shown.type)}</span>`];
  if (shown.masked) bits.push(`<span class="token-meta">••••</span>`);
  else if (shown.default) bits.push(`<span class="token-meta">${esc(shown.default)}</span>`);
  bits.push(`<span class="token-meta">${shown.required ? "required" : "optional"}</span>`);
  const secret = shown.masked ? " secret" : "";
  return `<button type="button" class="token${secret}" data-edit-input="${esc(input.name)}" data-type="${esc(shown.type)}" data-label="${esc(shown.label)}" data-default="${esc(shown.default)}" data-required="${shown.required ? "1" : "0"}">${bits.join("")}</button>`;
}

export function renderStepText(text: string, inputs: TokenInput[]): string {
  return text.split(/(\{\{\s*[\w.-]+\s*\}\})/g).map((part) => {
    const match = part.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (!match) return esc(part);
    const input = inputs.find((item) => item.name === match[1]);
    if (!input) return esc(part);
    return inputToken(input);
  }).join("");
}

function mustacheName(value: string | undefined): string {
  return value?.match(/\{\{\s*([\w.-]+)\s*\}\}/)?.[1] || "";
}

function stepHeadline(step: StepCard, inputs: TokenInput[]): { html: string; token: boolean } {
  const raw = step.label || step.action || step.id;
  let html = inputs.length ? renderStepText(raw, inputs) : esc(raw);
  let token = html.includes("data-edit-input");
  const name = step.input || mustacheName(step.value);
  if (!token && name) {
    const input = inputs.find((item) => item.name === name);
    if (input) {
      html = `${html} ${inputToken(input)}`;
      token = true;
    }
  }
  return { html, token };
}

export function inputChips(step: StepCard, token = false): string {
  const chips: string[] = [];
  if (!token) {
    const template = step.value && step.value.includes("{{") ? step.value : step.input ? `{{${step.input}}}` : "";
    if (template) chips.push(`<span class="chip">${esc(template)}</span>`);
    if (step.sensitive) chips.push(`<span class="chip secret">secret</span>`);
  }
  if (step.action === "upload" || step.action === "drop") chips.push(`<span class="chip">file</span>`);
  return chips.join("");
}

function expectBadge(step: StepCard): string {
  if (step.action === "verify") return `<span class="badge expect">verify</span>`;
  if (step.expect) return `<span class="badge expect">expect</span>`;
  if (step.readBack) return `<span class="badge expect">read back</span>`;
  return "";
}

export function tryResult(result: {
  matched?: boolean;
  actions?: number;
  modelCalls?: number;
  identity?: IdentityView;
  preview?: string;
  reason?: string;
  error?: string;
}): string {
  if (result.error) return `<div id="try-result" data-matched="0"><p class="notice">${esc(result.error)}</p></div>`;
  const img = imageRef("try", result.preview);
  const picture = img ? `<img class="try-outline" alt="Outlined match" src="${img}">` : "";
  const lead = typeof result.identity?.lead === "number" ? `<p id="try-lead">lead ${result.identity.lead}</p>` : "";
  const status = result.matched ? "Matched" : `No match${result.reason ? `: ${result.reason}` : ""}`;
  const actions = result.actions ?? 0;
  const calls = result.modelCalls ?? 0;
  return `<div id="try-result" data-matched="${result.matched ? "1" : "0"}" data-actions="${actions}" data-model-calls="${calls}">
    <p><strong>${esc(status)}</strong> <span class="quiet">${actions} actions · ${calls} model calls</span></p>
    ${picture}
    ${lead}
    ${identityTable(result.identity)}
  </div>`;
}

export function siteTrustPanel(sites: { origin: string; mode: "ask" | "allow" }[]): string {
  const rows = sites.map((site) => `<label>${esc(site.origin)}
      <select data-site-trust="${esc(site.origin)}">
        <option value="ask" ${site.mode === "ask" ? "selected" : ""}>Always ask</option>
        <option value="allow" ${site.mode === "allow" ? "selected" : ""}>Allow</option>
      </select>
    </label>`).join("");
  const body = rows || `<p class="quiet">No sites yet. A site shows up here from a workflow's start address.</p>`;
  return `<section id="site-trust">
    <h3>Site trust</h3>
    <p class="quiet">Always ask waits before an ordinary click or type on that site. Allow runs those. Confirm and Apply still wait for you. This is separate from when a step misses.</p>
    ${body}
  </section>`;
}

export function workflowDetail(
  doc: { id: string; name: string; steps: StepCard[]; inputs?: TokenInput[] },
  meta: {
    lastRunId?: string;
    lastLabel?: string;
    shots?: Record<string, string>;
    share?: { link?: string; publishEnabled?: boolean; publishWhy?: string; exportEnabled?: boolean; exportWhy?: string };
  } = {},
): string {
  const inputs = doc.inputs || [];
  const cards = doc.steps.map((step, index) => {
    const human = step.human || step.action === "login" || step.action === "confirm";
    const known = meta.shots?.[step.id] || "";
    const runShot = meta.lastRunId ? `/api/runs/${encodeURIComponent(meta.lastRunId)}/shots/${encodeURIComponent(shotFile(step.id, "after"))}` : "";
    const captured = `/api/workflows/${encodeURIComponent(doc.id)}/shots/${encodeURIComponent(workflowShotName(step.id))}`;
    const shot = known || runShot || captured;
    const fallback = shot === captured ? "" : captured;
    const face = known ? `<img src="${esc(known)}" alt="">` : "";
    const headline = stepHeadline(step, inputs);
    const n = index + 1;
    const branch = step.when?.present
      ? `<span class="badge route" data-present="${esc(step.when.present)}">when ${esc(step.when.present)}</span>`
      : step.when?.value
        ? `<span class="badge route" data-route="${esc(step.when.value)}">route: ${esc(step.when.value)}</span>`
        : "";
    return `<article class="step-card ${human ? "human" : ""}" data-step-card="${esc(step.id)}">
      <div class="thumb${known ? " has-shot" : ""}" data-shot="${esc(shot)}" ${fallback ? `data-shot-fallback="${esc(fallback)}"` : ""}>${face}${placeholder(step.action, step.label || step.action || step.id)}</div>
      <div class="step-copy">
        <div class="row"><strong>${headline.html}</strong> ${branch} ${expectBadge(step)} ${human ? `<span class="badge you">you</span>` : ""}</div>
        <p class="meta">${esc(step.intent || (human ? "This step waits for you." : ""))}</p>
        <div class="chips">${identityChip(step.identity)}${inputChips(step, headline.token)}</div>
        <label class="meta">If this step misses <select data-step-heal="${esc(step.id)}">
          <option value="" ${step.heal ? "" : "selected"}>Use the workflow setting</option>
          <option value="auto" ${step.heal === "auto" ? "selected" : ""}>Auto</option>
          <option value="ask" ${step.heal === "ask" ? "selected" : ""}>Ask</option>
          <option value="never" ${step.heal === "never" ? "selected" : ""}>Never</option>
        </select></label>
        <div class="row step-actions">
          <button type="button" data-try-step="${esc(step.id)}">Try</button>
          <button type="button" data-run-from="${esc(step.id)}" data-step-n="${n}">Run from step ${n}</button>
        </div>
        <div class="try-slot" data-try-slot="${esc(step.id)}"></div>
      </div>
    </article>`;
  }).join("");
  const headerChips = (doc.inputs || []).flatMap((input) => {
    if (input.type === "secret") return [`<span class="chip secret">secret</span>`];
    if (input.type === "file") return [`<span class="chip">file</span>`];
    if (input.type === "choice") return [];
    return [`<span class="chip">{{${esc(input.name)}}}</span>`];
  }).join("");
  const choice = (doc.inputs || []).find((input) => input.type === "choice" && input.choices?.length);
  const routeHead = choice?.choices
    ? `<p id="route-branch" data-routes="${esc(choice.choices.join("|"))}">Routes: ${esc(choice.choices.join(" / "))}</p>`
    : "";
  return `<section id="workflow-detail" data-workflow="${esc(doc.id)}">
    <p class="crumb"><button type="button" class="link" data-screen="library">Library</button> <span aria-hidden="true">/</span> ${esc(doc.name)}</p>
    <header class="wf-head">
      <div>
        <h2>${esc(doc.name)}</h2>
        <p class="meta">${esc(meta.lastLabel || "Not run yet")}</p>
        <div class="chips">${headerChips}</div>
        ${routeHead}
        ${shareMenu(doc, meta.share)}
      </div>
      <button type="button" class="primary" data-screen="replay" data-workflow="${esc(doc.id)}">Run</button>
    </header>
    <h3 class="section">Steps</h3>
    <div id="workflow-steps">${cards || `<div class="empty"><strong>No steps yet</strong>Record a capture to fill this workflow.</div>`}</div>
  </section>`;
}

function shareMenu(
  doc: { id: string; steps: { id: string }[] },
  share: { link?: string; publishEnabled?: boolean; publishWhy?: string; exportEnabled?: boolean; exportWhy?: string } = {},
): string {
  const link = share.link || `bao://workflow/${doc.id}`;
  const publishEnabled = share.publishEnabled === true;
  const exportEnabled = share.exportEnabled !== undefined ? share.exportEnabled : doc.steps.length > 0;
  const publishWhy = publishEnabled ? "" : (share.publishWhy || "Pair this Mac before listing.");
  const exportWhy = exportEnabled ? "" : (share.exportWhy || "This workflow has no steps to export.");
  return `<div class="share" data-testid="share-menu">
    <button type="button" data-testid="share-open" aria-expanded="false" aria-haspopup="menu">Share</button>
    <div class="share-panel" data-testid="share-panel" hidden role="menu">
      <button type="button" role="menuitem" data-testid="share-copy" data-copy="${esc(link)}">Copy link</button>
      <button type="button" role="menuitem" data-testid="share-publish"${publishEnabled ? "" : " disabled"}>Publish to marketplace</button>
      ${publishWhy ? `<p class="share-why" data-testid="share-publish-why">${esc(publishWhy)}</p>` : ""}
      <button type="button" role="menuitem" data-testid="share-export"${exportEnabled ? "" : " disabled"}>Export file</button>
      ${exportWhy ? `<p class="share-why" data-testid="share-export-why">${esc(exportWhy)}</p>` : ""}
    </div>
  </div>`;
}

export interface VersionRow {
  n: number;
  role: string;
  source: string;
  createdAt: number;
  /** The locator this version holds. The panel lists these and no second history. */
  locator?: {
    stepId: string;
    source: string;
    at: number;
    runId?: string;
    score?: number;
    changed: string[];
  };
  diff?: string;
  steps?: { id: string; label: string; before: string; after: string; changed: boolean }[];
  deviceName?: string;
  history?: {
    stepId: string;
    source: string;
    at: number;
    runId?: string;
    score?: number;
    changed: string[];
  }[];
  conflict?: {
    mineDevice: string;
    theirsDevice: string;
    remoteVersion: number;
    sides: { id: string; leftLabel: string; leftDetail: string; rightLabel: string; rightDetail: string; changed: boolean }[];
  };
}

function versionChange(version: VersionRow): string {
  const line = version.diff
    ? `<p class="version-diff" data-testid="version-diff">${esc(version.diff)}</p>`
    : "";
  const steps = (version.steps || []).map((step) => {
    const arrow = step.before
      ? `<span>${esc(step.before)}</span><span aria-hidden="true">→</span>`
      : "";
    return `<li data-testid="version-step" data-changed="${step.changed ? "true" : "false"}"><span>${esc(step.label)}</span>${arrow}<span>${esc(step.after)}</span></li>`;
  }).join("");
  const details = steps
    ? `<details class="version-steps" data-testid="version-steps"><summary>Before and after</summary><ol>${steps}</ol></details>`
    : "";
  return line + details;
}

/** A conflict draft counts steps that differ. A locator row lists the attributes that moved. */
function changedPhrase(version: VersionRow, locator: { changed: string[] }): string {
  if (version.conflict) {
    const n = version.conflict.sides.filter((side) => side.changed).length;
    if (n === 1) return "1 step";
    if (n > 1) return `${n} steps`;
    return "none";
  }
  return locator.changed.length ? locator.changed.join(", ") : "none";
}

function locatorHeld(version: VersionRow): string {
  const rows = version.history?.length ? version.history : version.locator ? [version.locator] : [];
  if (!rows.length) return "";
  const body = rows.map((locator) => {
    const changed = changedPhrase(version, locator);
    return `<tr data-locator-source="${esc(locator.source)}" data-score="${locator.score ?? ""}" data-step="${esc(locator.stepId)}">
      <td><time>${esc(formatClock(locator.at))}</time></td>
      <td>${esc(locator.source)}</td>
      <td>${esc(locator.runId || "—")}</td>
      <td>${locator.score ?? ""}</td>
      <td data-testid="version-changed">${esc(changed)}</td>
    </tr>`;
  }).join("");
  return `<table class="locator-history" data-testid="locator-history">
    <thead><tr><th>When</th><th>Source</th><th>Run</th><th>Score</th><th>Changed</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function conflictView(version: VersionRow): string {
  const conflict = version.conflict;
  if (!conflict) return "";
  const column = (device: string, pick: "left" | "right") => `<div data-testid="conflict-column" data-device="${esc(device)}">
    <h4>${esc(device)}</h4>
    <ol>${conflict.sides.map((side) => {
      const label = pick === "left" ? side.leftLabel : side.rightLabel;
      const detail = pick === "left" ? side.leftDetail : side.rightDetail;
      return `<li data-changed="${side.changed ? "true" : "false"}"><strong>${esc(label)}</strong><span>${esc(detail)}</span></li>`;
    }).join("")}</ol>
  </div>`;
  return `<p class="conflict-banner" data-testid="conflict-banner">Changed on ${esc(conflict.theirsDevice)} and ${esc(conflict.mineDevice)}</p>
    <div class="conflict-diff" data-testid="conflict-diff">
      ${column(conflict.theirsDevice, "left")}
      ${column(conflict.mineDevice, "right")}
    </div>
    <div class="row">
      <button type="button" class="primary" data-resolve="keep-mine" data-testid="keep-mine">Keep mine</button>
      <button type="button" data-resolve="keep-theirs" data-testid="keep-theirs">Keep theirs</button>
      <button type="button" data-resolve="keep-both" data-testid="keep-both">Keep both as a copy</button>
    </div>`;
}

export function versionsPanel(versions: VersionRow[]): string {
  const rows = versions.map((version) => {
    const role = version.role === "live" ? "Live" : version.role === "draft" ? "Draft" : "Past";
    const source = version.source === "heal" ? "Heal" : version.source === "edit" ? "Edit" : version.source === "restore" ? "Restore" : version.source === "conflict" ? "Conflict" : "Saved";
    const promote = version.role === "draft" && !version.conflict
      ? `<button type="button" class="primary" data-promote-version="${esc(version.n)}">Promote</button>`
      : "";
    const actions = version.conflict
      ? ""
      : `<div class="row">
        <button type="button" data-restore-version="${esc(version.n)}">Restore as draft</button>
        ${promote}
      </div>`;
    return `<li data-testid="version" data-version="${esc(version.n)}" data-role="${esc(version.role)}">
      <div class="row">
        <strong>v${esc(version.n)}</strong>
        <span class="badge">${esc(role)}</span>
        <span class="quiet">${esc(source)}</span>
        ${version.deviceName ? `<span class="quiet" data-testid="version-device">${esc(version.deviceName)}</span>` : ""}
        <time data-testid="version-time">${esc(formatClock(version.createdAt))}</time>
      </div>
      ${locatorHeld(version)}
      ${version.conflict ? conflictView(version) : versionChange(version)}
      ${actions}
    </li>`;
  }).join("");
  return `<section class="card" id="versions" data-testid="versions">
    <h3>Versions</h3>
    <p class="quiet">Replay uses the live version. A heal or an edit is a draft until you promote it.</p>
    <ol class="versions">${rows || `<li class="quiet">No versions yet.</li>`}</ol>
  </section>`;
}

export function runsList(runs: RunSummary[], workflows: WorkflowSummary[]): string {
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  if (!runs.length) {
    return `<section id="runs"><h2>Runs</h2><div class="empty"><strong>No runs yet</strong>Open a workflow and run it.</div></section>`;
  }
  const rows = runs.map((run) => {
    const kind = runKind(run);
    const calls = run.modelCalls ?? (run.heals || []).filter((heal) => heal.model).length;
    const bolt = calls === 0 ? `<span class="badge quiet-badge">0 model calls</span>` : "";
    const when = typeof run.at === "number" ? formatWhen(run.at) : "";
    return `<tr><td><button type="button" class="link" data-open-run="${esc(run.id)}">${esc(names.get(run.workflowId) || run.workflowId)}</button></td><td><span class="status ${esc(kind)}">${esc(statusLabel(kind))}</span> ${bolt}</td><td>${esc(when)}</td><td>${esc(run.id)}</td></tr>`;
  }).join("");
  return `<section id="runs"><h2>Runs</h2><table class="grid"><thead><tr><th>Workflow</th><th>Status</th><th>When</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function commandItems(workflows: { id: string; name: string }[]): CommandItem[] {
  const screens: CommandItem[] = [
    { id: "library", label: "Library", kind: "screen", screen: "library", hint: "Go" },
    { id: "capture", label: "Capture", kind: "screen", screen: "capture", hint: "Go" },
    { id: "teach", label: "Teach", kind: "screen", screen: "teach", hint: "Go" },
    { id: "runs", label: "Runs", kind: "screen", screen: "runs", hint: "Go" },
    { id: "heals", label: "Heals", kind: "screen", screen: "heals", hint: "Go" },
    { id: "settings", label: "Settings", kind: "screen", screen: "settings", hint: "Go" },
    { id: "theme", label: "Toggle appearance", kind: "theme", hint: "Light or dark" },
  ];
  const open = workflows.map((workflow) => ({ id: `open-${workflow.id}`, label: `Open ${workflow.name}`, kind: "workflow" as const, workflowId: workflow.id, hint: "Workflow" }));
  const run = workflows.map((workflow) => ({ id: `run-${workflow.id}`, label: `Run ${workflow.name}`, kind: "workflow" as const, workflowId: workflow.id, screen: "replay", hint: "Run" }));
  return [...screens, ...open, ...run];
}

export function paletteView(items: CommandItem[], query: string, active: number): string {
  const q = query.trim().toLowerCase();
  const shown = items.filter((item) => !q || item.label.toLowerCase().includes(q));
  const rows = shown.map((item, index) =>
    `<button type="button" class="hit ${index === active ? "on" : ""}" data-command="${esc(item.id)}">${esc(item.label)} <span class="quiet">${esc(item.hint || "")}</span></button>`).join("");
  return `<div class="panel" role="dialog" aria-label="Commands">
    <input id="palette-input" placeholder="Jump to a workflow or screen" value="${esc(query)}" aria-label="Command">
    <div id="palette-list">${rows || `<p class="quiet">No matches.</p>`}</div>
  </div>`;
}

export interface TeachCardView {
  id: string;
  intent: string;
  outcome: string;
  narrator: "heuristic" | "model";
  modelName?: string;
  human: boolean;
  verify: boolean;
  dropped: boolean;
  merged: boolean;
  note: string;
  action: string;
  values: { role: string; name: string; label: string }[];
}

export interface TeachView {
  phase?: "idle" | "live" | "review";
  paused?: boolean;
  since?: number;
  blur?: boolean;
  blurredShots?: number;
  narrator?: string;
  fix?: { workflowId: string; stepId: string } | null;
  error?: string;
  cards?: TeachCardView[];
  decisions?: { kind: string; detail: string; cardId: string }[];
  review?: {
    summary?: { line: string; dropped: { id: string; reason: string }[] };
    raw: { id?: string; op?: string; kind?: string; detail?: string; reason?: string }[];
    decisions?: { kind: string; detail: string; cardId: string }[];
    workflow: {
      name: string;
      inputs: { name: string; type: string }[];
      steps: { id: string; label?: string; intent?: string; action?: string; human?: boolean; value?: string; input?: string; sensitive?: boolean }[];
    };
  };
}

function cropPlaceholder(action: string): string {
  return `<div class="ph"><span class="ph-ico">${glyph(action)}</span></div>`;
}

function captureShot(id: string): string {
  return `/api/capture/shots/${encodeURIComponent(id)}.png`;
}

function valueChip(value: { role: string; label: string }): string {
  if (value.role === "secret") return `<span class="chip secret">secret</span>`;
  return `<span class="chip">${esc(value.label)}</span>`;
}

function editedNote(decisions: { kind: string; detail: string; cardId: string }[] | undefined, cardId: string): string {
  const details = (decisions || [])
    .filter((decision) => decision.cardId === cardId && decision.kind !== "drop" && decision.kind !== "check")
    .map((decision) => decision.detail)
    .filter(Boolean);
  if (!details.length) return "";
  return `<span class="badge edited" title="${esc(details.join(", "))}">edited</span>`;
}

function teachList(teach: TeachView, edit: boolean): string {
  const cards = teach.cards || [];
  const kept = cards.filter((card) => !card.dropped && !card.merged);
  const newest = kept[kept.length - 1]?.id;
  const rows = kept.map((card) => teachCard(card, {
    edit,
    on: card.id === newest,
    edited: editedNote(teach.decisions, card.id),
  })).join("");
  const dropped = cards.filter((card) => card.dropped);
  const pile = dropped.length
    ? `<details class="teach-dropped"><summary>Dropped (${dropped.length})</summary>${dropped.map((card) => `<p>${esc(card.intent)}</p>`).join("")}</details>`
    : "";
  return `${rows}${pile}`;
}

export function teachPanel(teach: TeachView): string {
  const paused = teach.paused ? "Resume" : "Pause";
  const who = teach.narrator === "model" ? "model" : "heuristic";
  const list = teachList(teach, true);
  return `<section id="teach-panel" data-phase="live" data-paused="${teach.paused ? "true" : "false"}">
    <div id="teach-bar">
      <span class="rec-dot" aria-hidden="true"></span>
      <span id="rec-timer" data-since="${teach.since || 0}">0:00</span>
      <span class="badge quiet-badge" id="teach-narrator">${esc(who)}</span>
      <button type="button" id="teach-pause">${paused}</button>
      <button type="button" id="teach-stop">Stop</button>
      <button type="button" id="teach-check">Add check</button>
      <button type="button" id="teach-discard">Discard</button>
      <span class="quiet" id="teach-blur">Sensitive fields blurred</span>
    </div>
    <div id="teach-cards">${list || `<p class="meta">Steps show up here as you demonstrate. Click a step to correct it.</p>`}</div>
  </section>`;
}

export function teachCard(card: TeachCardView, opts: { edit?: boolean; on?: boolean; edited?: string } = {}): string {
  const who = card.narrator === "model" ? `model${card.modelName ? ` · ${card.modelName}` : ""}` : "heuristic";
  const chip = card.values[0] ? valueChip(card.values[0]) : "";
  const flags = [
    card.human ? `<span class="badge you">you</span>` : "",
    card.verify ? `<span class="badge expect">check</span>` : "",
  ].join("");
  const row = `<span class="thumb mini" data-shot="${esc(captureShot(card.id))}">${cropPlaceholder(card.action)}</span>
      <span class="intent-read">${esc(card.intent)}</span>
      ${chip}${flags}${opts.edited || ""}`;
  const head = opts.edit
    ? `<button type="button" class="teach-row" aria-expanded="false">${row}</button>`
    : `<div class="teach-row">${row}</div>`;
  const values = card.values.map((value) => {
    const param = value.role === "constant" ? "" : `<input data-param value="${esc(value.name)}" aria-label="Parameter name">`;
    return `<div class="row teach-value" data-role="${esc(value.role)}">${valueChip(value)}${param}
      <button type="button" data-correct="input">Input</button>
      <button type="button" data-correct="constant">Constant</button>
      <button type="button" data-correct="secret">Secret</button>
    </div>`;
  }).join("");
  const editor = opts.edit ? `<div class="teach-edit">
      <span class="badge quiet-badge" data-narrator="${esc(card.narrator)}">${esc(who)}</span>
      <label>Rename <input class="intent" data-intent value="${esc(card.intent)}" aria-label="Intent"></label>
      ${card.outcome ? `<p class="meta">Expected: ${esc(card.outcome)}</p>` : ""}
      ${values}
      <div class="row teach-actions">
        <button type="button" data-correct="human">You do this</button>
        <button type="button" data-correct="verify">Check</button>
        <button type="button" data-correct="drop">Drop</button>
        <button type="button" data-correct="merge">Merge</button>
      </div>
      <label>Note <input class="note" data-note value="${esc(card.note)}" placeholder="Saved as this step's intent" aria-label="Note"></label>
    </div>` : "";
  const classes = ["step-card", "teach-card", card.human ? "human" : "", opts.on ? "on" : ""].filter(Boolean).join(" ");
  return `<article class="${classes}" data-card="${esc(card.id)}" data-narrator="${esc(card.narrator)}">
    ${head}
    ${editor}
  </article>`;
}

export function teachReview(teach: TeachView): string {
  const review = teach.review;
  if (!review) return `<section id="teach-review"><h2>Review</h2><p class="quiet">Stop teaching to review the workflow.</p></section>`;
  const raw = review.raw.map((event) => {
    const label = event.kind === "decision" ? `decision · ${event.detail || event.op}` : `${event.op || event.kind}`;
    const why = event.reason ? ` — ${event.reason}` : "";
    return `<li data-event="${esc(event.id || "")}">${esc(label + why)}</li>`;
  }).join("");
  const summary = review.summary;
  const dropped = summary?.dropped || [];
  const summaryHtml = summary
    ? `<p id="teach-summary">${esc(summary.line)}</p>${dropped.length ? `<ul id="teach-dropped-reasons">${dropped.map((item) => `<li data-event="${esc(item.id)}">${esc(item.id)} — ${esc(item.reason)}</li>`).join("")}</ul>` : ""}`
    : "";
  return `<section id="teach-review">
    <header class="wf-head">
      <div>
        <h2>Review</h2>
        <p class="lede">These steps are what will replay. The raw trail stays beside them.</p>
      </div>
      <button type="button" class="primary" id="teach-save">Save</button>
    </header>
    ${summaryHtml}
    <div class="teach-review-body">
      <div id="teach-steps">${teachList(teach, false) || `<p class="quiet">No steps.</p>`}</div>
      <details id="teach-trail">
        <summary>Raw trail</summary>
        <ol id="teach-raw">${raw}</ol>
      </details>
    </div>
  </section>`;
}

export function teachHome(workflows: { id: string; name: string }[]): string {
  const choices = workflows.map((workflow) => `<label class="row"><input type="checkbox" name="merge" value="${esc(workflow.id)}"> ${esc(workflow.name)}</label>`).join("");
  return `<section id="teach-home">
    <h2>Teach</h2>
    <p class="lede">Show Bao a flow once. It narrates each step. Correct it on the spot, and the saved workflow keeps the intent.</p>
    <div class="card">
      <label>Start URL <input id="teach-url" value="${esc(typeof location !== "undefined" ? `${location.origin}/fixture` : "/fixture")}"></label>
      <button class="primary" id="teach-start" type="button">Start teaching</button>
    </div>
    <div class="card">
      <h3>Merge demonstrations</h3>
      <p class="quiet">Two or more saved takes of the same task. Steps they share stay. Steps that differ become a branch.</p>
      ${choices || `<p class="quiet">Save a workflow first.</p>`}
      <button type="button" id="teach-merge">Merge</button>
    </div>
  </section>`;
}

export function recordBar(state: { recording?: boolean; capturePaused?: boolean; recordingSince?: number }): string {
  if (!state.recording) return "";
  const paused = state.capturePaused ? "Resume" : "Pause";
  return `<div id="record-bar" data-paused="${state.capturePaused ? "true" : "false"}">
    <span class="rec-dot" aria-hidden="true"></span>
    <span id="rec-timer" data-since="${state.recordingSince || 0}">0:00</span>
    <button type="button" id="rec-pause">${paused}</button>
    <button type="button" id="rec-mark">Mark step</button>
    <button type="button" id="rec-stop">Stop</button>
  </div>`;
}

export function liveStepList(events: { id?: string; op?: string; kind?: string }[]): string {
  if (!events.length) return `<p class="meta" id="live-steps-empty">Steps show up here as you record.</p>`;
  return `<ol id="live-step-list">${events.map((event, index) => {
    const shot = event.id ? `/api/capture/shots/${encodeURIComponent(event.id)}.png` : "";
    const label = event.op || event.kind || "step";
    return `<li class="live-step"><div class="thumb mini" ${shot ? `data-shot="${esc(shot)}"` : ""}>${placeholder(event.op, label)}</div><span><span class="meta">${index + 1}</span> ${esc(label)}</span></li>`;
  }).join("")}</ol>`;
}

/** Mac only, and only while Accessibility or Screen Recording is still missing. */
export function macPermissionMissing(helper?: { platform?: string; accessibility?: boolean; screenCapture?: boolean }): boolean {
  return helper?.platform === "darwin" && (!helper.accessibility || !helper.screenCapture);
}

function permRows(helper?: { accessibility?: boolean; screenCapture?: boolean }): string {
  const access = !!helper?.accessibility;
  const screen = !!helper?.screenCapture;
  return `<ul class="perms">
      <li class="perm" data-perm="accessibility" data-ok="${access ? "true" : "false"}"><span class="mark"></span><span><strong>Accessibility</strong> ${access ? "allowed" : "not granted yet"}</span></li>
      <li class="perm" data-perm="screen" data-ok="${screen ? "true" : "false"}"><span class="mark"></span><span><strong>Screen Recording</strong> ${screen ? "allowed" : "not granted yet"}</span></li>
    </ul>`;
}

export function onboarding(helper?: { label?: string; platform?: string; accessibility?: boolean; screenCapture?: boolean }): string {
  if (!macPermissionMissing(helper)) return "";
  return `<section id="onboarding">
    <details>
      <summary>Two permissions on the Mac</summary>
      <p>Accessibility lets bao see the control you used. Screen Recording lets bao keep a picture of each step. The marks follow the helper. Here the helper reports “${esc(helper?.label || "helper needs permission")}”.</p>
      ${permRows(helper)}
      <button type="button" id="onboard-done">Continue</button>
    </details>
  </section>`;
}

/** Collapsed sidebar mark. The Library card is the other place this list appears. */
export function permissionDot(helper?: { platform?: string; accessibility?: boolean; screenCapture?: boolean }): string {
  if (!macPermissionMissing(helper)) return "";
  return `<details id="perm-dot"><summary title="Mac permissions still missing"><span class="dot need" id="perm-mark"></span></summary>${permRows(helper)}</details>`;
}
