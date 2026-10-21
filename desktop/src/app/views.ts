// HTML for the desktop window. The browser script fills these strings in.
// No network, no DOM.

import { importErrorView } from "./import-error";
import type { ImportLoginError } from "../v1/import-login-error";
import { attentionCount, formatWait, pendingHealCount, type HumanAsk } from "../v1/human-ask";
import type { IdentityView, StepView } from "./view-types";

export interface WorkflowSummary {
  id: string;
  name: string;
  steps: number;
  waits?: number;
  heal?: string;
  replayed?: boolean;
  inputs?: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean }[];
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
}

export interface FailureView {
  stepId?: string;
  index?: number;
  intent?: string;
  reason?: string;
  brokenAttr?: string;
  identity?: IdentityView;
  beforeShot?: string;
  snapshot?: { screenshot?: string };
}

export interface HealView {
  id: string;
  ts?: number;
  mode?: string;
  intent?: string;
  prompt?: string;
  rawResponse?: string;
  model?: { name?: string; version?: string; provider?: string };
  proposedPatch?: { identity?: { name?: string; text?: string; testId?: string; id?: string; role?: string }; label?: string };
  failedStep?: { id?: string; label?: string; action?: string; identity?: { name?: string; text?: string; testId?: string; id?: string; role?: string } };
  postconditionPassed?: boolean;
  snapshot?: { screenshot?: string };
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
  helper?: { label: string };
  model?: { label: string };
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
  activeAsk?: HumanAsk | null;
  pendingImport?: ImportPending | null;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

function png(b64: string | undefined): string {
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return "";
  return `data:image/png;base64,${b64}`;
}

export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[secret]");
  }
  return out;
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
      <button data-screen="library">Library</button>
      <button data-screen="capture">Capture</button>
      <button data-screen="runs">Runs</button>
      <button data-screen="heals">Heals ${healBadge}</button>
      <button data-screen="settings">Settings</button>
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

export function runViewer(run: RunSummary, workflow: { name: string; steps: { id: string; label?: string; action?: string; index?: number }[] }, selectedId?: string): string {
  const steps = (run.steps || []).map((step) => ({
    ...step,
    label: stepLabel(step, workflow.steps),
    action: step.action || workflow.steps.find((item) => item.id === step.id)?.action,
  }));
  const failed = steps.find((step) => step.status === "failed" || step.status === "paused");
  const selected = steps.find((step) => step.id === selectedId) || failed || steps[steps.length - 1];
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
  const before = png(selected?.beforeShot || (failure && failure.stepId === selected?.id ? failure.beforeShot : undefined));
  const after = png(selected?.afterShot || (failure && failure.stepId === selected?.id ? failure.snapshot?.screenshot : undefined));
  const shot = shotPane(before, after);
  const table = identityTable(identity);
  const video = videoBar(run, steps);
  const safeHeadline = failed ? esc(headline) : headline;
  return `<section id="run-viewer" data-run="${esc(run.id)}" data-status="${esc(run.status)}">
    <header class="run-head">
      <h2>${esc(workflow.name)} · ${esc(run.id)}</h2>
      <p class="${esc(run.status)}" id="run-status"><strong>${esc(statusWord)}</strong> ${failed ? `at step ${stopped}` : ""} ${badge}</p>
    </header>
    <div class="why" id="why-stopped"><p>${safeHeadline}</p>${failed ? `<p class="quiet">Nothing after step ${Math.max(0, stopped - 1)} ran.</p>` : ""}</div>
    <div class="bar" id="step-bar" data-steps="${steps.length}" aria-label="${passed}/${steps.length}">${segs}<span class="bar-count">${passed}/${steps.length}</span></div>
    <div class="split">
      <div class="step-list" id="step-list">${list}</div>
      <div class="step-detail" id="step-detail">
        <div class="row"><strong>${esc(selected?.label || "")}</strong></div>
        ${shot}
        ${table}
        <p class="quiet">${identity ? `Postcondition ${selected?.status === "passed" ? "reached" : "not reached"}` : ""}</p>
      </div>
    </div>
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

function shotPane(before: string, after: string): string {
  if (!before && !after) return `<p class="quiet">No screenshot for this step.</p>`;
  const current = after || before;
  return `<div class="shots" id="shots">
    <div class="row">
      <button type="button" data-shot="before" ${before ? "" : "disabled"}>Before</button>
      <button type="button" data-shot="after" ${after ? "" : "disabled"}>After</button>
    </div>
    <img id="step-shot" alt="Step screenshot" src="${current}" data-before="${before}" data-after="${after}">
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
  if (timed.length === 0) return `<p class="quiet" id="video-bar">No per-step timestamps on this run.</p>`;
  const origin = run.videoStartedAt || timed[0]!.startedAt || 0;
  const end = Math.max(...steps.map((step) => step.endedAt || step.startedAt || origin));
  const span = Math.max(1, end - origin);
  const markers = timed.map((step, index) => {
    const at = ((step.startedAt! - origin) / span) * 100;
    const mark = step.status === "failed" ? "✗" : String(index + 1);
    return `<button type="button" class="marker ${esc(step.status)}" data-marker="${esc(step.id)}" data-at="${step.startedAt}" style="left:${at}%">${mark}</button>`;
  }).join("");
  const src = run.video ? `/api/runs/${encodeURIComponent(run.id)}/video` : "";
  const media = src
    ? `<video id="run-video" src="${esc(src)}" controls preload="metadata"></video>`
    : `<p class="quiet">Step timing. No screen recording was saved for this run.</p>`;
  return `<div id="video-bar" data-origin="${origin}">
    ${media}
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
        workflow: names.get(run.workflowId) || run.workflowId,
        step: heal.failedStep?.label || heal.intent || heal.failedStep?.id || "step",
        when: heal.ts ? new Date(heal.ts).toISOString() : "",
      });
    }
  }
  return rows;
}

export function healDetail(run: RunSummary, heal: HealView, secrets: string[] = []): string {
  const recorded = heal.failedStep?.identity;
  const proposed = heal.proposedPatch?.identity;
  const before = png(heal.beforeShot);
  const after = png(heal.snapshot?.screenshot);
  const slider = before && after
    ? `<div class="compare" id="shot-compare">
        <img alt="Recorded page" src="${before}">
        <img id="compare-top" alt="Page at failure" src="${after}" style="clip-path: inset(0 50% 0 0)">
        <input id="shot-slider" type="range" min="0" max="100" value="50" aria-label="Screenshot comparison">
      </div>`
    : after
      ? `<img alt="Page at failure" src="${after}">`
      : `<p class="quiet">No screenshots on this heal.</p>`;
  const prompt = maskSecrets(heal.prompt || "", secrets);
  const raw = maskSecrets(heal.rawResponse || "", secrets);
  const candidates = heal.identity?.candidates?.map((candidate, index) =>
    `#${index + 1} ${esc(candidate.label)} ${candidate.score}`).join("  ") || "No other candidates stored on this record.";
  const post = heal.postconditionPassed === undefined ? "not run" : heal.postconditionPassed ? "passed" : "failed";
  const decisions = (run.decisions || []).filter((item) => item.healId === heal.id);
  const decisionLine = decisions.map((item) => `${item.decision} at ${item.ts}`).join(", ");
  const model = heal.model ? `${heal.model.name || ""} ${heal.model.version || ""}`.trim() : "no model";
  return `<article id="heal-detail" data-heal="${esc(heal.id)}" data-run="${esc(run.id)}">
    <header class="row"><h3>${esc(heal.intent || heal.failedStep?.label || "Heal")}</h3><span class="quiet">${esc(heal.mode || "")} · ${esc(model)}</span></header>
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
      <button type="button" data-keep="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}">Keep</button>
      <button type="button" data-revert="${esc(heal.id)}" data-run="${esc(run.id)}" data-workflow="${esc(run.workflowId)}">Revert</button>
    </div>
    <p class="quiet">Keep writes the patch into the saved workflow. Revert puts the failed step back. Both are appended. ${esc(decisionLine)}</p>
  </article>`;
}

export function libraryTable(workflows: WorkflowSummary[], runs: RunSummary[]): string {
  const latest = new Map<string, RunSummary>();
  for (const run of runs) {
    const prev = latest.get(run.workflowId);
    if (!prev || (run.at || 0) >= (prev.at || 0)) latest.set(run.workflowId, run);
  }
  const rows = workflows.map((workflow) => {
    const run = latest.get(workflow.id);
    const calls = run ? (run.modelCalls ?? (run.heals || []).filter((heal) => heal.model).length) : 0;
    const last = !run ? "never" : run.status === "passed" ? "passed" : run.status === "paused" ? "waiting" : "refused";
    const bolt = run && calls === 0 && run.status === "passed" ? `<span class="badge quiet-badge" title="no model calls">0 model calls</span>` : "";
    const healN = (run?.heals || []).length;
    const decided = new Set((run?.decisions || []).map((item) => item.healId));
    const pending = (run?.heals || []).filter((heal) => heal.id && !decided.has(heal.id)).length;
    const heals = healN === 0 ? "—" : pending ? `${pending} pending` : `${healN} kept or open`;
    const waits = workflow.waits ? `<span class="quiet" title="steps that wait for you"> ${workflow.waits} wait</span>` : "";
    return `<tr>
      <td><button type="button" class="link" data-open-workflow="${esc(workflow.id)}">${esc(workflow.name)}</button>${waits}</td>
      <td>${workflow.steps}</td>
      <td>${esc(last)} ${bolt}</td>
      <td>${esc(heals)}</td>
      <td><button type="button" data-screen="replay" data-workflow="${esc(workflow.id)}">Run</button></td>
    </tr>`;
  }).join("");
  return `<section id="library">
    <header class="row"><h2>Library</h2></header>
    <table class="grid">
      <thead><tr><th>Name</th><th>Steps</th><th>Last run</th><th>Heals</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5">No workflows yet.</td></tr>`}</tbody>
    </table>
    <div id="library-extra"></div>
  </section>`;
}

export function notices(items: { title?: string; body?: string }[]): string {
  return items.map((item) => `<div class="notice"><strong>${esc(item.title)}</strong><div>${esc(item.body)}</div></div>`).join("");
}
