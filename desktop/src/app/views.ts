// HTML for the desktop window. The browser script fills these strings in.
// No network, no DOM.

import { importErrorView } from "./import-error";
import type { ImportLoginError } from "../v1/import-login-error";
import { attentionCount, formatWait, pendingHealCount, type HumanAsk } from "../v1/human-ask";
import { shotFile, workflowShotName } from "../v1/shots";
import { bucketWords, diffTrajectory, type TimingBucket, type TrajectoryStep } from "../v1/trajectory";
import type { IdentityView, StepView } from "./view-types";

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
}

export interface PromotionView {
  healId?: string;
  workflowId?: string;
  stepId?: string;
  status?: string;
  drift?: string;
  replays?: number;
  reason?: string;
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
}

export interface FailureView {
  stepId?: string;
  index?: number;
  intent?: string;
  reason?: string;
  phase?: string;
  brokenAttr?: string;
  identity?: IdentityView;
  beforeShot?: string;
  snapshot?: { screenshot?: string; screenshotRef?: string };
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
  helper?: { label: string; accessibility?: boolean; screenCapture?: boolean };
  model?: { label: string };
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
  promotions?: PromotionView[];
  activeAsk?: HumanAsk | null;
  pendingImport?: ImportPending | null;
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
    runs: "M4 6h16v3H4V6zm0 5h16v3H4v-3zm0 5h10v3H4v-3z",
    heals: "M12 4l2.2 4.6L19 9.2l-3.5 3.4.8 4.9L12 15.8 7.7 17.5l.8-4.9L5 9.2l4.8-.6L12 4z",
    settings: "M12 8.5A3.5 3.5 0 1012 15.5 3.5 3.5 0 0012 8.5zM4 12l2-.6.4-1.6-1.2-1.6 1.8-1.8 1.6 1.2 1.6-.4L11 5h2l.4 2.2 1.6.4 1.6-1.2 1.8 1.8-1.2 1.6.4 1.6 2 .6v2l-2 .6-.4 1.6 1.2 1.6-1.8 1.8-1.6-1.2-1.6.4L13 21h-2l-.4-2.2-1.6-.4-1.6 1.2-1.8-1.8 1.2-1.6-.4-1.6L4 14v-2z",
  };
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${paths[name] || ""}"/></svg>`;
}

export function rail(state: ShellState): string {
  const heals = pendingHealCount(state.runs || []);
  const waiting = attentionCount({
    ask: state.activeAsk,
    importPhase: state.pendingImport?.phase,
    pendingHeals: heals,
  });
  const rec = state.recording ? "on" : "";
  const helper = state.helper?.label || "helper off";
  const model = state.model?.label || "no model";
  const healBadge = heals > 0 ? `<span class="count" id="heal-count">${heals}</span>` : "";
  return `<div class="brand"><strong>bao</strong>${waiting > 0 ? `<span class="count" id="attention" data-count="${waiting}">${waiting}</span>` : `<span id="attention" data-count="0"></span>`}</div>
    <nav>
      <button data-screen="library">${icon("library")} Library</button>
      <button data-screen="capture">${icon("capture")} Capture</button>
      <button data-screen="runs">${icon("runs")} Runs</button>
      <button data-screen="heals">${icon("heals")} Heals ${healBadge}</button>
      <button data-screen="settings">${icon("settings")} Settings</button>
    </nav>
    <div class="rail-foot">
      <div id="attention-label">${waiting} waiting</div>
      <div class="channel"><span class="dot ${rec}" id="dot"></span><span id="rec-label">${state.recording ? "recording" : "idle"}</span></div>
      <div class="channel" id="helper-status">${esc(helper)}</div>
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
    const when = pending.audit.at ? new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(pending.audit.at)) : "";
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
}

export function runViewer(
  run: RunSummary,
  workflow: { name: string; steps: { id: string; label?: string; action?: string; index?: number }[] },
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
  const statusWord = run.status === "passed" ? "passed" : run.status === "paused" ? "paused" : "refused";
  const badge = modelCalls === 0
    ? `<span class="badge quiet-badge" id="model-calls">0 model calls</span>`
    : `<span class="badge" id="model-calls">${modelCalls} model call${modelCalls === 1 ? "" : "s"}</span>`;
  const segs = steps.map((step) => `<span class="seg ${esc(step.status)}" data-step="${esc(step.id)}" title="${esc(step.label || step.id)}"></span>`).join("");
  const list = steps.map((step) => {
    const mark = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : step.status === "paused" ? "⏸" : "·";
    const dur = duration(step);
    return `<button type="button" class="step ${esc(step.status)} ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}"><span>${mark}</span> ${esc(step.label || step.id)} <em>${esc(dur)}</em></button>`;
  }).join("");
  const before = selected ? frameUrl(run.id, selected, failure, "before") : "";
  const after = selected ? frameUrl(run.id, selected, failure, "after") : "";
  const shot = shotPane(before, after, selected?.action, selected?.label || "");
  const table = identityTable(identity);
  const video = videoBar(run, steps);
  const safeHeadline = failed ? esc(headline) : headline;
  const phase = selected?.phase || (failure && failure.stepId === selected?.id ? failure.phase : undefined) || run.precondition?.phase;
  const stepRepairs = (run.repairs || []).filter((item) => !selected || item.stepId === selected.id);
  const stepReceipts = (run.receipts || []).filter((item) => !selected || item.stepId === selected.id);
  const showPlain = !!failed || phase === "auth";
  const words = showPlain ? plainFailure({
    phase,
    changed: identity?.changed || (failure && failure.stepId === selected?.id ? failure.identity?.changed : undefined),
    reason: selected?.reason || failure?.reason,
    repairs: stepRepairs.length ? stepRepairs : (run.repairs || []),
    authRecovered: run.precondition?.recovered,
  }) : "";
  const film = steps.map((step) => {
    const src = frameUrl(run.id, step, failure, "after");
    return `<button type="button" class="frame ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}" data-at="${step.startedAt ?? ""}" ${src ? `data-shot="${esc(src)}"` : ""}>${placeholder(step.action, step.label || step.id)}</button>`;
  }).join("");
  const recent = context.recent && context.recent.length ? context.recent : [run];
  return `<section id="run-viewer" data-run="${esc(run.id)}" data-status="${esc(run.status)}">
    <header class="run-head">
      <h2>${esc(workflow.name)} · ${esc(run.id)}</h2>
      <p class="${esc(run.status)}" id="run-status"><strong>${esc(statusWord)}</strong> ${failed ? `at step ${stopped}` : ""} ${badge}</p>
    </header>
    <div class="why" id="why-stopped"><p>${safeHeadline}</p>${words ? `<p id="plain-failure">${esc(words)}</p>` : ""}${failed ? `<p class="quiet">Nothing after step ${Math.max(0, stopped - 1)} ran.</p>` : ""}</div>
    <div class="bar" id="step-bar" data-steps="${steps.length}" aria-label="${passed}/${steps.length}">${segs}<span class="bar-count">${passed}/${steps.length}</span></div>
    <div class="filmstrip" id="filmstrip">${film}</div>
    <input id="scrubber" type="range" min="0" max="${Math.max(0, steps.length - 1)}" value="${selectedIndex}" aria-label="Step timeline">
    <div class="split">
      <div class="step-list" id="step-list">${list}</div>
      <div class="step-detail" id="step-detail">
        <div class="row"><strong>${esc(selected?.label || "")}</strong></div>
        ${shot}
        ${stepRepairs.length ? repairLines(stepRepairs) : ""}
        ${stepReceipts.length ? receiptLines(stepReceipts) : ""}
        ${identity && identity.candidates.length ? `<h3 class="section">Identity</h3>${table}` : ""}
      </div>
    </div>
    ${passGrid(recent, workflow.steps)}
    ${trajectoryPane(context.recorded, run.trajectory)}
    ${video}
    <div class="tabs" id="run-tabs">
      <button type="button" data-run-tab="trail">Trail</button>
      <button type="button" data-run-tab="inputs">Inputs</button>
    </div>
    <div id="run-extra"></div>
  </section>`;
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
      row.cells.push(`<td>${esc(attr.live || "—")} ${attr.matched ? "✓" : "≠"}</td>`);
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
  const end = Math.max(...steps.map((step) => step.endedAt || step.startedAt || origin));
  const span = Math.max(1, end - origin);
  const markers = timed.map((step, index) => {
    const at = ((step.startedAt! - origin) / span) * 100;
    const mark = step.status === "failed" ? "✗" : String(index + 1);
    return `<button type="button" class="marker ${esc(step.status)}" data-marker="${esc(step.id)}" data-at="${step.startedAt}" style="left:${at}%">${mark}</button>`;
  }).join("");
  const src = run.video ? `/api/runs/${encodeURIComponent(run.id)}/video` : "";
  if (!src) return `<div id="video-bar" hidden data-origin="${origin}">${markers}</div>`;
  return `<div id="video-bar" data-origin="${origin}">
    <video id="run-video" src="${esc(src)}" controls preload="metadata"></video>
    <div class="timeline">${markers}</div>
    <div class="row"><button type="button" data-speed="1">1×</button><button type="button" data-speed="2">2×</button><button type="button" data-speed="4">4×</button></div>
  </div>`;
}

export function inputsPane(inputs: Record<string, string> | undefined): string {
  const rows = Object.entries(inputs || {});
  if (rows.length === 0) return `<p class="quiet">This run stored no inputs.</p>`;
  return `<table class="identity">${rows.map(([key, value]) => `<tr><th>${esc(key)}</th><td>${esc(value)}</td></tr>`).join("")}</table>`;
}

export function trailPane(events: { id?: string; ts?: number; op?: string; kind?: string }[]): string {
  if (events.length === 0) return `<p class="quiet">No trail events.</p>`;
  const lines = events.map((event) => `${event.ts ?? ""} ${event.kind || ""} ${event.op || ""} ${event.id || ""}`).join("\n");
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
        when: heal.ts ? new Date(heal.ts).toISOString() : "",
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
  const decisionLine = decisions.map((item) => `${item.decision} at ${item.ts}`).join(", ");
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
    <p class="quiet">Keep writes the patch into the saved workflow. Revert puts the failed step back. Both are appended. ${esc(decisionLine)}</p>
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
      <div class="thumb" data-shot="${esc(poster)}" data-shot-fallback="/api/workflows/${encodeURIComponent(workflow.id)}/poster">${placeholder(workflow.firstStep?.action, thumbLabel)}</div>
      <div class="wf-body">
        <h3><button type="button" class="link" data-open-workflow="${esc(workflow.id)}">${esc(workflow.name)}</button></h3>
        <p class="meta"><span class="status ${esc(kind)}">${esc(label)}</span> ${expects}</p>
        ${sparkline(history)}
        <div class="chips">${inputs}${waits}</div>
        <div class="row"><button type="button" data-screen="replay" data-workflow="${esc(workflow.id)}">Run</button></div>
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

export function notices(items: { title?: string; body?: string }[]): string {
  return items.map((item) => `<div class="notice"><strong>${esc(item.title)}</strong><div>${esc(item.body)}</div></div>`).join("");
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
  if (promotion?.status === "provisional" || run.promotion?.status === "provisional") return "provisional";
  if (run.status === "paused") return "paused";
  if (run.status === "failed") return "failed";
  if ((run.heals || []).length > 0) return "healed";
  return "passed";
}

export function statusLabel(kind: string): string {
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

export function passGrid(runs: RunSummary[], steps: { id: string; label?: string }[]): string {
  const cols = runs.slice(0, 8);
  if (!cols.length || !steps.length) return "";
  const head = cols.map((run) => {
    const kind = runKind(run);
    return `<th><i class="swatch ${esc(kind)}" title="${esc(statusLabel(kind))}"></i></th>`;
  }).join("");
  const body = steps.map((step) => {
    const cells = cols.map((run) => {
      const found = (run.steps || []).find((item) => item.id === step.id);
      const healed = (run.heals || []).some((heal) => heal.failedStep?.id === step.id) && found?.status === "passed";
      const kind = !found ? "empty" : found.status === "paused" ? "paused" : found.status === "failed" ? "failed" : healed ? "healed" : found.status === "passed" ? "passed" : "empty";
      const label = kind === "paused" ? "needs you" : kind === "empty" ? "not run" : kind;
      return `<td><span class="cell ${kind}" title="${esc(label)}"></span></td>`;
    }).join("");
    return `<tr><th>${esc(step.label || step.id)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="grid-wrap"><h3 class="section">Recent runs</h3>${statusLegend()}<table id="pass-grid" aria-label="Recent runs"><thead><tr><th>Step</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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
  return `<p id="promotion" data-status="provisional">Provisional. ${drift} ${promotion.replays ?? 0} of 2 later replays have passed.</p>`;
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

export function inputChips(step: StepCard): string {
  const chips: string[] = [];
  const template = step.value && step.value.includes("{{") ? step.value : step.input ? `{{${step.input}}}` : "";
  if (template) chips.push(`<span class="chip">${esc(template)}</span>`);
  if (step.sensitive) chips.push(`<span class="chip secret">secret</span>`);
  if (step.action === "upload" || step.action === "drop") chips.push(`<span class="chip">file</span>`);
  return chips.join("");
}

function expectBadge(step: StepCard): string {
  if (step.action === "verify") return `<span class="badge expect">verify</span>`;
  if (step.expect) return `<span class="badge expect">expect</span>`;
  if (step.readBack) return `<span class="badge expect">read back</span>`;
  return "";
}

export function workflowDetail(
  doc: { id: string; name: string; steps: StepCard[]; inputs?: { name: string; type?: string }[] },
  meta: { lastRunId?: string; lastLabel?: string } = {},
): string {
  const cards = doc.steps.map((step) => {
    const human = step.human || step.action === "login" || step.action === "confirm";
    const runShot = meta.lastRunId ? `/api/runs/${encodeURIComponent(meta.lastRunId)}/shots/${encodeURIComponent(shotFile(step.id, "after"))}` : "";
    const captured = `/api/workflows/${encodeURIComponent(doc.id)}/shots/${encodeURIComponent(workflowShotName(step.id))}`;
    const shot = runShot || captured;
    return `<article class="step-card ${human ? "human" : ""}" data-step-card="${esc(step.id)}">
      <div class="thumb" data-shot="${esc(shot)}" ${runShot ? `data-shot-fallback="${esc(captured)}"` : ""}>${placeholder(step.action, step.label || step.action || step.id)}</div>
      <div class="step-copy">
        <div class="row"><strong>${esc(step.label || step.action || step.id)}</strong> ${expectBadge(step)} ${human ? `<span class="badge you">you</span>` : ""}</div>
        <p class="meta">${esc(step.intent || (human ? "This step waits for you." : ""))}</p>
        <div class="chips">${identityChip(step.identity)}${inputChips(step)}</div>
      </div>
    </article>`;
  }).join("");
  const inputs = (doc.inputs || []).map((input) => {
    if (input.type === "secret") return `<span class="chip secret">secret</span>`;
    if (input.type === "file") return `<span class="chip">file</span>`;
    return `<span class="chip">{{${esc(input.name)}}}</span>`;
  }).join("");
  return `<section id="workflow-detail" data-workflow="${esc(doc.id)}">
    <p class="crumb"><button type="button" class="link" data-screen="library">Library</button> <span aria-hidden="true">/</span> ${esc(doc.name)}</p>
    <header class="wf-head">
      <div>
        <h2>${esc(doc.name)}</h2>
        <p class="meta">${esc(meta.lastLabel || "Not run yet")}</p>
        <div class="chips">${inputs}</div>
      </div>
      <button type="button" class="primary" data-screen="replay" data-workflow="${esc(doc.id)}">Run</button>
    </header>
    <h3 class="section">Steps</h3>
    ${cards || `<div class="empty"><strong>No steps yet</strong>Record a capture to fill this workflow.</div>`}
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
    return `<tr><td><button type="button" class="link" data-open-run="${esc(run.id)}">${esc(names.get(run.workflowId) || run.workflowId)}</button></td><td><span class="status ${esc(kind)}">${esc(statusLabel(kind))}</span> ${bolt}</td><td>${esc(run.id)}</td></tr>`;
  }).join("");
  return `<section id="runs"><h2>Runs</h2><table class="grid"><thead><tr><th>Workflow</th><th>Status</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function commandItems(workflows: { id: string; name: string }[]): CommandItem[] {
  const screens: CommandItem[] = [
    { id: "library", label: "Library", kind: "screen", screen: "library", hint: "Go" },
    { id: "capture", label: "Capture", kind: "screen", screen: "capture", hint: "Go" },
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

export function onboarding(helper?: { label?: string; accessibility?: boolean; screenCapture?: boolean }): string {
  const access = !!helper?.accessibility;
  const screen = !!helper?.screenCapture;
  return `<section id="onboarding">
    <h2>Two permissions on the Mac</h2>
    <p>Accessibility lets bao see the control you used. Screen Recording lets bao keep a picture of each step. The marks follow the helper. Here the helper reports “${esc(helper?.label || "helper off")}”.</p>
    <ul class="perms">
      <li class="perm" data-perm="accessibility" data-ok="${access ? "true" : "false"}"><span class="mark"></span><span><strong>Accessibility</strong> ${access ? "allowed" : "not granted yet"}</span></li>
      <li class="perm" data-perm="screen" data-ok="${screen ? "true" : "false"}"><span class="mark"></span><span><strong>Screen Recording</strong> ${screen ? "allowed" : "not granted yet"}</span></li>
    </ul>
    <button type="button" id="onboard-done">Continue</button>
  </section>`;
}
