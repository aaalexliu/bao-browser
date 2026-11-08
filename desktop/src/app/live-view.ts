import { AUDIT_PAGE_SIZE, auditPage, liveShotUrl, type LiveSessionRecord } from "../cdp-live/live-record";
import { ownerStopMessage, ownerStopText } from "../v1/stop-copy";
import { formatTime } from "../v1/time";
import { stepInputName, stepTitle, type WorkflowV2 } from "../v1/schema";
import { imageRef, runStatusGlyph, runWaitLeft, type ActiveRun, type RunSummary } from "./views";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

function trustedWord(value: boolean | null, via: string): string {
  if (via === "ax") return "AX press";
  if (value === true) return "trusted";
  if (value === false) return "untrusted";
  return "—";
}

export function screenFromQuery(search: string): "live" | "" {
  return new URLSearchParams(search).get("screen") === "live" ? "live" : "";
}

/** `?screen=live&page=0` selects an audit window. An absent page lets the view choose. */
export function livePageFromQuery(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("page");
  if (raw == null || raw === "") return undefined;
  const page = Number(raw);
  return Number.isFinite(page) ? Math.floor(page) : undefined;
}

/** The capture trail paints #live-steps only on the capture screen. The live screen owns that list. */
export function captureTrailOwnsSteps(screen: string): boolean {
  return screen === "capture";
}

const clockIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>`;
const openIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 2.5h4.5V7M13 3 7 9M6 4H3v9h9v-3"/></svg>`;
const chevron = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>`;

export function liveRunView(active: ActiveRun, run?: RunSummary | null, workflow?: WorkflowV2 | null, now = Date.now()): string {
  const ask = active.ask;
  const continuing = active.phase === "running";
  const unsaved = !run && continuing && !ask;
  const name = ask?.workflowName || workflow?.name || "Running workflow";
  const steps = workflow?.steps || [];
  const results = new Map((run?.steps || []).map((step) => [step.id, step]));
  const stepStatus = (id: string): string => {
    const status = results.get(id)?.status || "pending";
    return continuing ? status === "paused" ? "continuing" : status : id === ask?.stepId ? "paused" : status;
  };
  const progress = steps.map((step, i) => {
    const result = results.get(step.id);
    const current = !continuing && step.id === ask?.stepId;
    const status = stepStatus(step.id);
    const word = status === "passed" ? "Done" : current ? "Needs you" : status === "pending" ? "Not yet" : status === "continuing" ? "Handoff ended" : status;
    const label = current && ask?.kind === "confirm" ? `Wait for you: press ${ask.button || "the button"}` : stepTitle(step);
    const named = stepInputName(step);
    const input = named ? run?.inputs?.[named] : undefined;
    const ms = result?.startedAt != null && result.endedAt != null ? result.endedAt - result.startedAt : undefined;
    const meta = current ? "" : input || (ms != null ? `${Number((ms / 1000).toFixed(1))} s` : "");
    const glyph = status === "pending" || status === "skipped" ? `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/></svg>` : runStatusGlyph(status);
    return `<li data-status="${status}"${current ? ' aria-current="step"' : ""}><span class="run-glyph ${status}">${glyph}</span><span class="live-no">${i + 1}</span><span class="live-label" title="${esc(label)}">${esc(label)}<span class="sr-only">, ${esc(word)}</span></span><span class="live-meta">${esc(meta)}</span></li>`;
  }).join("");
  const shots = steps.flatMap((step, index) => {
    const result = results.get(step.id);
    const src = imageRef(run?.id || "", result?.afterShot || result?.beforeShot);
    return src ? [{ src, index, label: stepTitle(step), status: stepStatus(step.id) }] : [];
  });
  const latest = shots.at(-1);
  const startedAt = run?.steps?.find((step) => step.startedAt != null)?.startedAt ?? run?.at ?? active.startedAt;
  const inputs = Object.entries(run?.inputs || {});
  let location = ask?.site || "";
  try { if (workflow?.startUrl) { const url = new URL(workflow.startUrl); location = url.host + url.pathname; } } catch { /* Keep the ask's site if the workflow has no web URL. */ }
  const deadline = ask?.deadline ? `<span>Bao waits until ${esc(formatTime(ask.deadline))} · <b id="live-wait-left">${esc(runWaitLeft(ask.deadline, now))}</b></span><span class="live-meter" aria-hidden="true"><i style="width:${ask.timeoutMs > 0 ? Math.min(100, Math.max(0, (ask.deadline - now) / ask.timeoutMs * 100)) : 0}%"></i></span>` : `<span>Bao waits for you · no timeout</span>`;
  const lead = unsaved ? "This run is running." : continuing ? "Bao is working through the remaining steps." : ask?.kind === "confirm" ? `Waiting for you to press ${ask.button || "the button"}.` : ownerStopText(ask?.instruction || "");
  const continueLabel = ask?.kind === "confirm" ? `I pressed ${ask.button || "the button"}` : ask?.kind === "login" ? "I’m signed in, continue" : "Continue";
  const currentShot = latest ? `<img src="${esc(latest.src)}" alt="Latest screen from Bao’s Chrome: ${esc(latest.label)}">` : `<p class="live-no-shot">${unsaved ? "Screens appear when the run pauses or ends." : "No screen captured yet."}</p>`;
  return `<section id="live-run" data-run="${esc(active.id)}" data-step="${esc(`${active.id}:${ask?.stepId ?? ""}:${ask?.startedAt ?? ""}`)}" aria-label="Run: ${esc(name)}">
    <p class="live-kicker"><span class="live-state run-glyph ${continuing ? "continuing" : "paused"}">${runStatusGlyph(continuing ? "continuing" : "paused")} ${continuing ? "Running" : "Needs you"}</span>${startedAt != null ? `<span class="live-dot"></span><span>Started ${esc(formatTime(startedAt))}</span>` : ""}${ask ? `<span class="live-dot"></span><span>${continuing ? "Last paused at" : "Paused at"} ${esc(formatTime(ask.startedAt))}</span>` : ""}</p>
    <h1>${esc(name)}</h1><p class="live-lead">${esc(lead)}</p>
    <div class="live-deadline"${continuing ? " hidden" : ""} role="timer" aria-live="off" data-deadline="${ask?.deadline || ""}" data-timeout="${ask?.timeoutMs || 0}">${clockIcon}${deadline}</div>
    <div class="live-actions"><button id="act-show" class="primary" type="button">${openIcon}Show Bao’s Chrome</button>${unsaved ? "" : `<button id="act-continue" type="button"${continuing ? " disabled" : ""}>${continuing ? "Continuing" : esc(continueLabel)}</button>`}<button id="live-stop" type="button">Stop run…</button></div>
    <p id="live-action-status" role="status">${unsaved ? "" : continuing ? "Bao is continuing this run" : ""}</p>
    <div class="live-split"><div><h3>Steps</h3><ol id="live-steps" class="live-progress" aria-label="Step progress">${unsaved ? `<li class="live-loading">Steps appear when the run pauses or ends.</li>` : progress || `<li class="live-loading">Steps are unavailable.</li>`}</ol></div>
      <figure class="live-preview"><div class="live-shot">${currentShot}</div><figcaption><span class="live-badge"><i aria-hidden="true"></i>Live</span><span>${esc(location)}</span></figcaption></figure></div>
    <div class="live-screens"><h3>Screens so far</h3><ol id="live-film" style="--n:${Math.max(1, shots.length)}" aria-label="Screens captured during this run">${shots.map((shot) => `<li data-status="${shot.status}"><div class="live-shot"><img src="${esc(shot.src)}" alt="Step ${shot.index + 1}: ${esc(shot.label)}"></div><span class="live-cap"><span class="run-glyph ${shot.status}">${runStatusGlyph(shot.status)}</span>${shot.index + 1}</span></li>`).join("")}</ol>${shots.length ? "" : `<p class="live-empty">${unsaved ? "Screens appear when the run pauses or ends." : "No screens captured yet."}</p>`}</div>
    <details id="live-run-details"><summary id="live-details-summary">${chevron}Run details</summary><div class="live-code">${inputs.length ? `Inputs: ${inputs.map(([key, value]) => `${esc(key)} = ${esc(value)}`).join(" · ")}<br>` : ""}Driver: Bao’s Chrome (own profile)${run?.modelCalls != null ? ` · ${run.modelCalls} model calls` : ""} · Run ID ${esc(active.id)}</div></details>
    <dialog id="live-stop-dialog" aria-labelledby="live-stop-title"><h2 id="live-stop-title">Stop this run?</h2><p>Bao stops this run. Anything you already did on the site stays done.</p><form method="dialog"><button value="cancel" type="submit">${unsaved ? "Keep running" : "Keep waiting"}</button><button value="stop" id="live-stop-confirm" type="submit">Stop run</button></form></dialog>
  </section>`;
}

/** Local run view. Shot URLs point at this machine's app, never at a remote host. */
export function liveSessionView(session: LiveSessionRecord | null | undefined, page?: number): string {
  if (!session || session.status === "idle") {
    return `<section id="live-session" data-status="idle"><h2>Live session</h2><p class="quiet">No live session yet. A run on this Mac shows its steps, audit, and blurred page shots here.</p></section>`;
  }
  const shotAt = session.audit.findIndex((row) => row.shot);
  const chosen = page == null ? (shotAt < 0 ? 0 : Math.floor(shotAt / AUDIT_PAGE_SIZE)) : page;
  const audit = auditPage(session.audit, chosen);
  const steps = session.steps.map((step) =>
    `<li data-status="${esc(step.status)}"><strong>${esc(ownerStopText(step.name))}</strong> <span class="quiet">${esc(step.status)} · ${step.ms} ms</span></li>`).join("");
  const rows = audit.rows.map((row) =>
    `<tr><td>${esc(row.action)}</td><td>${esc(ownerStopText(row.label))}</td><td class="mono">${esc(row.path)}</td><td>${esc(trustedWord(row.isTrusted, row.via))}</td><td>${row.ms} ms</td></tr>`).join("");
  const shots = audit.rows.filter((row) => row.shot).map((row) => {
    const src = liveShotUrl(row.shot);
    if (!src) return "";
    return `<figure><img alt="${esc(`${row.action} ${row.path}`)}" src="${esc(src)}"><figcaption class="quiet">${esc(row.action)} ${esc(row.path)}</figcaption></figure>`;
  }).join("");
  return `<section id="live-session" data-status="${esc(session.status)}">
    <h2>Live session</h2>
    <p id="live-status"><strong>${esc(session.status)}</strong> ${esc(session.host)}</p>
    <p class="quiet">${esc(session.intent)}</p>
    ${session.allowCommit ? `<p class="quiet">Experian commit opt-in: this session may change the freeze. Later sessions and replays still stop for confirmation.</p>` : ""}
    ${session.note ? `<p class="quiet" id="live-note">${esc(ownerStopMessage(session.note))}</p>` : ""}
    ${session.navigationBlock ? `<p class="quiet" id="live-navigation-block">Navigation blocked: ${esc(session.navigationBlock.reason)} at ${esc(session.navigationBlock.url)}</p>` : ""}
    <p class="quiet">These pictures stay on this Mac. The app does not upload them.</p>
    <h3 class="section">Steps</h3>
    <ol id="live-steps">${steps || `<li class="quiet">No steps yet.</li>`}</ol>
    <h3 class="section">Audit</h3>
    <p id="live-audit-page" class="quiet" data-total="${audit.total}" data-page="${audit.page + 1}">Audit page ${audit.page + 1} of ${audit.pages}. ${audit.total} rows.</p>
    <nav id="live-pager" class="row" aria-label="Audit pages"><a class="button" href="?screen=live&amp;page=${Math.max(0, audit.page - 1)}">Previous</a> <a class="button" href="?screen=live&amp;page=${Math.min(audit.pages - 1, audit.page + 1)}">Next</a></nav>
    <table id="live-audit" class="grid">
      <thead><tr><th>Action</th><th>Target</th><th>Path</th><th>Trusted</th><th>View time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 class="section">Shots</h3>
    <div id="live-shots">${shots || `<p class="quiet">No shots yet.</p>`}</div>
  </section>`;
}
