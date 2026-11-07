// HTML for the desktop window. The browser script fills these strings in.
// No network, no DOM.

import { importErrorView } from "./import-error";
import type { inspectRunView } from "../mcp/run-view";
import { shellPlaces, shellScreen, shellScreens, type Screen } from "./shell-navigation";
import type { ImportLoginError } from "../v1/import-login-error";
import { ownerWaitTimeout } from "../cdp-live/owner-wait";
import { attentionCount, formatWait, pendingHealCount, type HumanAsk } from "../v1/human-ask";
import { formatClock, formatTime, formatWhen } from "../v1/time";
import { shotFile, workflowShotName } from "../v1/shots";
import { bucketWords, diffTrajectory, type TimingBucket, type TrajectoryStep } from "../v1/trajectory";
import { filmstripSpans, idleSkippedMs, idleSkips, skipLabel } from "../v1/filmstrip";
import { stepsNeedingReview, type StepReview } from "../v1/triage";
import { DEFAULT_PROMOTE_AFTER } from "../v1/promote";
import { outputsHtml, type OutputValue } from "../v1/data-steps";
import { datePreview } from "../v1/dates";
import { tokenFields, type TokenInput } from "../v1/input-token";
import { hasStrippedSecret } from "../../../shared/saved-secrets";
import { hostAccessLabel, hostAccessMode } from "../../../extension/src/host-grant";
import { visibleCopy } from "../v1/visible-copy";
import { ownerStopMessage, ownerStopText } from "../v1/stop-copy";
import type { ConsoleLine, IdentityView, NetworkLine, SnapshotNode, StepView } from "./view-types";
import type { Identity } from "../v1/schema";

/** Chromium app mode uses the document title as the window title. */
export function productWindowTitle(): string {
  return "Bao";
}

/** Default capture target. A path, so the product window does not show the listen address. */
export function fixtureStartValue(): string {
  return "/fixture";
}

export interface WorkflowSummary {
  id: string;
  name: string;
  summary?: string;
  intent?: string;
  steps: number;
  waits?: number;
  expects?: number;
  heal?: string;
  replayed?: boolean;
  firstStep?: { action?: string; label?: string };
  inputs?: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean }[];
  startUrl?: string;
  /** cdp-live is historical and cannot replay. Absent is Playwright. */
  driver?: "playwright" | "extension" | "cdp-live" | string;
}

/** Keep retired workflows readable without offering a different replay driver. */
export function runDriverField(driver: string | undefined): string {
  if (driver === "cdp-live") {
    return `<label>Driver <select id="wf-driver" data-testid="run-driver" disabled>
      <option value="cdp-live" selected>Retired live driver</option>
    </select></label><p role="status">This workflow used the retired live driver. Replay on the pass-through is not yet available.</p>`;
  }
  const extension = driver === "extension";
  return `<label>Driver <select id="wf-driver" data-testid="run-driver">
      <option value="playwright" ${extension ? "" : "selected"}>Playwright — Bao's Chrome</option>
      <option value="extension" ${extension ? "selected" : ""}>Extension — this Chrome profile</option>
    </select></label>`;
}

/** The run form's heal line. A live workflow replays with no heal and no approval, so its line offers no choice. */
export function runHealField(driver: string | undefined, mode: string, globalHeal: string): string {
  if (driver === "cdp-live") {
    return `<label>Healing for this workflow <select id="wf-heal" data-testid="run-heal" disabled>
      <option value="" selected>Unavailable - retired live driver</option>
    </select></label>`;
  }
  return `<label>Healing for this workflow <select id="wf-heal" data-testid="run-heal">
      <option value="" ${mode === "" ? "selected" : ""}>Use the global setting (${globalHeal === "never" ? "Stop" : globalHeal === "approve" ? "Ask me" : "Heal it"})</option>
      <option value="auto" ${mode === "auto" ? "selected" : ""}>Heal it</option>
      <option value="approve" ${mode === "approve" ? "selected" : ""}>Ask me</option>
    </select></label>`;
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
  kind?: "replay" | "capture";
  pageEngine?: "old" | "agent-browser";
  allowCommit?: boolean;
  workflowId: string;
  task?: string;
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
  videoTruncated?: boolean;
  traceUnavailable?: string;
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
  outputs?: OutputValue[];
  pageClasses?: {
    stepId: string;
    class: string;
    reason: string;
    vendor?: string;
    evidence?: { source: string; detail: string }[];
    line?: string;
  }[];
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

type HealTarget = Partial<Pick<Identity, "name" | "text" | "testId" | "id" | "role" | "path">>;

export interface HealView {
  id: string;
  workflowId?: string;
  ts?: number;
  mode?: string;
  intent?: string;
  prompt?: string;
  rawResponse?: string;
  model?: { name?: string; version?: string; provider?: string };
  proposedPatch?: { identity?: HealTarget; label?: string };
  failedStep?: { id?: string; index?: number; label?: string; action?: string; identity?: HealTarget };
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

export type ActiveRun = {
  id: string;
  workflowId: string;
  startedAt: number;
} & ({ phase: "running"; ask: HumanAsk | null } | { phase: "waiting"; ask: HumanAsk });

export interface ShellState {
  recording?: boolean;
  replaying?: boolean;
  liveSessionOpen?: boolean;
  capturePaused?: boolean;
  recordingSince?: number;
  capture?: {
    recording: boolean;
    paused: boolean;
    steps: string[];
    url?: string;
    stream?: { label: string; op?: string; field?: string; sensitive?: boolean; ts?: number }[];
  };
  trails?: string[];
  liveTrail?: { id?: string; ts?: number; op?: string; kind?: string }[];
  helper?: {
    label: string;
    platform?: string;
    accessibility?: boolean;
    screenCapture?: boolean;
    capabilities?: { id: string; status: string; optional?: boolean }[];
  };
  model?: { label: string };
  workflows?: WorkflowSummary[];
  damagedWorkflows?: import("../v1/store").DamagedWorkflow[];
  runs?: RunSummary[];
  promotions?: PromotionView[];
  activeRun?: ActiveRun | null;
  activeAsk?: HumanAsk | null;
  pendingImport?: ImportPending | null;
  teach?: TeachView;
  guide?: GuideView | null;
  /** HTML for the capture column picker. Empty when nothing is picked. */
  extractPicker?: string;
  saveSheet?: SaveSheet | null;
  remote?: RemoteView;
}

export interface SaveSheet {
  id: string;
  name: string;
  summary?: string;
  intent?: string;
  poster?: boolean;
}

export interface RemoteView {
  phase: "idle" | "running" | "waiting";
  workflowId?: string;
  workflowName?: string;
  jobId?: string;
  resumeToken?: string;
  stepId?: string;
  stepLabel?: string;
  stepNumber?: number;
  stepCount?: number;
  canDetectCompletion?: boolean;
}

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  kind: "screen" | "workflow" | "theme";
  screen?: string;
  workflowId?: string;
}

export function htmlEsc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

/** Visible copy. Loopback addresses read as Fixture, a path, or "the fixture". */
export function esc(value: unknown): string {
  return htmlEsc(visibleCopy(String(value ?? "")));
}

/** A URL for a page PNG or JPEG. Reject paths and other data formats. */
export function imageRef(runId: string, value: string | undefined): string {
  if (!value) return "";
  if (value.startsWith("iVBORw0KGgo") && /^[A-Za-z0-9+/=]+$/.test(value)) return `data:image/png;base64,${value}`;
  if (value.startsWith("/9j/") && /^[A-Za-z0-9+/=]+$/.test(value)) return `data:image/jpeg;base64,${value}`;
  if (/^[\w.-]+\.(png|jpe?g)$/.test(value)) return `/api/runs/${encodeURIComponent(runId)}/shots/${encodeURIComponent(value)}`;
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

export function icon(name: string): string {
  if (name === "warning") return `<svg class="ico" viewBox="0 0 14 14" aria-hidden="true"><path d="M6.13 1.5a1 1 0 0 1 1.74 0l5.6 9.95a1 1 0 0 1-.87 1.5H1.4a1 1 0 0 1-.87-1.5Z" fill="currentColor"/><path d="M7 5v3.2" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10.4" r=".9" fill="var(--bg)"/></svg>`;
  if (name === "back" || name === "chevron") return `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${name === "back" ? "M10 3 5 8l5 5" : "m6 3.5 4.5 4.5L6 12.5"}"/></svg>`;
  if (name === "more") return `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/></svg>`;
  if (name === "search") return `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.25 3.25"/></svg>`;
  const strokes: Record<string, string> = {
    play: '<path d="m5 2.5 9 5.5-9 5.5Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
    globe: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c1.6 1.6 2.4 3.5 2.4 5.75S9.6 12.15 8 13.75C6.4 12.15 5.6 10.25 5.6 8S6.4 3.85 8 2.25Z"/>',
    click: '<path d="M4.5 2.5v9.25l2.4-2.3 1.75 4 1.7-.75-1.75-3.95 3.4-.3Z"/>',
    type: '<rect x="1.75" y="4" width="12.5" height="8" rx="1.75"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.5h5"/>',
    person: '<circle cx="8" cy="5.25" r="2.5"/><path d="M3 13.5c.55-2.5 2.5-3.9 5-3.9s4.45 1.4 5 3.9"/>',
    table: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M1.75 6.25h12.5M1.75 9.75h12.5M6.25 6.25v7"/>',
    lock: '<rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5"/><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7"/>',
    library: '<rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1.25"/><rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1.25"/><path d="M5 4.5h3.5M5 11.5h5"/>',
    runs: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
    record: '<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="3.6" fill="currentColor" stroke="none"/>',
    sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/>',
    settings: '<path d="M6.60 2.89L6.90 1.09L9.10 1.09L9.40 2.89L10.63 3.40L12.11 2.34L13.66 3.89L12.60 5.37L13.11 6.60L14.91 6.90L14.91 9.10L13.11 9.40L12.60 10.63L13.66 12.11L12.11 13.66L10.63 12.60L9.40 13.11L9.10 14.91L6.90 14.91L6.60 13.11L5.37 12.60L3.89 13.66L2.34 12.11L3.40 10.63L2.89 9.40L1.09 9.10L1.09 6.90L2.89 6.60L3.40 5.37L2.34 3.89L3.89 2.34L5.37 3.40Z"/><circle cx="8" cy="8" r="2"/>',
  };
  return `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${strokes[name] || ""}</svg>`;
}

function baoMark(id = "bao-mark"): string {
  return `<svg class="bao-mark" viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="${id}-bg" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFB86B"/><stop offset="1" stop-color="#E8813A"/></linearGradient><radialGradient id="${id}-dough" cx="42%" cy="32%" r="78%"><stop stop-color="#FFFDF8"/><stop offset=".66" stop-color="#FFF1DE"/><stop offset="1" stop-color="#F8DEBE"/></radialGradient></defs><rect x="4" y="4" width="92" height="92" rx="24" fill="url(#${id}-bg)"/><g stroke="#FFE6C4" stroke-width="2" stroke-linecap="round" fill="none" opacity=".6"><path d="M41 27C39.2 24.3 42.8 23 41 20.3M50 26C48.2 23.3 51.8 22 50 19.3M59 27C57.2 24.3 60.8 23 59 20.3"/></g><path d="M50 34C70 34 79 48 79 62C79 78 65 84 50 84C35 84 21 78 21 62C21 48 30 34 50 34Z" fill="url(#${id}-dough)" stroke="#EBD3B2" stroke-width="1.4"/><ellipse cx="50" cy="36.5" rx="6.5" ry="3.9" fill="#FCEED8" stroke="#EBD3B2"/><path d="M36 60Q41 52.5 46 60M54 60Q59 52.5 64 60" stroke="#3A302A" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M44 72Q50 77 56 72" stroke="#3A302A" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`;
}

export function shellAttentionCount(state: ShellState): number {
  return attentionCount({
    pendingHeals: runAttention(state.runs || [], state.activeAsk, state.activeRun).length,
    importPhase: state.pendingImport?.phase,
    reviews: reviewItems(state.runs).length,
  });
}

function needsYouText(count: number, hasRuns: boolean): string {
  return count ? `${count} ${count === 1 ? "needs" : "need"} you` : hasRuns ? "Nothing needs you" : "No runs yet";
}

export function rail(state: ShellState, screen: Screen = "runs"): string {
  const attention = runAttention(state.runs || [], state.activeAsk, state.activeRun);
  const waits = attention.filter((item) => item.kind === "paused");
  const waiting = new Set(waits.map((item) => item.run.id)).size;
  const count = shellAttentionCount(state);
  const imports = attentionCount({ pendingHeals: 0, importPhase: state.pendingImport?.phase });
  const reviews = reviewItems(state.runs).length;
  const footer = [
    waiting ? `${waiting} run${waiting === 1 ? " is" : "s are"} waiting for you` : "",
    imports ? "Sign-in needs you" : "",
    reviews ? `${reviews} step${reviews === 1 ? " needs" : "s need"} review` : "",
  ].filter(Boolean).join(" · ") || (state.recording ? "Recording" : state.replaying ? "Running" : "Nothing running");
  const action = waits[0] ? waits[0].live ? ' data-screen="live"' : ` data-open-run="${esc(waits[0].run.id)}"` : imports ? ' data-screen="logins"' : reviews ? ' data-screen="library"' : ' data-screen="live"';
  const damaged = state.damagedWorkflows?.length || 0;
  const current = shellScreens[shellScreen(screen)].place;
  const workflowWarning = damaged ? `<span class="workflow-warning" aria-hidden="true">${icon("warning")}</span><span id="workflow-warning-description" hidden>${damaged === 1 ? "One workflow can’t open." : `${damaged} workflows can’t open.`} Open Workflows for recovery options.</span>` : "";
  return `<button id="sidebar-close" type="button" aria-label="Close sidebar">Close</button>
    <nav aria-label="Places">${shellPlaces.map((place) => `<button type="button" data-place="${place.id}" data-screen="${place.screen}"${current === place.id ? ` class="on" aria-current="page"` : ""}${place.id === "workflows" && damaged ? ` aria-describedby="workflow-warning-description"` : ""}>${icon(place.icon)} <span>${place.label}</span>${place.id === "runs" ? `<span class="place-count" id="attention" data-count="${count}" aria-label="${needsYouText(count, Boolean(state.runs?.length))}">${count || ""}</span>` : place.id === "workflows" && damaged ? workflowWarning : ""}</button>`).join("")}</nav>
    <button type="button" class="rail-foot"${action}>${baoMark()}<span><strong>Bao</strong><span id="attention-label">${esc(footer)}</span></span></button>`;
}

export function shellList(screen: Screen, state: ShellState, selectedRun = "", available = true, selectedHeal?: { runId: string; healId: string } | null): string {
  if (screen === "library" || screen === "workflow") return "";
  const current = shellScreen(screen);
  const place = shellPlaces.find((item) => item.id === shellScreens[current].place)!;
  return `<header class="pane-bar">
      <button id="sidebar-toggle" type="button" aria-label="Show sidebar" aria-haspopup="dialog" aria-controls="sidebar-dialog">${icon("sidebar")}</button>
      <div class="pane-title"><h1>${place.label}</h1>${place.id === "runs" ? `<p>${available ? needsYouText(shellAttentionCount(state), Boolean(state.runs?.length)) : "Run history unavailable"}</p>` : ""}</div>
      ${place.id === "runs" ? `<button type="button" class="runs-record" data-screen="capture">${icon("record")}Record</button>` : ""}
    </header>
    ${place.id === "runs" ? available ? runsList(state.runs || [], state.workflows || [], selectedRun, Date.now(), state.activeAsk, state.pendingImport?.phase, { selectedHeal, liveSelected: screen === "live", promotions: state.promotions, activeRun: state.activeRun }) : `<p class="run-list-note">Run history is unavailable. Use Retry to reconnect.</p>` : `<nav aria-label="${place.label} screens" class="screen-list">${Object.entries(shellScreens).filter(([, item]) => item.place === place.id).map(([id, item]) => `<button type="button" data-screen="${id}"${id === current ? ` class="on" aria-current="page"` : ""}>
        <span class="screen-name">${id === current ? `<span aria-hidden="true">› </span>` : ""}${item.label}</span>
        <span class="screen-description">${item.description}</span>
      </button>`).join("")}</nav>`}`;
}

/** Shows the remote run without adding an approval step. */
export function remoteBanner(remote: RemoteView | undefined): string {
  if (!remote || remote.phase === "idle") return "";
  const name = remote.workflowName || remote.workflowId || "a workflow";
  if (remote.phase === "running") {
    return `<section id="remote-agent" data-testid="remote-running" data-phase="running">
      <p class="kicker">Remote agent running</p>
      <p class="instruction">${esc(name)} is running in a Bao window.</p>
      <div class="row"><button id="remote-kill" data-testid="remote-kill" type="button">Kill</button></div>
    </section>`;
  }
  return `<section id="remote-agent" data-testid="remote-waiting" data-phase="waiting">
    <p class="kicker">Workflow waiting</p>
    <p class="instruction">${esc(name)} is waiting for you to complete ${esc(remote.stepLabel || "the site interaction")}${remote.stepNumber && remote.stepCount ? ` (step ${remote.stepNumber} of ${remote.stepCount})` : ""}. Complete it in the Bao window. ${remote.canDetectCompletion ? "Bao continues when it detects completion. If it stays here, choose Continue after you finish." : "Choose Continue after you finish."}</p>
    <div class="row">${remote.resumeToken && remote.stepId ? `<button id="remote-continue" data-resume="${esc(remote.resumeToken)}" data-step="${esc(remote.stepId)}" type="button">Continue</button>` : ""}<button id="remote-kill" data-testid="remote-kill" type="button">Kill</button></div>
  </section>`;
}

export function actBar(state: ShellState, now = Date.now()): string {
  const ask = state.activeAsk;
  if (ask?.kind === "confirm" || ask?.kind === "login" || ask?.kind === "wall") {
    const effect = ask.kind === "confirm"
      ? "run stops, nothing applied"
      : ask.kind === "wall"
        ? "the run stays on this step"
        : "run stops, still signed out";
    const kicker = `You need to act · ${ask.workflowName} · step ${ask.stepIndex} of ${ask.stepCount}`;
    const extra = ask.kind === "login"
      ? `<button id="act-continue" type="button">I'm signed in, continue</button>`
      : ask.kind === "wall"
        ? `<button id="act-continue" type="button">Continue</button>`
        : "";
    return `<section id="act-bar" data-ask="${ask.kind}" data-step="${esc(ask.stepId)}">
      <p class="kicker">${esc(kicker)}</p>
      <p class="instruction">${esc(ownerStopText(ask.instruction))}</p>
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
  instruction?: string;
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
    bits.push(`${head} stopped. ${ownerStopMessage(input.reason, input.instruction)}`);
  } else {
    bits.push(head);
  }
  if (identity?.changed) bits.push(`What changed since recording: ${identity.changed}.`);
  else if (input.brokenAttr || identity?.brokenAttr) {
    bits.push(`Attribute that changed: ${input.brokenAttr || identity?.brokenAttr}.`);
  }
  return bits.join(" ");
}

function ownerCheckLimit(step: StepView | undefined): string | undefined {
  if (step?.native?.command !== "wait_for_owner") return undefined;
  let ms: number;
  try { ms = ownerWaitTimeout(step.native.args[0] === undefined ? undefined : Number(step.native.args[0])); }
  catch { return undefined; }
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
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
    recordedOnly?: boolean;
    inputs?: { name: string; type?: string; choices?: string[] }[];
    steps: { id: string; label?: string; action?: string; index?: number; when?: { input?: string; value?: string; present?: string } }[];
  },
  selectedId?: string,
  context: ViewerContext = {},
): string {
  const steps = (run.steps || []).map((step) => {
    const ownerWait = run.pageEngine === "agent-browser" && step.native?.command === "wait_for_owner";
    const limit = ownerWait ? ownerCheckLimit(step) : undefined;
    return {
      ...step,
      label: ownerWait
        ? `Wait for you to sign in or clear a check${limit ? ` (up to ${limit} per check)` : ""}`
        : stepLabel(step, workflow.steps),
      action: step.action || workflow.steps.find((item) => item.id === step.id)?.action,
    };
  });
  const failed = steps.find((step) => step.status === "failed" || step.status === "paused");
  const selected = steps.find((step) => step.id === selectedId) || failed || steps[steps.length - 1];
  const selectedIndex = Math.max(0, selected ? steps.indexOf(selected) : 0);
  const modelCalls = countedModelCalls(run);
  const passed = steps.filter((step) => step.status === "passed").length;
  const stopped = failed ? steps.indexOf(failed) + 1 : steps.length;
  const failure = run.failure;
  const identity = selected?.identity || (failure && failure.stepId === selected?.id ? failure.identity : undefined);
  const wall = (run.pageClasses || []).find((item) =>
    (item.class === "bot_wall" || item.class === "login_wall") && (!failed || item.stepId === failed.id),
  );
  const wallLine = failed && wall
    ? wallStopLine((failure?.index ?? steps.indexOf(failed)) + 1, failed.label || failure?.intent || failed.id, wall)
    : "";
  const agentBrowser = run.pageEngine === "agent-browser";
  const ownerCheck = agentBrowser && steps.at(-1)?.native?.command === "wait_for_owner" ? steps.at(-1) : undefined;
  const envelopeWait = failed ? ownerCheck || failed : undefined;
  const nativeRecording = agentBrowser && workflow.recordedOnly;
  const headline = failed && nativeRecording
    ? `Step ${stopped} ${failed.label || failed.id} failed${failed.reason ? `: ${failed.reason}` : "."}`
    : wallLine
    ? wallLine
    : failed
      ? stopHeadline({
        stepNumber: (failure?.index ?? steps.indexOf(failed)) + 1,
        label: failed.label || failure?.intent || failed.id,
        action: failed.action,
        identity: failed.identity || failure?.identity,
        reason: failed.reason || failure?.reason,
        instruction: run.envelope?.ask,
        brokenAttr: failure?.brokenAttr,
      })
      : `${esc(workflow.name)} ${run.kind === "capture" ? "recorded" : "passed"}`;
  const statusWord = run.kind === "capture" ? statusLabel(runKind(run)) : run.status === "needs_human" ? "needs you" : run.status === "passed" ? "passed" : run.status === "paused" ? "paused" : run.status === "timed-out" ? "stopped, timed out" : "refused";
  const badge = modelCalls === undefined ? "" : modelCalls === 0
    ? `<span class="badge quiet-badge" id="model-calls">0 model calls</span>`
    : `<span class="badge" id="model-calls">${modelCalls} model call${modelCalls === 1 ? "" : "s"}</span>`;
  const segs = steps.map((step) => `<span class="seg ${esc(step.status)}" data-step="${esc(step.id)}" title="${esc(step.label || step.id)}"></span>`).join("");
  const list = steps.map((step) => {
    const mark = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : step.status === "paused" ? "⏸" : "·";
    const dur = duration(step);
    const review = (context.reviewStepIds || []).includes(step.id) || step.triage === "review";
    const reviewMark = review ? `<em class="review">needs review</em>` : "";
    const recoveredMark = step.reason?.startsWith("recovered:") ? `<em class="recovered">${esc(ownerStopText(step.reason))}</em>` : "";
    const askMark = step.reason === "always ask" ? `<em class="ask">always ask</em>` : "";
    const spec = workflow.steps.find((item) => item.id === step.id);
    const routeMark = step.reason === "other branch"
      ? `<em class="route">other branch</em>`
      : spec?.when?.value
        ? `<em class="route">${esc(spec.when.value)}</em>`
        : "";
    return `<button type="button" class="step ${esc(step.status)} ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}" data-at="${step.startedAt ?? ""}"><span>${mark}</span><span class="step-label">${esc(step.label || step.id)}</span><em class="step-duration">${esc(dur)}</em>${routeMark}${recoveredMark}${askMark}${reviewMark}</button>`;
  }).join("");
  const ran = routeRan(steps, workflow);
  const routeLine = ran ? `<p id="route-ran" data-route="${esc(ran)}">Route: ${esc(ran)}</p>` : "";
  const before = selected ? frameUrl(run.id, selected, failure, "before") : "";
  const after = selected ? frameUrl(run.id, selected, failure, "after") : "";
  const shot = shotPane(before, after, selected?.action, selected?.label || "", selected?.beforeShotError, selected?.afterShotError);
  const table = identityTable(identity);
  const panel = failurePanel(selected, failure, identity);
  const video = videoBar(run, steps);
  const safeHeadline = agentBrowser && run.status === "recording" && !failed
    ? `${esc(workflow.name)} recording`
    : failed ? esc(headline) : headline;
  const phase = selected?.phase || (failure && failure.stepId === selected?.id ? failure.phase : undefined) || run.precondition?.phase;
  const recoveredRow = selected?.reason?.startsWith("recovered:")
    ? `<p id="recovered-row">${esc(ownerStopText(selected.reason))}</p>`
    : "";
  const stepRepairs = (run.repairs || []).filter((item) => !selected || item.stepId === selected.id);
  const stepReceipts = (run.receipts || []).filter((item) => !selected || item.stepId === selected.id);
  const snapDom = selected?.snapshot?.dom || (failure && failure.stepId === selected?.id ? failure.snapshot?.dom : undefined);
  const snapAx = selected?.snapshot?.ax || (failure && failure.stepId === selected?.id ? failure.snapshot?.ax : undefined);
  const triageNote = selected?.triage && selected.triage !== "change"
    ? `<p id="triage">Sorted as ${esc(triageWord(selected.triage))}. Bao did not call a model.</p>`
    : "";
  const showPlain = !nativeRecording && !wallLine && (!!failed || phase === "auth");
  const words = showPlain ? plainFailure({
    phase,
    changed: identity?.changed || (failure && failure.stepId === selected?.id ? failure.identity?.changed : undefined),
    reason: selected?.reason || failure?.reason,
    instruction: selected?.id === failed?.id ? run.envelope?.ask : undefined,
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
    return `${marker}<button type="button" class="frame${shotClass} ${selected && step.id === selected.id ? "on" : ""}" data-select-step="${esc(step.id)}" data-at="${step.startedAt ?? ""}" data-skipped="${span.skippedMs}" aria-label="${esc(step.label || step.id)}" title="${esc(step.label || step.id)}" style="flex:${span.flex} 1 72px">${face.body}</button>`;
  }).join("");
  const idleNote = skipped > 0 ? `<p class="quiet" id="idle-note" data-idle-skipped="${skipped}">Idle longer than 3s is collapsed.</p>` : "";
  const recent = context.recent && context.recent.length ? context.recent : [run];
  return `<section id="run-viewer" data-run="${esc(run.id)}" data-status="${esc(run.status)}">
    <header class="run-head">
      <h2>${esc(workflow.name)} · ${esc(run.id)}</h2>
      <p class="${esc(run.status)}" id="run-status"><strong>${esc(statusWord)}</strong> ${failed ? `at step ${stopped}` : ""} ${badge}</p>
      ${routeLine}
      ${run.allowCommit ? `<p class="quiet" id="commit-opt-in">Experian commit opt-in was on for this recording. It does not authorize a replay.</p>` : ""}
      ${run.traceUnavailable ? `<p class="quiet" id="trace-unavailable">${esc(ownerStopText(run.traceUnavailable))}</p>` : ""}
    </header>
    ${outputsHtml(run.id, run.outputs)}
    ${video}
    ${pageClassPane(run)}
    ${envelopePane(run.envelope, envelopeWait ? { stepNumber: steps.indexOf(envelopeWait) + 1, label: envelopeWait.label || envelopeWait.id } : undefined, ownerCheckLimit(ownerCheck))}
    ${handoffPane(run.trail)}
    ${workflow.recordedOnly ? "" : `<div class="row" id="run-actions">
      <button id="rerun-run" type="button">Re-run with this run's inputs</button>
      <button id="debug-step" type="button" data-step="${esc(selected?.id || "")}">Debug from this step</button>
    </div>`}
    ${storedInputsLine(run.inputs)}
    <div class="why" id="why-stopped"><p>${safeHeadline}</p>${words ? `<p id="plain-failure">${esc(words)}</p>` : ""}${triageNote}${failed && !workflow.recordedOnly ? `<p class="quiet">${stopped <= 1 ? "No steps ran." : `Nothing after step ${stopped - 1} ran.`}</p>` : ""}${failed ? `<button type="button" class="link" id="open-failed-step" data-select-step="${esc(failed.id)}">Open this step</button>` : ""}</div>
    <div class="bar" id="step-bar" data-steps="${steps.length}" aria-label="${passed}/${steps.length}">${segs}<span class="bar-count">${passed}/${steps.length}</span></div>
    ${idleNote}
    <div class="filmstrip" id="filmstrip" data-idle-skipped="${skipped}">${film}</div>
    <input id="scrubber" type="range" min="0" max="${Math.max(0, steps.length - 1)}" value="${selectedIndex}" aria-label="Step timeline">
    <div class="split${(agentBrowser ? !!panel : selected?.status === "failed") ? " with-failure" : ""}">
      <div class="step-list" id="step-list">${list}</div>
      <div class="step-detail" id="step-detail">
        <div class="row"><strong>${esc(selected?.label || "")}</strong></div>
        ${recoveredRow}
        ${shot}
        ${stepRepairs.length ? repairLines(stepRepairs) : ""}
        ${stepReceipts.length ? receiptLines(stepReceipts) : ""}
        ${nativeRecording ? "" : `<h3 class="section">Identity</h3>
        ${table}
        ${snapshotPane(snapDom, snapAx)}`}
      </div>
      ${panel}
    </div>
    ${passGrid(recent, nativeRecording ? steps : workflow.steps)}
    ${trajectoryPane(context.recorded, run.trajectory)}
    <div class="tabs" id="run-tabs">
      <button type="button" data-run-tab="trail">Trail</button>
      <button type="button" data-run-tab="inputs">Inputs</button>
      <button type="button" data-run-tab="console">Console</button>
      <button type="button" data-run-tab="network">Network</button>
    </div>
    <div id="run-extra"></div>
  </section>`;
}

function pageClassPane(run: RunSummary): string {
  const items = run.pageClasses || [];
  if (!items.length) return "";
  const rows = items.map((item) => {
    const evidence = (item.evidence || []).map((bit) => `${bit.source}: ${ownerStopText(bit.detail)}`).join(" · ");
    const label = classLabel(item.class);
    const detail = evidence || ownerStopMessage(item.reason);
    const note = detail?.trim().toLowerCase() === label.toLowerCase() ? "" : detail;
    return `<li data-class="${esc(item.class)}"><strong>${esc(label)}</strong>${item.vendor ? ` · ${esc(item.vendor)}` : ""}${note ? ` <span class="quiet">${esc(note)}</span>` : ""}</li>`;
  }).join("");
  const calls = countedModelCalls(run);
  return `<section id="page-class" data-class="${esc(items[items.length - 1]?.class || "")}">
    <h3>Page</h3>
    <ul id="page-class-list">${rows}</ul>
    <p id="page-class-calls">${(run.heals || []).length} heals${calls === undefined ? "" : ` · ${calls} model calls`}</p>
  </section>`;
}

function classLabel(name: string): string {
  if (name === "bot_wall") return "bot check";
  if (name === "login_wall") return "sign-in needed";
  if (name === "clutter") return "popup";
  if (name === "changed") return "page changed";
  return ownerStopText(name);
}

function wallStopLine(stepNumber: number, label: string, item: { class: string; vendor?: string }): string {
  const name = label || "this step";
  if (item.class === "login_wall") {
    return `Step ${stepNumber} '${name}' stopped because a sign-in is needed. bao didn't try to fix it, since signing in needs a person.`;
  }
  const vendor = (item.vendor || "").trim();
  const check = !vendor || vendor.toLowerCase() === "captcha"
    ? "a bot check"
    : `${/^[aeiou]/i.test(vendor) ? "an" : "a"} ${vendor} bot check`;
  return `Step ${stepNumber} '${name}' stopped at ${check}. bao didn't try to fix it, since bot checks need a person.`;
}

function envelopePane(
  envelope: RunSummary["envelope"],
  wait?: { stepNumber: number; label: string },
  checkLimit?: string,
): string {
  if (!envelope || (envelope.status !== "needs_human" && envelope.status !== "needs_signin" && envelope.status !== "timed-out" && envelope.status !== "stopped" && envelope.status !== "completed")) return "";
  const heading = envelope.status === "completed" ? "Completed" : envelope.status === "timed-out" ? "Stopped, timed out" : envelope.status === "stopped" ? "Stopped" : "Needs you";
  if (envelope.status === "needs_human" || envelope.status === "needs_signin") {
    const message = ownerStopMessage(envelope.reason || "", envelope.ask);
    const where = wait
      ? `waiting on step ${wait.stepNumber}, ${wait.label}`
      : envelope.step
        ? `waiting on step ${envelope.step}`
        : "waiting";
    const deadline = (envelope.deadline || "").trim();
    const limit = !deadline || deadline === "No timeout"
      ? checkLimit ? `${wait ? "" : `up to ${checkLimit} per check; `}no overall timeout` : "no timeout"
      : deadline;
    const bits = [
      `<p id="envelope-status"><strong>${esc(heading)}</strong></p>`,
      envelope.run_id ? `<p class="mono" id="envelope-run">${esc(envelope.run_id)}</p>` : "",
      envelope.resume_token ? `<p class="mono" id="envelope-token">${esc(envelope.resume_token)}</p>` : "",
    ].filter(Boolean);
    return `<section id="run-envelope" data-status="${esc(envelope.status)}">
      <h3>${heading}</h3>
      ${message ? `<p id="envelope-ask">${esc(message)}</p>` : ""}
      <p id="envelope-wait">${esc(`${where} · ${limit}`)}</p>
      <details id="envelope-details"><summary>Details</summary>${bits.join("")}</details>
    </section>`;
  }
  return `<section id="run-envelope" data-status="${esc(envelope.status)}">
    <h3>${heading}</h3>
    <p id="envelope-status"><strong>${esc(heading)}</strong></p>
    ${envelope.ask ? `<p id="envelope-ask">${esc(ownerStopMessage(envelope.reason || "", envelope.ask))}</p>` : ""}
    ${envelope.reason && envelope.reason !== envelope.ask ? `<p id="envelope-reason">${esc(ownerStopMessage(envelope.reason))}</p>` : ""}
    ${envelope.deadline ? `<p id="envelope-deadline">${esc(envelope.deadline)}</p>` : ""}
    ${envelope.step ? `<p id="envelope-step">Step ${esc(envelope.step)}</p>` : ""}
    ${envelope.run_id ? `<p class="mono" id="envelope-run">${esc(envelope.run_id)}</p>` : ""}
    ${envelope.resume_token ? `<p class="mono" id="envelope-token">${esc(envelope.resume_token)}</p>` : ""}
  </section>`;
}

function handoffPane(trail: RunSummary["trail"]): string {
  const rows = (trail || []).filter((event) => event.kind === "handoff" && event.text);
  if (!rows.length) return "";
  return `<ol id="handoff-trail">${rows.map((event) => `<li>${esc(ownerStopMessage(event.text || ""))}</li>`).join("")}</ol>`;
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

function shotPane(before: string, after: string, action?: string, label?: string, beforeError?: string, afterError?: string): string {
  const which = after || afterError ? "after" : "before";
  const missing = "No picture was saved for this step.";
  return `<div class="shots" id="shots">
    <div class="row">
      <button type="button" class="toggle ${which === "before" ? "on" : ""}" data-frame="before">Before</button>
      <button type="button" class="toggle ${which === "after" ? "on" : ""}" data-frame="after">After</button>
    </div>
    <div class="shot-stage" id="shot-stage" data-before="${esc(before)}" data-after="${esc(after)}" data-before-error="${esc(beforeError || missing)}" data-after-error="${esc(afterError || missing)}" data-which="${which}">${placeholder(action, label || "This step")}<p class="quiet" data-shot-error hidden></p></div>
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
  if (timed.length === 0 && !run.video) return `<div id="video-bar" hidden></div>`;
  const origin = run.videoStartedAt || timed[0]?.startedAt || 0;
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
    <video id="run-video" src="${esc(src)}" poster="/api/runs/${encodeURIComponent(run.id)}/poster" data-skips="${skipData}" controls preload="auto" style="display:block;width:100%;height:240px;object-fit:contain;background:#1c1915"></video>
    <div class="timeline">${markers}</div>
    ${run.videoTruncated ? `<p class="quiet">Video truncated at the capture limit.</p>` : ""}
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
  if (value === "never") return "healing turned off (Stop)";
  return value;
}

function skipMark(ms: number, left?: string): string {
  const style = left ? ` style="left:${left}"` : "";
  return `<span class="skip-marker" data-skipped="${ms}"${style}>${esc(skipLabel(ms))}</span>`;
}

export function secretInput(name: string, label: string, value: string): string {
  return `<label>${esc(label)} <input name="${esc(name)}" type="password" autocomplete="off" value="${esc(value)}"></label>`;
}

/** The run form. Defaults come from the same token fields the step text shows. */
export function runField(input: TokenInput, previous?: string, now = new Date()): string {
  if (input.fresh) {
    input = { ...input, default: undefined, relative: undefined };
    previous = undefined;
  }
  const shown = tokenFields(input);
  const label = esc(shown.label);
  if (shown.masked) return secretInput(input.name, shown.label, previous && previous !== "••••" && !hasStrippedSecret(previous) ? previous : shown.default);
  if (input.type === "number") return `<label>${label} <input name="${esc(input.name)}" type="number" value="${esc(previous || shown.default)}"></label>`;
  if (input.type === "choice") {
    const opts = (input.choices || []).map((choice) => `<option ${choice === previous ? "selected" : ""}>${esc(choice)}</option>`).join("");
    return `<label>${label} <select name="${esc(input.name)}">${opts}</select></label>`;
  }
  if (input.type === "file" && input.fromOutput) {
    const stepName = input.boundStep || input.fromOutput;
    return `<label class="drop" data-from-output="${esc(input.fromOutput)}">${label} <span>From this run: ${esc(stepName)}</span></label>`;
  }
  if (input.type === "file") {
    const hint = previous ? `Last file: ${previous}. Drop a file here, or choose one.` : "Drop a file here, or choose one.";
    return `<label class="drop">${label} <input name="${esc(input.name)}" type="file" ${input.multiple ? "multiple" : ""}> <span>${esc(hint)}</span></label>`;
  }
  if (input.type === "date") {
    const expr = previous || input.relative || input.default || "today";
    const format = input.format || "YYYY-MM-DD";
    const zone = input.zone || "UTC";
    let preview = "";
    try {
      preview = datePreview(expr, format, zone, now);
    } catch {
      preview = "not a date";
    }
    return `<label class="date-field">${label} <input name="${esc(input.name)}" type="text" value="${esc(expr)}" autocomplete="off" data-date="${esc(expr)}"> <span class="date-preview" data-resolved="${esc(preview)}">Resolves to ${esc(preview)}</span></label>`;
  }
  const text = previous && previous !== "••••" && !hasStrippedSecret(previous) ? previous : shown.default;
  return `<label>${label} <textarea name="${esc(input.name)}" rows="2">${esc(text)}</textarea></label>`;
}

function storedInputsLine(inputs: Record<string, string> | undefined): string {
  const rows = Object.entries(inputs || {});
  if (!rows.length) return "";
  const bits = rows.map(([key, value]) => `${esc(key)}: ${esc(value)}`);
  return `<p class="quiet" id="stored-inputs">${bits.join(" · ")}.</p>`;
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

export function runConsoleLines(run: RunSummary): ConsoleLine[] | undefined {
  if (run.kind !== "capture" || run.pageEngine !== "agent-browser") return run.console;
  return (run.steps || []).flatMap((step) => (step.native?.results || []).flatMap((result) =>
    (["stdout", "stderr"] as const).filter((type) => result[type].length > 0).map((type) => ({
      stepId: step.id, type, text: result[type], ts: step.endedAt,
    }))));
}

export function consolePane(lines: ConsoleLine[] | undefined, stepId?: string): string {
  const all = lines || [];
  const mine = stepId ? all.filter((line) => line.stepId === stepId) : all;
  const shown = mine.length ? mine : all;
  const note = mine.length || !all.length ? "" : `<p class="quiet">No console lines on this step. Showing the page load.</p>`;
  if (!shown.length) return `<p class="quiet" id="console-log">No console lines were captured.</p>`;
  const rows = shown.map((line) => {
    const when = typeof line.ts === "number" ? formatClock(line.ts) : "";
    return `<li><span class="quiet">${esc([when, line.type || "log"].filter(Boolean).join(" "))}</span> ${esc(ownerStopText(line.text))}</li>`;
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

export function trailPane(events: { id?: string; ts?: number; op?: string; kind?: string; text?: string; reason?: string }[]): string {
  if (events.length === 0) return `<p class="quiet">No trail events.</p>`;
  const lines = events.map((event) => {
    const when = typeof event.ts === "number" ? formatClock(event.ts) : "";
    return [when, event.kind || "", event.op || "", event.id || "", event.reason ? ownerStopMessage(event.reason) : ownerStopText(event.text || "")].filter(Boolean).join(" ");
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
  const classes = filter === "pending" ? classRows(runs, workflows) : "";
  return `<section id="heal-inbox">
    <header class="row"><h2>Heals</h2>
      <button type="button" data-heal-filter="pending">Pending</button>
      <button type="button" data-heal-filter="kept">Kept</button>
      <button type="button" data-heal-filter="reverted">Reverted</button>
    </header>
    ${classes}
    ${list || (classes ? "" : `<p class="quiet">Nothing ${filter}.</p>`)}
    <div id="heal-detail"></div>
  </section>`;
}

function classRows(runs: RunSummary[], workflows: WorkflowSummary[]): string {
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const rows: string[] = [];
  for (const run of runs) {
    for (const item of run.pageClasses || []) {
      const evidence = (item.evidence || []).map((bit) => `${bit.source}: ${ownerStopText(bit.detail)}`).join(" · ");
      const calls = countedModelCalls(run);
      rows.push(`<article class="heal-row" data-page-class="${esc(item.class)}" data-run="${esc(run.id)}">
        <strong>${esc(names.get(run.workflowId) || run.workflowId)}</strong> · ${esc(item.stepId)} · ${esc(classLabel(item.class))}
        <span class="quiet">${esc(ownerStopMessage(item.reason, item.line))}</span>
        ${evidence ? `<span class="quiet">${esc(evidence)}</span>` : ""}
        <span class="quiet">${(run.heals || []).length} heals${calls === undefined ? "" : ` · ${calls} model calls`}</span>
      </article>`);
    }
  }
  return rows.join("");
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

export function healDetail(run: RunSummary, heal: HealView, extra: { promotion?: PromotionView; workflowName?: string } = {}): string {
  const recorded = heal.failedStep?.identity;
  const hasProposal = !!heal.proposedPatch;
  const proposed = heal.proposedPatch?.identity;
  const before = imageRef(run.id, heal.beforeShot);
  const after = imageRef(run.id, heal.snapshot?.screenshot) || imageRef(run.id, heal.snapshot?.screenshotRef);
  const picture = (src: string, label: string) => `<div class="heal-shot">${src
    ? `<img src="${esc(src)}" alt="${esc(label)}" data-heal-shot><span class="heal-missing" hidden>Picture unavailable</span>`
    : `<span class="heal-missing">No picture stored</span>`}</div>`;
  const step = heal.failedStep?.index === undefined ? "Target" : `Step ${heal.failedStep.index + 1}`;
  const oldTarget = healTargetDescription(recorded, heal.failedStep?.label);
  const newTarget = healTargetDescription(proposed, heal.proposedPatch?.label);
  const promotion = extra.promotion || (run.promotion?.healId === heal.id ? run.promotion : undefined);
  const need = promotion?.need && promotion.need > 0 ? promotion.need : DEFAULT_PROMOTE_AFTER;
  const clean = promotion?.replays ?? 0;
  const status = promotion?.status || "provisional";
  const targetName = recorded?.name || recorded?.text;
  const location = proposed?.path?.at(-1);
  const move = targetName && location?.name ? `“${targetName}” moved into the ${location.name} ${location.role}.` : "The recorded target moved.";
  const outcome = heal.postconditionPassed === true && run.status === "passed" ? "Bao found it there and finished."
    : heal.postconditionPassed === false ? "The new target did not pass its check. Review it before keeping it."
    : "Review the new target before keeping it.";
  const prompt = heal.prompt || "";
  const raw = heal.rawResponse || "";
  const candidates = heal.identity?.candidates?.map((candidate, index) =>
    `#${index + 1} ${esc(candidate.label)} ${candidate.score}`).join("  ") || "No other candidates stored on this record.";
  const post = heal.postconditionPassed === undefined ? "not run" : heal.postconditionPassed ? "passed" : "failed";
  const decisions = (run.decisions || []).filter((item) => item.healId === heal.id);
  const lastDecision = decisions.at(-1)?.decision;
  const reviewState = lastDecision || (status === "promoted" ? "keep" : status === "reverted" ? "revert" : hasProposal ? "pending" : "no-proposal");
  const note = lastDecision === "keep" ? "Saved this target as a draft. Replay still uses the live version until you promote it."
    : lastDecision === "revert" ? "Saved the recorded target as a draft. Replay still uses the live version until you promote it."
    : reviewState === "keep" ? "Bao kept this target."
    : reviewState === "revert" ? "Bao reverted this target to the saved step."
    : !hasProposal ? "No new target was proposed. You can save the recorded target as a draft with Revert."
    : `Bao keeps a heal after ${need} clean runs. Keep it now if the new target looks right.`;
  const decisionLine = decisions.map((item) => `${item.decision} at ${formatClock(item.ts)}`).join(", ");
  const model = heal.model ? `${heal.model.name || ""} ${heal.model.version || ""}`.trim() : "no model";
  const name = extra.workflowName || healWorkflowName(heal, run, new Map());
  return `<article id="heal-detail" data-heal="${esc(heal.id)}" data-run="${esc(run.id)}" aria-label="Target review: ${esc(name)}">
    <p class="heal-kicker"><span class="heal-state">${hasProposal ? runStatusGlyph("healed") : ""}${reviewState === "keep" ? "Target kept" : reviewState === "revert" ? "Target reverted" : hasProposal ? "Heal to keep" : "No proposed target"}</span><span class="heal-dot" aria-hidden="true"></span><span id="heal-workflow">${esc(name)}</span>${heal.ts === undefined ? "" : `<span class="heal-dot" aria-hidden="true"></span><span>${esc(formatWhen(heal.ts))}</span>`}</p>
    <h2>${esc(step)}${hasProposal ? " moved" : " needs review"}</h2>
    <p class="heal-lead">${hasProposal ? `${esc(move)} ${esc(outcome)}` : "Bao could not propose a new target for this step."}</p>
    <div class="heal-comparison">
      <figure>${picture(before, "Page at the start of the failed step")}<figcaption><b>Before</b> · start of step</figcaption></figure>
      <figure>${picture(after, "Page when the step failed")}<figcaption><b>Now</b>${heal.ts === undefined ? "" : ` · ${esc(new Date(heal.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}`}</figcaption></figure>
    </div>
    <dl class="heal-facts">
      <dt>Old target</dt><dd>${esc(oldTarget)}</dd>
      <dt>New target</dt><dd>${hasProposal ? esc(newTarget) : "No target proposed"}</dd>
      <dt>Clean runs</dt><dd id="promotion" data-status="${esc(status)}"><span class="heal-count">${promotion ? `${clean} of ${need}` : "Not recorded"}</span>${promotion ? `<div class="heal-segments" aria-hidden="true">${Array.from({ length: need }, (_, index) => `<i${index < clean ? ' class="passed"' : ""}></i>`).join("")}</div>` : ""}</dd>
    </dl>
    <p class="heal-note">${esc(note)}</p>
    <div class="heal-actions">
      <button type="button" class="primary" data-keep="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}"${hasProposal ? "" : " disabled"}>Keep new target</button>
      <button type="button" data-revert="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}">Revert…</button>
    </div>
    <p id="heal-decision-status" role="status"></p>
    <details class="heal-technical"><summary><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Technical details</summary>
      <div class="heal-code"><p>Recorded: ${targetLines(recorded, heal.failedStep?.label)}</p><p>Proposed: ${targetLines(proposed, heal.proposedPatch?.label)}</p>
        <p>${esc(heal.mode || "")} · ${esc(model)}</p><p id="heal-candidates">Candidates ${candidates}</p><p>Postcondition after patch: ${esc(post)}</p>
        <details id="heal-prompt"><summary>Prompt</summary><pre>${esc(prompt)}</pre></details>
        <details id="heal-response"><summary>Raw response</summary><pre>${esc(raw)}</pre></details>
        <p>Keep saves a draft version. Replay keeps using the live version until you promote it. Revert saves the recorded target as a draft too. Both are appended. The heal record is not edited. ${esc(decisionLine)}</p>
      </div>
    </details>
    <dialog id="heal-revert-confirm" aria-labelledby="heal-revert-title" aria-describedby="heal-revert-body">
      <form method="dialog">${baoMark("heal-confirm-mark")}<h3 id="heal-revert-title">Revert ${esc(step.toLowerCase())}?</h3>
        <p id="heal-revert-body">Bao saves the recorded target as a draft. Replay keeps using the live version until you promote it.</p>
        <div class="heal-confirm-actions"><button type="submit" value="revert">Revert ${esc(step.toLowerCase())}</button><button type="submit" value="cancel" autofocus>Cancel</button></div>
      </form>
    </dialog>
  </article>`;
}

function healTargetDescription(identity: HealTarget | undefined, label?: string): string {
  if (!identity) return label || "Target not recorded";
  const name = identity.name || identity.text;
  const target = name ? `“${name}”${identity.role ? ` ${identity.role}` : ""}` : label || identity.testId || identity.id || identity.role || "Target not recorded";
  const parent = identity.path?.at(-1);
  return parent ? `${target} in ${parent.name ? `“${parent.name}” ` : ""}${parent.role}` : target;
}

export function libraryTable(workflows: WorkflowSummary[], runs: RunSummary[], promotions: PromotionView[] = [], splits: string[] = [], home = "", damagedWorkflows: import("../v1/store").DamagedWorkflow[] = []): string {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    const previous = latest.get(run.workflowId);
    if (!previous || (run.at || 0) > (previous.at || 0)) latest.set(run.workflowId, run);
  }
  const rows = workflows.slice().sort((a, b) => (latest.get(b.id)?.at || 0) - (latest.get(a.id)?.at || 0)).map((workflow) => {
    const run = latest.get(workflow.id);
    const kind = run ? runKind(run, promotions.find((item) => item.workflowId === workflow.id)) : "";
    const label = run ? statusLabel(kind) : "Not run yet";
    const at = run && runTime(run);
    const when = at !== undefined
      ? `<time datetime="${new Date(at).toISOString()}">${esc(formatClock(at))}</time>`
      : run ? "Time not saved" : "";
    return `<tr class="workflow-row" data-workflow="${esc(workflow.id)}" role="row">
      <td role="cell"><button type="button" class="link workflow-name" data-open-workflow="${esc(workflow.id)}">${esc(workflow.name)}</button>${workflow.driver === "cdp-live" ? `<p class="workflow-note">This workflow used the retired live driver.</p>` : ""}</td>
      <td role="cell"><span class="status ${esc(kind)}">${workflowStatusGlyph(kind)}${esc(label.charAt(0).toUpperCase() + label.slice(1))}</span></td>
      <td role="cell" class="workflow-when">${when}</td>
    </tr>`;
  }).join("");
  const empty = damagedWorkflows.length
    ? `<div class="empty" id="library-empty"><strong>No workflows can open</strong>Restore a saved copy, or record a task again.</div>`
    : `<div class="empty" id="library-empty"><strong>No workflows yet</strong>Record a task to run it again.<p><button type="button" data-screen="capture">Record a task</button></p></div>`;
  const damaged = damagedWorkflows.length ? `<aside id="library-damaged" aria-labelledby="library-damaged-title" role="note">
    <h3 id="library-damaged-title">${icon("warning")}${damagedWorkflows.length === 1 ? `Bao can’t open “${esc(damagedWorkflows[0]!.file)}”.` : `Bao can’t open ${damagedWorkflows.length} workflows.`}</h3>
    <p>${damagedWorkflows.length === 1 ? "Its file is damaged." : "Their files are damaged."} ${workflows.length ? "Your other workflows are fine. " : ""}Record it again, or restore a saved copy.</p>
    <div class="library-damaged-actions"><button type="button" id="library-record-again" data-screen="capture">Record again</button><button type="button" id="library-reveal">Show in Finder</button></div>
    <p id="library-reveal-status" role="status"></p>
    <details hidden><summary>File details and recovery</summary>
      <ul>${damagedWorkflows.map(({ file, reason }) => `<li><strong>${esc(file)}</strong><p>${esc(reason)}</p><p class="damaged-path">${esc(home ? `${home}/workflows/${file}` : `workflows/${file}`)}</p></li>`).join("")}</ul>
      <p>In Finder, choose Go &gt; Go to Folder to find the file above. Restore a backup, fix the file, or move it out of the workflows folder.</p>
    </details>
  </aside>` : "";
  const split = splits.length ? `<p id="library-split">${splits.map((line) => esc(line)).join("<br>")}</p>` : "";
  const damagedRows = damagedWorkflows.map(({ file }) => `<tr class="workflow-row damaged-workflow-row" role="row">
    <td role="cell"><button type="button" class="link workflow-name" data-damaged-file>${esc(file)}</button></td>
    <td role="cell"><span class="status failed">${icon("warning")}Can’t open</span></td><td role="cell"></td>
  </tr>`).join("");
  const count = workflows.length + damagedWorkflows.length;
  return `<section id="library">
    <header class="library-heading">
      <button id="sidebar-toggle" type="button" aria-label="Show sidebar" aria-haspopup="dialog" aria-controls="sidebar-dialog"><svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg></button>
      <div><h2>Workflows</h2><p class="lede">${count === 1 ? "1 workflow" : `${count} workflows`}</p></div>
      <button type="button" class="library-record" data-screen="capture"><svg class="record-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3.6" fill="currentColor"/></svg>Record</button>
      <button type="button" id="library-search-open" aria-label="Search workflows" aria-expanded="false" aria-controls="library-tools">${icon("search")}</button>
    </header>
    ${split}
    ${damaged}
    <div class="tools" id="library-tools" hidden>
      <input id="library-search" type="search" placeholder="Search workflows" aria-label="Search workflows">
      <button type="button" id="palette-open" class="kbd" aria-label="Open commands">⌘K</button>
    </div>
    ${rows || damagedRows ? `<table id="workflow-list" role="table" aria-label="Workflows, newest run first">
      <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Name</th><th scope="col" role="columnheader">Last run</th><th scope="col" role="columnheader">When</th></tr></thead>
      <tbody role="rowgroup">${rows}${damagedRows}</tbody>
    </table><p id="library-search-status" role="status"></p><div class="empty" id="library-no-results" hidden><strong>No matching workflows</strong><p>Try another name, or clear the search.</p><button type="button" id="library-clear-search">Clear search</button></div>` : ""}
    ${!rows ? empty : ""}
  </section>`;
}

export function notices(items: { id?: string; title?: string; body?: string }[]): string {
  return items.map((item) => `<div class="toast" data-notice="${esc(item.id || item.title || "")}"><div><strong>${esc(ownerStopText(item.title || ""))}</strong><div>${esc(ownerStopText(item.body || ""))}</div></div><button type="button" data-dismiss="${esc(item.id || item.title || "")}" aria-label="Dismiss">Close</button></div>`).join("");
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

function countedModelCalls(run: RunSummary): number | undefined {
  // A live capture records an outside agent, whose model calls Bao does not count.
  if (run.kind === "capture") return undefined;
  return typeof run.modelCalls === "number" && Number.isSafeInteger(run.modelCalls) && run.modelCalls >= 0 ? run.modelCalls : undefined;
}

export function runKind(run: RunSummary, promotion?: PromotionView): string {
  if (run.status === "timed-out") return "timed-out";
  if (run.kind === "capture") return run.status === "needs_human" ? "paused" : run.status;
  if (promotion?.status === "provisional" || run.promotion?.status === "provisional") return "provisional";
  if (run.status === "needs_human" || run.status === "paused") return "paused";
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

export function plainFailure(input: {
  phase?: string;
  changed?: string;
  reason?: string;
  instruction?: string;
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
  else if (input.reason) bits.push(ownerStopMessage(input.reason, input.instruction));
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
    return `<p id="promotion" data-status="reverted">Reverted. ${esc(ownerStopText(promotion.reason || "A later check failed"))} put the saved step back.</p>`;
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
  expect?: { kind?: string; match?: string; state?: string };
  postcondition?: { kind: "url" | "text" | "value" | "element" | "absent"; match?: string; identity?: { name?: string; text?: string; role?: string } };
  readBack?: { source?: string; match?: string };
  identity?: { role?: string; name?: string; text?: string; testId?: string; id?: string };
  heal?: string;
  when?: { input?: string; value?: string; present?: string };
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

function mustacheName(value: string | undefined): string {
  return value?.match(/\{\{\s*([\w.-]+)\s*\}\}/)?.[1] || "";
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
  const status = result.matched ? "Matched" : `No match${result.reason ? `: ${ownerStopMessage(result.reason)}` : ""}`;
  const actions = result.actions ?? 0;
  const calls = result.modelCalls ?? 0;
  return `<div id="try-result" data-matched="${result.matched ? "1" : "0"}" data-actions="${actions}" data-model-calls="${calls}">
    <p><strong>${esc(status)}</strong> <span class="quiet">${actions} actions · ${calls} model calls</span></p>
    ${picture}
    ${lead}
    ${identityTable(result.identity)}
  </div>`;
}

/** Settings line for the extension host grant. Revoke calls chrome.permissions.remove in the extension. */
export function hostAccessPanel(access: unknown): string {
  const mode = hostAccessMode(access);
  const label = hostAccessLabel(mode);
  const revoke = mode === "none" ? " disabled" : "";
  return `<section id="host-access">
    <h3>Chrome sites</h3>
    <p id="host-access-status" data-host-access="${mode}">Site access: ${label}</p>
    <p class="quiet">Allow all sites lets Bao read and act on any site in this Chrome profile. Bao only does that while a run or a recording is active. Revoke takes that away.</p>
    <button type="button" id="revoke-hosts"${revoke}>Revoke</button>
  </section>`;
}

function workflowStepKind(step: StepCard): { label: string; glyph: string } {
  const human = step.human || step.action === "login" || step.action === "confirm";
  const label = human ? "Waits for you" : ({ navigate: "Open page", click: "Click", type: "Type", digits: "Type", key: "Press key", check: "Choose", select: "Choose", verify: "Check", upload: "Upload file", drop: "Drop file", download: "Save file", open: "Open file", extract: "Read table", for_each: "Repeat", note: "Note" } as Record<string, string>)[step.action || ""] || "Step";
  const path = human ? "M5.25 8.5V3.75a1 1 0 0 1 2 0V7.5M7.25 7V2.75a1 1 0 0 1 2 0V7M9.25 7V3.75a1 1 0 0 1 2 0v4.5M11.25 6.5a1 1 0 0 1 2 0v2.75a4.75 4.75 0 0 1-4.75 4.75h-.4a4.1 4.1 0 0 1-3.3-1.66L2.9 9.85a1 1 0 0 1 1.5-1.3l.85.95"
    : step.action === "type" ? "M3.5 4h9A1.75 1.75 0 0 1 14.25 5.75v4.5A1.75 1.75 0 0 1 12.5 12h-9a1.75 1.75 0 0 1-1.75-1.75v-4.5A1.75 1.75 0 0 1 3.5 4ZM4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.5h5"
    : step.action === "select" ? "m2.25 4.25 1.25 1.25 2.25-2.5M8 4.25h5.75M8 8.25h5.75M8 12.25h5.75M3 8.25h1.5M3 12.25h1.5"
    : step.action === "navigate" ? "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0ZM2 8h12M8 2c-3 3-3 9 0 12 3-3 3-9 0-12Z"
    : step.action === "verify" ? "M1.75 8s2.25-4.25 6.25-4.25S14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8ZM9.75 8a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z"
    : "M4.5 2.5v9.25l2.4-2.3 1.75 4 1.7-.75-1.75-3.95 3.4-.3Z";
  return { label, glyph: `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>` };
}

function workflowStepTitle(step: StepCard, inputs: TokenInput[]): string {
  return workflowInputLabels(step.label || step.action || step.id, inputs);
}

function workflowInputLabels(text: string, inputs: TokenInput[]): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) => {
    const input = inputs.find((item) => item.name === name);
    return input?.label || input?.name || match;
  });
}

function workflowCheckText(text: string, inputs: TokenInput[]): string {
  return text.split(/\{\{\s*([\w.-]+)\s*\}\}/g).map((part, index) => {
    if (index % 2 === 0) return part ? `“${part}”` : "";
    const input = inputs.find((item) => item.name === part);
    return `the ${input?.label || input?.name || "saved"} input`;
  }).filter(Boolean).join(" followed by ");
}

function workflowStatusGlyph(kind: string): string {
  const mark = kind === "passed" ? "m4 7.2 2 2 4-4.4" : kind === "failed" ? "m4.6 4.6 4.8 4.8M9.4 4.6 4.6 9.4" : kind === "healed" ? "M7 3.9v6.2M3.9 7h6.2" : kind === "paused" ? "M5.2 4v6M8.8 4v6" : "M7 3.8V7l2.2 1.4";
  return `<svg class="workflow-status-icon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="currentColor"/><path d="${mark}" fill="none" stroke="var(--bg)" stroke-width="${kind === "failed" ? "1.7" : kind === "healed" ? "1.8" : "1.6"}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function workflowRunStatus(run: RunSummary): string {
  const kind = runKind(run);
  return `<span class="wf-run-status ${esc(kind)}">${workflowStatusGlyph(kind)}${esc(statusLabel(kind))}</span>`;
}

export function workflowSidebarToggle(): string {
  return `<button id="sidebar-toggle" type="button" aria-label="Show sidebar" aria-haspopup="dialog" aria-controls="sidebar-dialog">${icon("sidebar")}</button>`;
}

export function workflowDetail(
  doc: { id: string; name: string; summary?: string; intent?: string; startUrl?: string; steps: StepCard[]; inputs?: TokenInput[] },
  meta: {
    runs?: RunSummary[];
    lastRunId?: string;
    selectedStep?: string;
    shots?: Record<string, string>;
    share?: { link?: string; publishEnabled?: boolean; publishWhy?: string; exportEnabled?: boolean; exportWhy?: string };
  } = {},
): string {
  const inputs = doc.inputs || [];
  const selected = doc.steps.find((step) => step.id === meta.selectedStep) || doc.steps[0];
  const rows = doc.steps.map((step, index) => {
    const kind = workflowStepKind(step);
    const input = step.input || mustacheName(step.value) || mustacheName(step.label);
    return `<tr data-step-row="${esc(step.id)}"${step === selected ? ` class="selected"` : ""}>
      <td class="wf-number">${index + 1}</td><td class="wf-kind" title="${esc(kind.label)}">${kind.glyph}<span class="sr-only">${esc(kind.label)}</span></td>
      <td><button type="button" class="wf-step-pick" data-workflow-step="${esc(step.id)}" data-step-input="${esc(input)}" aria-pressed="${step === selected}" aria-controls="workflow-inspector">${esc(workflowStepTitle(step, inputs))}</button></td>
      <td class="wf-uses">${input ? `<span class="wf-token">${esc(inputs.find((item) => item.name === input)?.label || input)}</span>` : ""}</td>
      <td class="wf-check">${step.expect || step.postcondition || step.readBack || step.action === "verify" ? `<span title="Then checks the page" aria-label="Then checks the page">${workflowStepKind({ id: "", action: "verify" }).glyph}</span>` : ""}</td>
    </tr>`;
  }).join("");
  const panels = doc.steps.map((step, index) => {
    const kind = workflowStepKind(step);
    const known = meta.shots?.[step.id] || "";
    const captured = `/api/workflows/${encodeURIComponent(doc.id)}/shots/${encodeURIComponent(workflowShotName(step.id))}`;
    const shot = known || (meta.lastRunId ? `/api/runs/${encodeURIComponent(meta.lastRunId)}/shots/${encodeURIComponent(shotFile(step.id, "after"))}` : captured);
    const input = inputs.find((item) => item.name === (step.input || mustacheName(step.value) || mustacheName(step.label)));
    const targetName = step.identity?.name || step.identity?.text || step.identity?.testId || step.identity?.id;
    const targetKind = step.identity?.role === "textbox" ? "box" : step.identity?.role === "combobox" ? "menu" : step.identity?.role || "control";
    const target = targetName ? `The “${targetName}” ${targetKind}` : "";
    const branch = step.when?.present ? `Only when “${step.when.present}” is on the page.` : step.when?.value ? `Only for “${step.when.value}”.` : "";
    const checks: string[] = [];
    if (step.expect) checks.push(step.expect.kind === "settled" ? "The page finishes loading"
      : step.expect.match ? `The ${step.expect.kind === "url" ? "address" : "page"} ${mustacheName(step.expect.match) ? "matches" : "shows"} ${workflowCheckText(step.expect.match, inputs)}`
      : step.expect.state ? `The control is ${step.expect.state}` : "The saved check");
    const post = step.postcondition;
    const postTarget = post?.identity?.name || post?.identity?.text || post?.identity?.role || "saved control";
    if (post) checks.push(post.kind === "element" || post.kind === "absent"
      ? `The ${mustacheName(postTarget) ? "control matching " : ""}${workflowCheckText(postTarget, inputs)} ${post.kind === "absent" ? "is gone" : "is on the page"}`
      : `The ${post.kind === "url" ? "address" : post.kind === "value" ? "value" : "page"} ${mustacheName(post.match) ? "matches" : "shows"} ${workflowCheckText(post.match || "", inputs)}`);
    if (step.readBack) checks.push(`Reads ${step.readBack.source || "the value"}${step.readBack.match ? ` matching ${workflowCheckText(step.readBack.match, inputs)}` : ""}`);
    const check = [...new Set(checks)].join(". ") || (step.action === "verify" ? "The saved check" : "Nothing extra");
    const inputVerb = ({ type: "Types", digits: "Types", select: "Picks", upload: "Uploads", drop: "Drops", navigate: "Opens" } as Record<string, string>)[step.action || ""] || "Uses";
    return `<section data-step-panel="${esc(step.id)}"${step !== selected ? " hidden" : ""}>
      <p class="wf-eyebrow">${kind.glyph}Step ${index + 1} of ${doc.steps.length} · ${esc(kind.label)}</p>
      <h2>${esc(workflowStepTitle(step, inputs))}</h2>
      <div class="wf-picture" data-shot-alt="Saved page for step ${index + 1}: ${esc(workflowStepTitle(step, inputs))}" data-shot="${esc(shot)}"${shot !== captured ? ` data-shot-fallback="${esc(captured)}"` : ""}></div>
      ${step.intent ? `<p>${esc(step.intent)}</p>` : ""}${branch ? `<p class="quiet"${step.when?.value ? ` data-route="${esc(step.when.value)}"` : ""}>${esc(branch)}</p>` : ""}
      <dl class="wf-facts"><dt>Finds</dt><dd>${esc(target || (step.action === "navigate" ? step.value || doc.startUrl || "The saved page" : "No saved target"))}</dd>
        ${input ? `<dt>${inputVerb}</dt><dd>${inputToken(input)} <span class="quiet">${esc(tokenFields(input).masked ? "••••" : tokenFields(input).default)}</span></dd>` : step.value ? `<dt>Value</dt><dd>${esc(step.value)}</dd>` : ""}
        <dt>Then checks</dt><dd>${esc(check)}</dd>
        <dt><label for="wf-miss-${index}">If it misses</label></dt><dd><select id="wf-miss-${index}" data-step-heal="${esc(step.id)}">
          <option value="" ${step.heal ? "" : "selected"}>Use workflow setting</option><option value="auto" ${step.heal === "auto" ? "selected" : ""}>Heal it</option><option value="ask" ${step.heal === "ask" ? "selected" : ""}>Ask me</option><option value="never" ${step.heal === "never" ? "selected" : ""}>Stop the run</option>
        </select></dd></dl>
      <div class="wf-actions"><button type="button" data-try-step="${esc(step.id)}">${icon("play")}Try this step</button><button type="button" data-run-from="${esc(step.id)}" data-step-n="${index + 1}">Run from here</button></div>
      <div class="try-slot" data-try-slot="${esc(step.id)}"></div>
      <details class="wf-technical"><summary>${icon("chevron")}Technical details</summary><pre>${esc(JSON.stringify(step, null, 2))}</pre></details>
    </section>`;
  }).join("");
  const runs = [...(meta.runs || [])].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 5);
  const history = runs.map((run) => {
    const kind = runKind(run);
    const completed = (run.steps || []).filter((step) => step.status === "passed").length;
    const detail = run.failure?.reason ? ownerStopMessage(run.failure.reason)
      : kind === "paused" ? "Waiting for you"
      : run.steps?.length ? `${completed} steps completed` : "No step results saved";
    return `<li><button type="button" data-open-run="${esc(run.id)}">${workflowRunStatus(run)}<span>${esc(detail)}</span><time>${esc(typeof run.at === "number" ? formatWhen(run.at) : "Time not recorded")}</time></button></li>`;
  }).join("");
  const choice = inputs.find((input) => input.type === "choice" && input.choices?.length);
  const paths = choice?.choices ? `<p id="route-branch">Paths: ${esc(choice.choices.join(" / "))}</p>` : "";
  let site = "";
  try { site = doc.startUrl ? new URL(doc.startUrl).hostname : ""; } catch { /* Relative addresses have no hostname. */ }
  return `<section id="workflow-detail" data-workflow="${esc(doc.id)}">
    <div class="workflow-overview"><div class="wf-toolbar">${workflowSidebarToggle()}<button type="button" class="link" data-screen="library" aria-label="Back to all workflows">${icon("back")}</button><span>Workflows</span><span class="wf-toolbar-spacer"></span><details id="workflow-options"><summary aria-label="More actions for this workflow">${icon("more")}</summary><div class="wf-options-panel">${shareMenu(doc, meta.share)}<div id="workflow-tools"></div></div></details><button type="button" data-screen="capture">${icon("record")}Record</button></div>
    <div class="wf-body"><header class="wf-head"><h2>${esc(doc.name)}</h2>${doc.summary ? `<p id="workflow-summary">${esc(doc.summary)}</p>` : ""}${doc.intent ? `<p id="workflow-intent">${esc(doc.intent)}</p>` : ""}
      <p class="wf-metadata">${site ? `${workflowStepKind({ action: "navigate", id: "" }).glyph}<span>${esc(site)}</span><span>·</span>` : ""}<span>${doc.steps.length} steps</span><span>·</span>${runs[0] ? `<span>Last run ${workflowRunStatus(runs[0])}</span><span>${esc(typeof runs[0].at === "number" ? formatWhen(runs[0].at) : "Time not recorded")}</span>` : `<span>Not run yet</span>`}</p>
      <div class="wf-actions"><button type="button" class="primary" data-screen="replay" data-workflow="${esc(doc.id)}">${icon("play")}Run…</button><button type="button" id="workflow-edit-inputs"${inputs.length ? "" : " disabled"}>Edit inputs…</button><button type="button" data-guide="${esc(doc.id)}">Guide me</button></div>${paths}
    </header>
    <div id="workflow-conflicts"></div>
    <div id="workflow-steps">${rows ? `<table class="wf-steps" aria-label="Steps. Select a step to see it in the inspector."><thead><tr><th class="wf-number" scope="col">#</th><th class="wf-kind" scope="col"><span class="sr-only">Kind</span></th><th scope="col">Step</th><th class="wf-uses" scope="col">Uses input</th><th class="wf-check" scope="col"><span class="sr-only">Checks</span></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty"><strong>No steps yet</strong><p>Record a task to add steps.</p><button type="button" data-screen="capture">Record a task</button></div>`}</div>
    <section class="wf-recent"><h3>Recent runs</h3>${history ? `<ul>${history}</ul>` : `<p class="quiet">No runs yet. Run this workflow to see what happened.</p>`}</section>
    </div></div>
    <aside id="workflow-inspector" aria-label="Step inspector"><div class="wf-toolbar"><h3>Inspector</h3><span class="wf-toolbar-spacer"></span><button type="button" id="workflow-search" aria-label="Search workflows and runs">${icon("search")}</button></div><div class="wf-inspector-body">${panels || `<p class="quiet">Select a step once this workflow has steps.</p>`}
      <p id="workflow-step-help" class="quiet">Select a step to see what it does. Try this step finds its target without clicking or typing. Run from here skips earlier steps.</p>
      <section id="workflow-inputs" tabindex="-1"><h3>Inputs <span>· ${inputs.length}${inputs.length ? ", asked before each run" : ""}</span></h3>${inputs.length ? `<ul>${inputs.map((input) => `<li data-workflow-input="${esc(input.name)}"${input.name === (selected?.input || mustacheName(selected?.value) || mustacheName(selected?.label)) ? ` class="selected"` : ""}>${inputToken(input)}</li>`).join("")}</ul>` : `<p class="quiet">This workflow needs no inputs.</p>`}</section>
    </div></aside>
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
      <button type="button" role="menuitem" data-testid="share-guide"${exportEnabled ? "" : " disabled"}>Export guide</button>
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

export function workflowConflicts(versions: VersionRow[]): string {
  return versions.filter((version) => version.conflict).map((version) => `<section class="card">${conflictView(version)}</section>`).join("");
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
      ${version.conflict ? "" : versionChange(version)}
      ${actions}
    </li>`;
  }).join("");
  return `<section class="card" id="versions" data-testid="versions">
    <h3>Versions</h3>
    <p class="quiet">Replay uses the live version. A heal or an edit is a draft until you promote it.</p>
    <ol class="versions">${rows || `<li class="quiet">No versions yet.</li>`}</ol>
  </section>`;
}

const AGENT_SESSION_WORDS: Record<string, string> = {
  session_closed: "The Bao session ended before the owner wait completed. This session cannot continue.",
};

function isAgentBrowserSession(run: { workflowId?: string; pageEngine?: string; kind?: string }): boolean {
  return run.pageEngine === "agent-browser" || (run.workflowId === "agent-browser" && run.kind === "capture");
}

function sentence(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && /\s|[.!?]$/.test(text) ? text : undefined;
}

function openHost(value: string): string | undefined {
  try {
    const url = new URL(value.includes("://") || /^(about|file|data|chrome|javascript):/i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

function firstOpenHost(run: RunSummary): string | undefined {
  for (const step of run.steps || []) {
    if (step.native?.command !== "open") continue;
    for (const arg of step.native.args || []) {
      const host = openHost(arg);
      if (host) return host;
    }
  }
  return undefined;
}

function agentSessionTitle(run: RunSummary): string {
  const task = run.task?.trim();
  if (task) return task;
  return firstOpenHost(run) || "Browser session";
}

function agentOwnerWait(run: RunSummary): boolean {
  const status = run.envelope?.status || run.status;
  if (status === "needs_human" || status === "needs_signin") return true;
  if (["passed", "ok", "completed", "failed", "timed-out", "timeout", "stopped", "cancelled"].includes(run.status)) return false;
  return (run.steps || []).some((step) => step.native?.command === "wait_for_owner" && step.status !== "passed" && step.status !== "failed");
}

function agentSessionBlocked(run: RunSummary): boolean {
  if (!isAgentBrowserSession(run) || agentOwnerWait(run)) return false;
  const status = run.envelope?.status || run.status;
  return ["failed", "timed-out", "timeout", "stopped", "cancelled"].includes(run.status)
    || ["failed", "timed-out", "timeout", "stopped", "cancelled"].includes(status);
}

function plainAgentReason(run: RunSummary): string | undefined {
  if (!agentSessionBlocked(run)) return undefined;
  const reason = run.envelope?.reason?.trim();
  const ask = run.envelope?.ask?.trim();
  const failure = run.failure?.reason?.trim();
  const step = (run.steps || []).find((item) => item.status === "failed" && item.reason)?.reason?.trim();
  return sentence(reason) || sentence(ask) || sentence(failure) || sentence(step)
    || (reason ? AGENT_SESSION_WORDS[reason] : undefined)
    || (reason ? ownerStopText(reason) : undefined)
    || (failure ? ownerStopText(failure) : undefined);
}

export function runWorkflowName(run: RunSummary, workflows: WorkflowSummary[]): string {
  if (isAgentBrowserSession(run)) return agentSessionTitle(run);
  return workflows.find((workflow) => workflow.id === run.workflowId)?.name
    || (run.workflowId === "agent-browser" ? "Browser session" : run.kind === "capture" ? "Browser capture" : "Workflow unavailable");
}

function runTime(run: RunSummary): number | undefined {
  return typeof run.at === "number" && Number.isFinite(run.at) && !Number.isNaN(new Date(run.at).getTime()) ? run.at : undefined;
}

function runWaiting(run: RunSummary): boolean {
  return ["paused", "needs_human", "needs_signin"].includes(run.envelope?.status || run.status);
}

type RunAttentionItem =
  | { run: RunSummary; label: string; kind: "paused"; live?: boolean }
  | { run: RunSummary; label: string; kind: "healed"; healId: string; live?: never }
  | { run: RunSummary; label: string; kind: "failed"; live?: never };

export function runAttention(runs: RunSummary[], ask?: HumanAsk | null, activeRun?: ActiveRun | null): RunAttentionItem[] {
  const attention = [...runs].sort((a, b) => (runTime(b) ?? -Infinity) - (runTime(a) ?? -Infinity)).flatMap((run) => {
    const items: RunAttentionItem[] = [];
    const agent = isAgentBrowserSession(run);
    const waiting = run.id === activeRun?.id ? activeRun.phase === "waiting" : agent ? agentOwnerWait(run) : runWaiting(run);
    if (waiting) items.push({ run, label: "Needs you", kind: "paused" });
    if (agent) return items;
    const decided = new Set((run.decisions || []).map((decision) => decision.healId));
    for (const heal of run.heals || []) if (!decided.has(heal.id)) items.push({ run, label: "Heal to keep", kind: "healed", healId: heal.id });
    if (["failed", "timed-out", "timeout"].includes(run.status)) items.push({ run, label: run.status === "failed" ? "Failed" : "Timed out", kind: "failed" });
    return items;
  }).sort((a, b) => ["paused", "healed", "failed"].indexOf(a.kind) - ["paused", "healed", "failed"].indexOf(b.kind));
  if (ask && !attention.some((item) => item.kind === "paused" && item.run.id === ask.runId)) {
    attention.unshift({
      run: { id: ask.runId || "", workflowId: ask.workflowId, status: "paused", at: ask.startedAt, envelope: { status: "needs_human", ask: ask.instruction } },
      label: "Needs you", kind: "paused", live: true,
    });
  }
  return attention;
}

function runListKind(run: RunSummary): string {
  if (runWaiting(run)) return "paused";
  if (run.status === "timeout") return "timed-out";
  if (!["passed", "ok", "completed", "failed", "timed-out"].includes(run.status)) return run.status;
  return runKind(run);
}

export function runStatusGlyph(kind: string): string {
  const mark = kind === "paused" ? '<path d="M5.4 4.4v5.2M8.6 4.4v5.2"/>'
    : kind === "healed" ? '<path d="M7 3.9v6.2M3.9 7h6.2"/>'
    : ["failed", "timed-out"].includes(kind) ? '<path d="m4.6 4.6 4.8 4.8M9.4 4.6 4.6 9.4"/>'
    : kind === "passed" ? '<path d="m4 7.2 2 2 4-4.4"/>'
    : '<path d="M7 3.8V7l2.2 1.4"/>';
  if (kind === "warning") return `<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M6.13 1.5a1 1 0 0 1 1.74 0l5.6 9.95a1 1 0 0 1-.87 1.5H1.4a1 1 0 0 1-.87-1.5Z" fill="currentColor"/><path class="run-glyph-mark" d="M7 5v3.2"/><circle cx="7" cy="10.4" r=".9" fill="var(--glyph-mark)"/></svg>`;
  if (kind === "provisional") return `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 .8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor"/></svg>`;
  return `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="currentColor"/><g class="run-glyph-mark">${mark}</g></svg>`;
}

function runDuration(run: RunSummary): string {
  const start = run.steps?.[0]?.startedAt;
  const end = run.steps?.at(-1)?.endedAt;
  if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end)) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 0) return "";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
}

export function runWaitLeft(deadline: number, now = Date.now()): string {
  const remaining = Math.max(0, Math.ceil((deadline - now) / 60000));
  return Number.isFinite(remaining) ? `${remaining >= 60 ? `${Math.floor(remaining / 60)} h ` : ""}${remaining % 60} min left` : "";
}

export function runsList(runs: RunSummary[], workflows: WorkflowSummary[], selectedRun = "", now = Date.now(), ask?: HumanAsk | null, importPhase?: string, selection: { selectedHeal?: { runId: string; healId: string } | null; liveSelected?: boolean; promotions?: PromotionView[]; activeRun?: ActiveRun | null } = {}): string {
  const active = selection.activeRun;
  const attention = runAttention(runs, ask, active);
  const imports = attentionCount({ pendingHeals: 0, importPhase });
  const reviews = reviewItems(runs);
  const count = shellAttentionCount({ runs, activeAsk: ask, activeRun: active, pendingImport: { phase: importPhase } });
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  let selectionShown = false;
  const row = (run: RunSummary, attentionLabel?: string, kind = run.id === active?.id ? active.phase === "waiting" ? "paused" : "running" : runListKind(run), live = false, healId?: string) => {
    const selected = !selectionShown && (healId ? selection.selectedHeal?.runId === run.id && selection.selectedHeal.healId === healId : live ? selection.liveSelected : selectedRun === run.id);
    if (selected) selectionShown = true;
    const at = runTime(run);
    const name = names.get(run.workflowId) || (live ? ask?.workflowName : undefined) || runWorkflowName(run, []);
    const word = statusLabel(kind);
    const label = attentionLabel || word.charAt(0).toUpperCase() + word.slice(1);
    const when = at === undefined ? "Time unknown" : formatTime(at);
    const reason = run.id === active?.id && active.phase === "running" ? undefined : (runWaiting(run) ? run.envelope?.ask : undefined) || run.envelope?.reason || run.failure?.reason;
    const totalSteps = workflows.find((workflow) => workflow.id === run.workflowId)?.steps;
    const stoppedAt = run.failure?.index === undefined ? "" : `Stopped at step ${run.failure.index + 1}${attentionLabel ? "." : totalSteps ? ` of ${totalSteps}` : ""}`;
    const heal = run.heals?.find((item) => healId ? item.id === healId : !run.decisions?.some((decision) => decision.healId === item.id));
    const spoken = plainAgentReason(run);
    const detail = spoken || (kind === "paused" ? reason : kind === "failed" ? stoppedAt || reason : kind === "healed" && heal ? heal.failedStep?.index === undefined ? "Review the repair." : `Step ${heal.failedStep.index + 1} moved.` : reason || runDuration(run));
    const shown = spoken || (detail ? ownerStopText(detail) : "");
    const deadline = attentionLabel && kind === "paused" && ask && (live || ask.runId === run.id) ? ask.deadline : undefined;
    const promotion = healId ? selection.promotions?.find((item) => item.healId === healId && item.workflowId === run.workflowId) || (run.promotion?.healId === healId ? run.promotion : undefined) : undefined;
    const remaining = promotion?.status === "provisional" ? Math.max(0, (promotion.need ?? DEFAULT_PROMOTE_AFTER) - (promotion.replays ?? 0)) : 0;
    const extra = attentionLabel && kind === "failed" && stoppedAt ? reason : typeof deadline === "number" ? runWaitLeft(deadline, now) : attentionLabel && kind === "paused" && run.envelope?.deadline ? `Waits until ${run.envelope.deadline}` : remaining ? `Kept after ${remaining} more clean run${remaining === 1 ? "" : "s"}` : "";
    const description = `${label}${shown ? ` · ${shown}` : ""}`;
    return `<li><button type="button" class="run-row${attentionLabel ? " run-pinned" : ""}${selected ? " selected" : ""}" ${healId ? `data-heal="${esc(healId)}" data-run="${esc(run.id)}"` : live ? `data-open-run="${esc(run.id)}" data-screen="live"` : `data-open-run="${esc(run.id)}"`} aria-label="${esc(name)}" aria-description="${esc(description)} · ${esc(when)}"${selected ? ` aria-current="true"` : ""}>
      <span class="run-glyph ${esc(kind)}" aria-hidden="true">${runStatusGlyph(kind)}</span>
      <span class="run-name" title="${esc(name)}">${esc(name)}</span><time${at === undefined ? "" : ` title="${esc(formatClock(at))}"`}>${esc(when)}</time>
      <span class="run-meta"><span class="run-state ${esc(kind)}">${esc(label)}</span>${shown ? ` · ${esc(shown)}` : ""}</span>
      ${extra ? `<span class="run-extra"${typeof deadline === "number" ? ` data-run-deadline="${esc(deadline)}"` : ""}>${esc(ownerStopText(extra))}</span>` : ""}
    </button></li>`;
  };
  const day = (value: number) => new Date(value).toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, RunSummary[]>();
  const isCurrent = (run: RunSummary) => run.id === active?.id || runWaiting(run);
  const currentRuns = runs.filter(isCurrent).sort((a, b) => (runTime(b) ?? -Infinity) - (runTime(a) ?? -Infinity));
  for (const run of [...runs].filter((item) => !isCurrent(item)).sort((a, b) => (runTime(b) ?? -Infinity) - (runTime(a) ?? -Infinity))) {
    const at = runTime(run);
    const label = at === undefined ? "Date unknown" : day(at) === day(now) ? "Today" : day(at) === day(+yesterday) ? "Yesterday" : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric", ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) }).format(at);
    const entries = groups.get(label);
    if (entries) entries.push(run);
    else groups.set(label, [run]);
  }
  return `<div id="runs" class="runs-list" tabindex="0" aria-label="Run history, newest first">
    <section aria-labelledby="needs-you-heading"><h2 id="needs-you-heading" class="run-group-heading">Needs you <span class="run-count" aria-label="${count} items">${count}</span></h2>
      ${count ? `<ul aria-label="Needs you">${attention.map((item) => row(item.run, item.label, item.kind, item.live, item.kind === "healed" ? item.healId : undefined)).join("")}${imports ? `<li><button type="button" class="run-row" data-screen="logins"><span class="run-glyph paused" aria-hidden="true">${runStatusGlyph("paused")}</span><span class="run-name">Sign-in needs you</span><span class="run-meta">Review the login import</span></button></li>` : ""}${reviews.map((review) => `<li><button type="button" class="run-row" data-screen="library"><span class="run-glyph warning" aria-hidden="true">${runStatusGlyph("warning")}</span><span class="run-name">${esc(review.label)}</span><span class="run-meta">Step needs review after ${review.streak} heals</span></button></li>`).join("")}</ul>` : `<p class="run-list-note">Nothing needs you.</p>`}</section>
    ${currentRuns.length ? `<section aria-label="Now"><h2 class="run-group-heading">Now</h2><ul>${currentRuns.map((run) => row(run)).join("")}</ul></section>` : ""}
    ${groups.size ? [...groups].map(([label, entries]) => `<section aria-label="${esc(label)}"><h2 class="run-group-heading">${esc(label)}</h2><ul>${entries.map((run) => row(run)).join("")}</ul></section>`).join("") : !runs.length ? `<h2 class="run-group-heading">History</h2><p class="run-list-note"><strong>No runs yet</strong><br>When Bao runs a workflow, it shows up here, newest first.</p>` : ""}
  </div>`;
}

export function runsWelcome(hasRuns: boolean): string {
  return `<section id="runs-welcome"><h2>Runs</h2>${hasRuns ? `<h3>Every run leaves a receipt.</h3><p>Select a run to see what happened, what needs you, and the steps Bao took.</p>` : `<h3>Record a task once.</h3><p>Run a saved workflow to see its receipt here. Bao keeps runs that need you above your history.</p><button type="button" data-screen="library">Open Workflows</button>`}</section>`;
}

export function connectionError(): string {
  return `<section id="connection-error" class="connection-card" aria-labelledby="connection-heading"><h2 id="connection-heading">Can’t connect to Bao</h2><p role="alert">Bao couldn’t load this Mac’s runs and workflows.</p><p>Check that Bao is running, then try again. Your saved work stays on this Mac.</p><button id="retry-state" type="button">Retry</button></section>`;
}

export function receiptError(): string {
  return `<section class="connection-card"><h2>Can’t open this receipt</h2><p role="alert">Bao couldn’t load the receipt summary. Try again, choose another run, or open any detailed evidence below.</p><button id="retry-run" type="button">Retry</button></section>`;
}

export function runReceipt(view: ReturnType<typeof inspectRunView>, name: string, run: RunSummary): string {
  const kind = runListKind(run);
  const at = view.run.at === null ? "Time unknown" : formatWhen(view.run.at);
  const calls = view.run.modelCalls;
  const spoken = plainAgentReason(run);
  const ask = spoken ? undefined : view.handoff?.ask || run.envelope?.ask;
  return `<section id="run-receipt" aria-label="Run receipt"><p class="receipt-kicker"><span class="run-state ${esc(kind)}">${esc(statusLabel(kind))}</span> · ${esc(at)}</p><h2>${esc(name)}</h2>
    <p class="receipt-meta">${view.run.stepCount} step${view.run.stepCount === 1 ? "" : "s"}${calls === null ? "" : ` · ${calls} model call${calls === 1 ? "" : "s"}`}</p>
    ${spoken ? `<p class="receipt-reason">${esc(spoken)}</p>` : ask ? runWaiting(run) ? `<aside class="receipt-handoff"><h3>Needs you</h3><p>${esc(ownerStopText(ask))}</p>${view.handoff?.deadline ? `<p>Deadline: ${esc(view.handoff.deadline)}</p>` : ""}</aside>` : `<h3>${esc(statusLabel(kind))}</h3><p class="receipt-reason">${esc(ownerStopText(ask))}</p>` : ""}
    ${spoken ? "" : view.reason || run.failure?.reason ? `<p class="receipt-reason">${esc(ownerStopText(view.reason || run.failure?.reason || ""))}</p>` : ""}
    ${pendingHealCount([run]) ? `<p>A target change is ready to review.</p><button type="button" data-screen="heals">Review heals</button>` : ""}
    <h3 id="receipt-step-heading" class="section" tabindex="-1">Step results</h3><ol class="receipt-steps" start="${view.stepOffset + 1}">${view.steps.map((step) => `<li><div><strong>${esc(step.label || "Step")}</strong><span class="run-state">${esc(step.status)}</span></div>${step.reason || step.result ? `<p>${esc(ownerStopText(step.reason || step.result || ""))}</p>` : ""}</li>`).join("")}</ol>
    ${view.steps.length ? "" : `<p class="quiet">No step results recorded.</p>`}
    <div class="receipt-pages">${view.stepOffset ? `<button type="button" data-receipt-offset="${Math.max(0, view.stepOffset - 20)}">Previous steps</button>` : ""}${view.nextStepOffset === null ? "" : `<button type="button" data-receipt-offset="${view.nextStepOffset}">Next steps</button>`}</div>
  </section>`;
}

export function commandItems(workflows: { id: string; name: string }[]): CommandItem[] {
  const screens: CommandItem[] = [
    ...Object.entries(shellScreens).map(([id, item]) => ({ id, label: item.label, kind: "screen" as const, screen: id, hint: "Go" })),
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
  noteAsIntent?: boolean;
  action: string;
  values: { role: string; name: string; label: string }[];
  /** Source event time. */
  at?: number;
  /** When this step first appeared in the narration. */
  shownAt?: number;
}

export interface TeachView {
  phase?: "idle" | "live" | "review";
  paused?: boolean;
  since?: number;
  narrator?: string;
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
      <input id="teach-note" class="note-field" aria-label="Note" placeholder="Note">
      <button type="button" id="teach-note-add">Note</button>
      <button type="button" id="teach-pause">${paused}</button>
      <button type="button" id="teach-stop">Stop</button>
      <button type="button" id="teach-check">Add check</button>
      <button type="button" id="teach-discard">Discard</button>
    </div>
    <div id="teach-cards">${list || `<p class="meta">Steps show up here as you demonstrate. Click a step to correct it.</p>`}</div>
  </section>`;
}

export function teachCard(card: TeachCardView, opts: { edit?: boolean; on?: boolean; edited?: string } = {}): string {
  const who = card.narrator === "model" ? `model${card.modelName ? ` · ${card.modelName}` : ""}` : "heuristic";
  const chip = card.values[0] ? valueChip(card.values[0]) : "";
  const flags = [
    card.values.some((value) => value.role === "input") ? `<span class="badge flag" data-flag="input">input</span>` : "",
    card.values.some((value) => value.role === "secret") ? `<span class="badge flag" data-flag="secret">secret</span>` : "",
    card.human ? `<span class="badge you" data-flag="human">you</span>` : "",
    card.verify ? `<span class="badge expect">check</span>` : "",
    card.note ? `<span class="badge note">note</span>` : "",
  ].join("");
  const used = card.noteAsIntent ? `<span class="note-as-intent" data-note-intent>note used as intent</span>` : "";
  const noted = card.note ? `<span class="note-read">${esc(card.note)}</span>` : "";
  const row = `<span class="thumb mini" data-shot="${esc(captureShot(card.id))}">${cropPlaceholder(card.action)}</span>
      <span class="intent-read">${esc(card.intent)}</span>
      ${noted}${used}${chip}${flags}${opts.edited || ""}`;
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
      ${used}
      <label>Note <input class="note" data-note value="${esc(card.note)}" placeholder="Note" aria-label="Note"></label>
    </div>` : "";
  const classes = ["step-card", "teach-card", card.human ? "human" : "", opts.on ? "on" : ""].filter(Boolean).join(" ");
  const at = typeof card.at === "number" ? String(card.at) : "";
  const shown = typeof card.shownAt === "number" ? String(card.shownAt) : "";
  return `<article class="${classes}" data-card="${esc(card.id)}" data-narrator="${esc(card.narrator)}" data-at="${esc(at)}" data-shown="${esc(shown)}" data-input="${card.values.some((value) => value.role === "input") ? "1" : "0"}" data-secret="${card.values.some((value) => value.role === "secret") ? "1" : "0"}" data-human="${card.human ? "1" : "0"}">
    ${head}
    ${editor}
  </article>`;
}

export function teachReview(teach: TeachView): string {
  const review = teach.review;
  if (!review) return `<section id="teach-review"><h2>Review</h2><p class="quiet">Stop teaching to review the workflow.</p></section>`;
  const raw = review.raw.map((event) => {
    const label = event.kind === "decision" ? `decision · ${event.detail || event.op}` : `${event.op || event.kind}`;
    const why = event.reason ? ` - ${ownerStopMessage(event.reason)}` : "";
    return `<li data-event="${esc(event.id || "")}">${esc(label + why)}</li>`;
  }).join("");
  const summary = review.summary;
  const dropped = summary?.dropped || [];
  const summaryHtml = summary
    ? `<p id="teach-summary">${esc(summary.line)}</p>${dropped.length ? `<ul id="teach-dropped-reasons">${dropped.map((item) => `<li data-event="${esc(item.id)}">${esc(item.id)} - ${esc(ownerStopMessage(item.reason))}</li>`).join("")}</ul>` : ""}`
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
      <label>Start URL <input id="teach-url" value="${esc(fixtureStartValue())}"></label>
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

export function saveSheetView(sheet: SaveSheet): string {
  const poster = sheet.poster ? "/api/capture/poster" : "";
  return `<section id="save-sheet" data-id="${esc(sheet.id)}" role="dialog" aria-labelledby="save-sheet-title">
    <form id="save-sheet-form">
      <h2 id="save-sheet-title">Save workflow</h2>
      <p class="quiet">Edit the name before Bao stores it. The summary is one line. Intent is what you were trying to do.</p>
      <label>Title <input id="save-title" name="title" value="${htmlEsc(sheet.name)}" required></label>
      <label>Summary <input id="save-summary" name="summary" value="${htmlEsc(sheet.summary || "")}" placeholder="One line about what this does"></label>
      <label>Intent <textarea id="save-intent" name="intent" rows="3">${htmlEsc(sheet.intent || "")}</textarea></label>
      ${poster ? `<div class="thumb" data-shot="${poster}">${placeholder("navigate", sheet.name)}</div>` : ""}
      <p id="save-error" class="quiet" hidden></p>
      <div class="row">
        <button class="primary" id="save-commit" type="submit">Save</button>
        <button type="button" id="save-discard">Discard</button>
      </div>
    </form>
  </section>`;
}

export function captureView(state: ShellState, draft: { name: string; startUrl: string; error: string; busy: boolean; picking: boolean }): string {
  const teachPending = Boolean(state.teach && state.teach.phase !== "idle");
  const recording = Boolean(state.recording) && !teachPending;
  const teachButton = `<button type="button" id="open-teach"${draft.busy ? " disabled" : ""}>Teach</button>`;
  const ids = (state.trails || []).map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
  const opening = state.capture?.url || draft.startUrl;
  let host = "";
  try { host = new URL(opening).hostname; } catch { /* Relative fixture URLs have no site name. */ }
  return `<section id="capture-panel" aria-label="Bao, ${recording ? "recording" : "capture setup"}" aria-busy="${draft.busy}">
    <header class="cap-bar">${!recording ? `<button type="button" class="cap-back" data-screen="library" aria-label="Back to Workflows">${icon("back")}</button>` : ""}<div><h2>${recording ? "Recording" : "Capture"}</h2><p>${recording ? state.capturePaused ? "Paused. Nothing you do now is recorded." : "Steps appear as you go" : "Record a task in Bao’s Chrome"}</p></div>${teachPending ? teachButton : ""}</header>
    <div class="cap-body">
      <div class="namefield"><label for="cap-name">Name</label><input id="cap-name" value="${esc(draft.name)}" placeholder="Name this workflow"${draft.busy ? " disabled" : ""}></div>
      ${recording ? `<p class="cap-where">${icon("globe")}<span>${state.capturePaused ? "Paused" : "Recording"} in Bao’s Chrome${host ? ` · ${esc(host)}` : ""}</span></p><div id="live-steps">${captureStream(state, draft.picking)}</div>` : `<div class="namefield"><label for="start-url">Start URL</label><input id="start-url" value="${esc(draft.startUrl)}"${draft.busy ? " disabled" : ""}></div><p class="cap-setup-note">Nothing is recorded until you start. Bao opens its own Chrome window.</p>`}
      ${state.teach?.phase === "review" ? `<p class="cap-setup-note">Save or discard your pending Teach review before starting a capture.</p>` : ""}
      ${!recording ? `<div class="card">
        <h3>Mac app</h3>
        <p>On macOS the helper is <code>Bao.app/Contents/Resources/BaoOSHelper.app</code> (bundle <code>dev.bao.oshelper</code>). On Linux the AT-SPI helper is <code>bao-os-helper</code>.</p>
      </div>
      <div class="card">
        <h3>Agent and MCP</h3>
        <p>Connect an agent with <code>bao mcp</code>. Use <code>agent_browser</code> to drive Chrome. Watch its commands and screenshots in Runs. Supported single-page tasks save replayable workflows when the session ends. Other sessions stay in Runs with a reason.</p>
      </div>
      <div class="card" id="trail-tab">
        <h3>Trail</h3>
        <p class="quiet">Trail is the evidence for a capture, not a place in the sidebar.</p>
        <label>Trail <select id="trail-id">${ids}</select></label>
        <button id="load-trail" type="button">Load</button>
        <div id="trail-view">Typed values are saved in the local Library for replay.</div>
      </div>` : ""}
      <p id="capture-error" role="alert"${draft.error ? "" : " hidden"}>${esc(draft.error)}</p>
    </div>
    <footer class="cap-foot">${recording ? `<p>${icon("lock")}<span>Typed values are saved for replay.</span></p><button type="button" id="capture-discard"${draft.busy ? " disabled" : ""}>Discard…</button><button type="button" class="primary" id="stop"${draft.busy ? " disabled" : ""}>${draft.busy ? "Saving…" : "Stop and save"}</button>` : !teachPending ? `${teachButton}<button type="button" class="primary" id="start"${draft.busy ? " disabled" : ""}>${draft.busy ? "Starting…" : "Start capture"}</button>` : state.teach?.phase === "review" ? `<button type="button" id="capture-teach-discard"${draft.busy ? " disabled" : ""}>Discard Teach review</button>` : ""}</footer>
  </section>`;
}

export function captureStream(state: ShellState, picking = false): string {
  const steps = state.capture?.stream || [];
  const rows = steps.map((step, index) => {
    const kind = step.op === "navigate" || /^(Open|Navigate)/i.test(step.label) ? "globe" : /^(type|input)$/.test(step.op || "") || /^Type/i.test(step.label) ? "type" : /^Wait/i.test(step.label) ? "person" : step.op === "extract" || /^(Extract|Read table)/i.test(step.label) ? "table" : "click";
    const field = kind === "type" ? step.field || (step.sensitive ? "Password" : "") : "";
    const label = field ? `Type the ${field.charAt(0).toLowerCase()}${field.slice(1)}` : step.label;
    const newest = index === steps.length - 1 && Boolean(step.ts && Date.now() - step.ts < 15_000);
    const detail = field ? `<div class="sub"><span class="cap-token">${step.sensitive ? icon("lock") : ""}${esc(field)}</span>${step.sensitive ? `<span class="mask" aria-label="hidden">••••••••</span><span>Saved in your local Library.</span>` : ""}</div>` : "";
    return `<li${newest ? ` class="new"` : ""}><span class="no">${index + 1}</span>${icon(kind)}<div><span class="lab">${esc(label)}</span>${detail}</div>${newest ? `<span class="just">Just now</span>` : ""}</li>`;
  }).join("");
  const waiting = state.capturePaused ? "Recording is paused" : picking ? "Pick list is on" : "Ready for your next step";
  const hint = state.capturePaused ? "Resume when you’re ready to keep recording." : picking ? "Click the table you want in Chrome" : "Keep going in Bao’s Chrome";
  return `<ol class="stream" aria-label="Recorded steps" aria-live="polite" aria-relevant="additions text">${rows}<li class="wait"><span class="no">${steps.length + 1}</span>${icon(picking ? "table" : "record")}<div><span class="lab">${waiting}</span><div class="sub">${hint}${state.capturePaused ? "" : `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`}</div></div></li></ol>`;
}

export function recordBar(state: ShellState, capture = false, picking = false): string {
  if (!state.recording || (state.teach && state.teach.phase !== "idle")) return "";
  const paused = state.capturePaused ? "Resume" : "Pause";
  if (capture) return `<div id="record-bar" class="capture-controls" role="toolbar" aria-label="Recording controls" data-paused="${Boolean(state.capturePaused)}"><span class="rec"><i class="rec-dot" aria-hidden="true"></i><span id="rec-timer" data-since="${state.recordingSince || 0}">0:00</span><span id="rec-steps">${state.capture?.steps.length || 0} steps</span></span><span class="cap-divider" aria-hidden="true"></span><button type="button" id="rec-pause">${icon(state.capturePaused ? "play" : "pause")}${paused}</button><button type="button" id="rec-extract" aria-pressed="${picking}">${icon("table")}Pick list</button><span class="cap-divider" aria-hidden="true"></span><button type="button" class="stop" id="rec-stop">${icon("stop")}Stop and save</button></div>`;
  return `<div id="record-bar" data-paused="${state.capturePaused ? "true" : "false"}">
    <span class="rec-dot" aria-hidden="true"></span>
    <span id="rec-timer" data-since="${state.recordingSince || 0}">0:00</span>
    <input id="rec-note" class="note-field" aria-label="Note" placeholder="Note">
    <button type="button" id="rec-note-add">Note</button>
    <button type="button" id="rec-extract">Pick list</button>
    <button type="button" id="rec-pause">${paused}</button>
    <button type="button" id="rec-mark">Mark step</button>
    <button type="button" id="rec-stop">Stop</button>
  </div>`;
}

export interface GuideView {
  workflowId: string;
  runId: string;
  status: "highlight" | "passed" | "stopped" | "timeout";
  actions: number;
  index: number;
  total: number;
  stepId: string;
  intent: string;
}

export function guidePanel(guide: GuideView): string {
  const place = guide.total ? `Step ${guide.index + 1} of ${guide.total}` : "";
  const word = guide.status === "highlight" ? "Do this on the page. The target is highlighted." : guide.status === "passed" ? "You finished every step." : guide.status;
  return `<section id="guide-panel" data-status="${esc(guide.status)}" data-actions="${guide.actions}" data-step="${esc(guide.stepId)}">
    <header class="guide-head">
      <h2>Guide me</h2>
      <p id="guide-actions">${guide.actions} automated actions</p>
    </header>
    <p class="intent" id="guide-step">${esc(guide.intent)}</p>
    <p class="meta">${esc(place)}</p>
    <p class="quiet">${esc(word)}</p>
  </section>`;
}

export function liveStepList(events: { id?: string; op?: string; kind?: string }[]): string {
  if (!events.length) return `<p class="meta" id="live-steps-empty">Steps show up here as you record.</p>`;
  return `<ol id="live-step-list">${events.map((event, index) => {
    const shot = event.id ? `/api/capture/shots/${encodeURIComponent(event.id)}.png` : "";
    const label = event.op || event.kind || "step";
    return `<li class="live-step"><div class="thumb mini" ${shot ? `data-shot="${esc(shot)}"` : ""}>${placeholder(event.op, label)}</div><span><span class="meta">${index + 1}</span> ${esc(label)}</span></li>`;
  }).join("")}</ol>`;
}
