// HTML for the trace view: a debug view of one run, laid out like Playwright's trace viewer.
// It shows only what the run file and the step records hold. The run receipt stays the owner's view.
import type { FileTransfer } from "../engines/agent-browser-files";
import type { HarEntry } from "../engines/step-har";
import { duration, failed, mapHtml, pageHtml } from "./step-record-html";
import type { Phase, RequestRow, RunRecordIndex, StepRecordView } from "./step-record-view";
import type { StepView } from "./view-types";
import { byteSize, htmlEsc as esc, imageRef, receiptBrowsers, receiptClock, receiptFiles, runKind, runWorkflowName, shownArgs, statusLabel, type RunSummary } from "./views";

export type TraceStep = StepView & { why?: string; transfer?: FileTransfer };
export type TraceRun = Omit<RunSummary, "steps"> & { steps?: TraceStep[] };
/** A step's record, `undefined` when Bao kept none for it. */
export type TraceRecord = StepRecordView | undefined;
export type Source = "picture" | "page";

export const TRACE_TABS = ["call", "errors", "console", "network", "page", "attachments"] as const;
export type TraceTab = typeof TRACE_TABS[number];

const NO_RECORD = `<p class="empty">Bao kept no step record for this step.</p>`;
const BODY_LIMIT = 50_000;

export function stepTitle(step: TraceStep): string {
  return step.label || step.caption?.text || step.native?.command || step.id;
}

/** The run's span on the timeline: its start, or its first step, to the end of its last step. */
export function traceSpan(run: TraceRun): { origin: number; end: number } {
  const times = (run.steps || []).flatMap((step) => [step.startedAt, step.endedAt]).filter((time): time is number => typeof time === "number");
  const origin = Math.min(...(typeof run.at === "number" ? [run.at] : []), ...times);
  if (!Number.isFinite(origin)) return { origin: 0, end: 1 };
  return { origin, end: Math.max(origin + 1, ...times) };
}

/** The step whose bar a time on the timeline falls in or after: the latest one that had started. */
export function stepAt(run: TraceRun, time: number): number {
  let found = 0;
  (run.steps || []).forEach((step, index) => { if (typeof step.startedAt === "number" && step.startedAt <= time) found = index; });
  return found;
}

/** The newest picture a step kept by a time, for a run with no video. */
export function shotAt(run: TraceRun, time: number): string {
  let found = "";
  for (const step of run.steps || []) {
    if (step.beforeShot && typeof step.startedAt === "number" && step.startedAt <= time) found = step.beforeShot;
    if (step.afterShot && typeof step.endedAt === "number" && step.endedAt <= time) found = step.afterShot;
  }
  return imageRef(run.id, found);
}

function tickClock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function timeline(run: TraceRun): string {
  const { origin, end } = traceSpan(run);
  const total = end - origin;
  const at = (time: number) => `${((time - origin) / total) * 100}%`;
  const unit = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((seconds) => seconds * 1000).find((ms) => total / ms <= 12) ?? 3_600_000;
  const ticks = Array.from({ length: Math.floor(total / unit) + 1 }, (_, index) => `<span class="tick" style="left:${at(origin + index * unit)}">${tickClock(index * unit)}</span>`).join("");
  const bars = (run.steps || []).map((step, index) => {
    if (typeof step.startedAt !== "number") return "";
    const ended = typeof step.endedAt === "number" ? step.endedAt : step.startedAt;
    const waited = step.native?.command === "wait_for_owner" ? " owner" : "";
    return `<button type="button" class="bar ${esc(step.status)}${waited}" data-step="${index}" style="left:${at(step.startedAt)};width:${((ended - step.startedAt) / total) * 100}%" aria-label="${esc(`Step ${index + 1}: ${stepTitle(step)}`)}">${index + 1}</button>`;
  }).join("");
  const video = run.video ? `<video muted playsinline preload="auto" src="/api/runs/${encodeURIComponent(run.id)}/video"></video>` : `<img alt="">`;
  return `<section id="timeline" aria-label="Timeline" data-origin="${origin}" data-end="${end}"${run.video ? ` data-video-origin="${run.videoStartedAt ?? origin}"` : ""}>
    <div class="ticks">${ticks}</div>
    <div class="film" aria-hidden="true"></div>
    <div class="bars">${bars}</div>
    <div class="cursor" hidden></div>
    <div class="preview" hidden>${video}<span class="time"></span><span class="name"></span></div>
  </section>`;
}

function actions(run: TraceRun): string {
  const rows = (run.steps || []).map((step, index) => {
    const took = typeof step.startedAt === "number" && typeof step.endedAt === "number" ? duration(step.endedAt - step.startedAt) : "";
    const mark = step.status === "failed" ? `<span class="mark" aria-label="Failed">✗</span>` : "";
    return `<li><button type="button" class="action ${esc(step.status)}" data-step="${index}"><span class="n">${index + 1}</span><span class="title">${mark}${esc(stepTitle(step))}</span><span class="took">${esc(took)}</span>${step.why ? `<span class="why">${esc(step.why)}</span>` : ""}</button></li>`;
  }).join("");
  return `<ol id="actions">${rows || `<li class="empty">This run has no steps.</li>`}</ol>`;
}

function row(key: string, value: string): string {
  return value ? `<dt>${esc(key)}</dt><dd>${value}</dd>` : "";
}

function metadata(run: TraceRun, index: RunRecordIndex): string {
  const { origin, end } = traceSpan(run);
  const steps = run.steps || [];
  return `<dl id="metadata" class="facts" hidden>
    ${row("Run", `<code>${esc(run.id)}</code>`)}
    ${row("Task", esc(run.task || ""))}
    ${row("Status", esc(statusLabel(runKind(run))))}
    ${row("Agent said", esc(run.envelope?.reason || ""))}
    ${row("Started", typeof run.at === "number" ? esc(new Date(run.at).toLocaleString()) : "")}
    ${row("Took", steps.length ? esc(duration(end - origin)) : "")}
    ${row("Browser", receiptBrowsers(run))}
    ${row("Steps", `${steps.length}, ${index.steps.length} with a step record`)}
    ${row("Network", index.harBytes === undefined ? "No run.har" : `<a href="/api/runs/${encodeURIComponent(run.id)}/run.har" download="${esc(run.id)}.har">run.har</a>, ${esc(byteSize(index.harBytes))}`)}
    ${row("Video", run.video ? `Tab video${run.videoTruncated ? ", cut at the capture limit" : ""}` : "None. The timeline shows the steps' pictures.")}
  </dl>`;
}

/** The page around the picked step: the top bar, the timeline, and the action list with its Metadata tab. */
export function traceShell(run: TraceRun, index: RunRecordIndex): string {
  const kind = runKind(run);
  return `<header id="bar">
      <a class="back" href="/?run=${encodeURIComponent(run.id)}">‹ Run</a>
      <h1>${esc(runWorkflowName(run, []))}</h1>
      <span class="status ${esc(kind)}">${esc(statusLabel(kind))}</span>
    </header>
    ${timeline(run)}
    <main>
      <nav id="side" aria-label="Steps">
        <div class="tabs" role="tablist"><button type="button" role="tab" data-side="actions" aria-selected="true">Actions</button><button type="button" role="tab" data-side="metadata" aria-selected="false">Metadata</button></div>
        ${actions(run)}
        ${metadata(run, index)}
      </nav>
      <section id="detail" aria-label="Step"><div id="snapshot"></div><div id="tabs"></div></section>
    </main>`;
}

function archive(runId: string, step: TraceStep, record: TraceRecord, phase: Phase): string {
  const facts = record?.pages[phase];
  return facts && !("error" in facts) && facts.mhtml ? `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step.id)}/${phase}.html` : "";
}

/** The phase to open a step on: Before when it holds the picture with the target's box, else the one that has something to show. */
export function openPhase(run: TraceRun, step: TraceStep, record: TraceRecord): Phase {
  const has = (phase: Phase) => Boolean((phase === "before" ? step.beforeShot : step.afterShot) || archive(run.id, step, record, phase));
  if (step.target && step.beforeShot) return "before";
  return has("after") || !has("before") ? "after" : "before";
}

/** The step's page before or after it: the stored picture, or the stored MHTML archive as a page, or why neither exists. */
export function traceSnapshot(run: TraceRun, step: TraceStep, record: TraceRecord, phase: Phase, wanted: Source): string {
  const picture = imageRef(run.id, phase === "before" ? step.beforeShot : step.afterShot);
  const page = archive(run.id, step, record, phase);
  const source: Source = (wanted === "page" && page) || !picture ? "page" : "picture";
  const facts = record?.pages[phase];
  const where = facts && !("error" in facts) ? `<span class="where" title="${esc(facts.url)}"><strong>${esc(facts.title || "Untitled page")}</strong> ${esc(facts.url)}</span>` : `<span class="where"></span>`;
  const phases = (["before", "after"] as const).map((name) => `<button type="button" role="tab" data-phase="${name}" aria-selected="${name === phase}">${name === "before" ? "Before" : "After"}</button>`).join("");
  const sources = picture && page
    ? `<div class="sources">${(["picture", "page"] as const).map((name) => `<button type="button" data-source="${name}" aria-pressed="${name === source}">${name === "picture" ? "Screenshot" : "Snapshot"}</button>`).join("")}</div>`
    : "";
  const box = step.target;
  const target = phase === "before" && box
    ? `<span class="target" style="left:${(box.rect.x / box.viewport.width) * 100}%;top:${(box.rect.y / box.viewport.height) * 100}%;width:${(box.rect.width / box.viewport.width) * 100}%;height:${(box.rect.height / box.viewport.height) * 100}%"></span>`
    : "";
  const viewport = facts && !("error" in facts) ? facts.viewport : undefined;
  const error = phase === "before" ? step.beforeShotError : step.afterShotError;
  const stage = source === "picture" && picture ? `<div class="shot"><img src="${esc(picture)}" alt="${esc(`The page ${phase} step: ${stepTitle(step)}`)}">${target}</div>`
    : page ? `<iframe class="archive" sandbox="" src="${esc(page)}" title="${esc(`Page snapshot ${phase} the step`)}" data-width="${viewport?.width ?? 1280}"></iframe>`
      : `<p class="empty">${esc(error || (facts && "error" in facts ? `Bao could not read the page: ${facts.error}` : `Bao kept no picture or page archive of the page ${phase} this step.`))}</p>`;
  return `<div class="snapbar"><div class="tabs" role="tablist">${phases}</div>${where}${sources}</div><div class="stage">${stage}</div>`;
}

function callPanel(run: TraceRun, step: TraceStep, record: TraceRecord): string {
  const { origin } = traceSpan(run);
  const command = [step.native?.command, ...shownArgs(stepTitle(step), step.native)].filter(Boolean).join(" ");
  const took = typeof step.startedAt === "number" && typeof step.endedAt === "number" ? duration(step.endedAt - step.startedAt) : "";
  const waits = record?.waits.map((wait) => `${duration(wait.ms)} ${wait.for === "owner" ? "for the owner" : `for ${wait.for}`}`).join(", ");
  const reads = record ? (["before", "after"] as const).flatMap((phase) => record.pages[phase] ? [`${duration(record.pages[phase]!.ms)} ${phase}`] : []).join(", ") : "";
  const target = record?.target;
  const box = target?.box ? `, box ${Math.round(target.box.x)}, ${Math.round(target.box.y)}, ${Math.round(target.box.width)} × ${Math.round(target.box.height)}` : "";
  const out = (step.native?.results || []).map((result) => result.stdout).join("").trim();
  const err = (step.native?.results || []).map((result) => result.stderr).join("").trim();
  return `<dl class="facts">
    ${row("Command", command ? `<code>${esc(command)}</code>` : "")}
    ${row("Why", esc(step.why || ""))}
    ${row("Status", esc([step.status, step.reason].filter(Boolean).join(": ")))}
    ${row("Started", typeof step.startedAt === "number" ? `${esc(receiptClock(step.startedAt - origin))} into the run` : "")}
    ${row("Took", esc(took))}
    ${row("Waited", esc(waits || ""))}
    ${row("Page reads", reads ? `${esc(reads)}, outside that wait` : "")}
    ${row("Target", target ? esc(`${[target.ref, target.role, target.name ? `"${target.name}"` : ""].filter(Boolean).join(" ")}${box}`) : "")}
    ${row("Returned", out ? `<pre>${esc(out)}</pre>` : "")}
    ${row("Error output", err ? `<pre>${esc(err)}</pre>` : "")}
  </dl>`;
}

function rows(record: StepRecordView): RequestRow[] {
  return [...record.network.work, ...record.network.static, ...record.network.analytics].sort((a, b) => a.index - b.index);
}

function problems(step: TraceStep, record: TraceRecord): string[] {
  const own = record?.error || (step.status === "failed" ? step.reason || "The step failed." : "");
  return [
    ...(own ? [`<li class="failed"><span class="key">Step</span><span>${esc(own)}</span></li>`] : []),
    ...(record?.errors || []).map((line) => `<li class="failed"><span class="key">Page error</span><span>${esc(line.text)}</span></li>`),
    ...(record ? rows(record).filter(failed) : []).map((request) => `<li class="failed"><span class="key">${esc(request.status ? `Load ${request.status}` : "Load failed")}</span><span>${esc(request.url)}${request.error ? ` <em>${esc(request.error)}</em>` : ""}</span></li>`),
  ];
}

function consoleRows(record: StepRecordView): string[] {
  return record.console.map((line) => `<li${line.type === "error" ? ` class="failed"` : ""}><span class="key">${esc(line.type)}</span><span>${esc(line.text)}</span></li>`);
}

function list(items: string[], none: string): string {
  return items.length ? `<ul class="lines">${items.join("")}</ul>` : `<p class="empty">${esc(none)}</p>`;
}

function networkPanel(run: TraceRun, record: StepRecordView): string {
  const { origin } = traceSpan(run);
  const body = rows(record).map((request) => {
    const status = request.status ? String(request.status) : request.error ? "failed" : "no response";
    return `<tr data-request="${request.index}" tabindex="0"${failed(request) ? ` class="failed"` : ""}>
      <td class="url" title="${esc(request.url)}">${esc(request.url.replace(/^https?:\/\//, ""))}${request.operation ? ` <em>GraphQL ${esc(request.operation)}</em>` : ""}</td>
      <td>${esc(request.method)}</td><td title="${esc(request.error || "")}">${esc(status)}</td><td>${esc(request.type || "")}</td>
      <td class="num">${request.at === undefined ? "" : esc(receiptClock(request.at - origin))}</td><td class="num">${request.ms === undefined ? "" : esc(duration(request.ms))}</td><td class="num">${request.bytes === undefined ? "" : esc(byteSize(request.bytes))}</td>
    </tr>`;
  }).join("");
  if (!body) return `<p class="empty">No requests recorded for this step.</p>`;
  return `<input class="net-filter" type="search" placeholder="Filter requests" aria-label="Filter requests"><table class="net"><thead><tr><th>Request</th><th>Method</th><th>Status</th><th>Type</th><th class="num">Started</th><th class="num">Took</th><th class="num">Size</th></tr></thead><tbody>${body}</tbody></table>`;
}

function pagePanel(run: TraceRun, step: TraceStep, record: StepRecordView): string {
  const tree = record.pages.after && !("error" in record.pages.after) && record.pages.after.axNodes !== undefined
    ? `<details class="ax" data-ax="/api/runs/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}/after.ax.json"><summary>Accessibility tree after this step</summary><pre>Loading…</pre></details>`
    : "";
  return `${pageHtml(run.id, record)}${mapHtml(record.map)}${tree}`;
}

/** The tabs under the snapshot: Call, Errors, Console, Network, Page and Attachments, scoped to the picked step. */
export function traceTabs(run: TraceRun, step: TraceStep, record: TraceRecord, open: TraceTab): string {
  const errors = problems(step, record);
  const files = step.transfer?.files.length ?? 0;
  const count: Partial<Record<TraceTab, number>> = { errors: errors.length, console: record?.console.length ?? 0, network: record?.network.total ?? 0, attachments: files };
  const label: Record<TraceTab, string> = { call: "Call", errors: "Errors", console: "Console", network: "Network", page: "Page", attachments: "Attachments" };
  const panel: Record<TraceTab, string> = {
    call: callPanel(run, step, record),
    errors: errors.length || record ? list(errors, "No step error, page error, or failed load recorded for this step.") : NO_RECORD,
    console: record ? list(consoleRows(record), "No console messages recorded for this step.") : NO_RECORD,
    network: record ? networkPanel(run, record) : NO_RECORD,
    page: record ? pagePanel(run, step, record) : NO_RECORD,
    attachments: receiptFiles(step.transfer) || `<p class="empty">This step saved or attached no files.</p>`,
  };
  const tabs = TRACE_TABS.map((name) => `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === open}">${label[name]}${count[name] ? ` <span class="count${name === "errors" ? " failed" : ""}">${count[name]}</span>` : ""}</button>`).join("");
  const panels = TRACE_TABS.map((name) => `<div class="panel" role="tabpanel" data-panel="${name}"${name === open ? "" : " hidden"}>${panel[name]}</div>`).join("");
  return `<div class="tabs" role="tablist">${tabs}</div>${panels}`;
}

type Header = { name?: string; value?: string };

function pairs(title: string, items: Header[] | undefined): string {
  const body = (items || []).map((item) => row(item.name || "", esc(item.value || ""))).join("");
  return body ? `<h4>${esc(title)}</h4><dl class="facts">${body}</dl>` : "";
}

function bodyText(title: string, text: string | undefined, mime: string, encoding?: string): string {
  if (!text) return "";
  if (encoding === "base64") {
    const shown = /^image\/(png|jpeg|gif|webp|svg\+xml)/.test(mime) ? `<img class="body-image" alt="" src="data:${esc(mime.split(";")[0])};base64,${esc(text)}">` : `<p class="empty">A binary body. Download the step's HAR to read it.</p>`;
    return `<h4>${esc(title)}</h4>${shown}`;
  }
  let pretty = text;
  if (/json/.test(mime) && text.length <= BODY_LIMIT) {
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as stored */ }
  }
  const cut = pretty.length > BODY_LIMIT ? `<p class="empty">The first ${BODY_LIMIT.toLocaleString("en-US")} of ${pretty.length.toLocaleString("en-US")} characters. Download the step's HAR to read the rest.</p>` : "";
  return `<h4>${esc(title)}</h4>${cut}<pre>${esc(pretty.slice(0, BODY_LIMIT))}</pre>`;
}

/** One request's stored HAR entry: its URL, headers, query, and the bodies agent-browser kept. */
export function requestDetail(entry: HarEntry): string {
  const request = (entry.request ?? {}) as { method?: string; url?: string; headers?: Header[]; queryString?: Header[]; postData?: { mimeType?: string; text?: string } };
  const response = (entry.response ?? {}) as { status?: number; statusText?: string; headers?: Header[]; content?: { mimeType?: string; text?: string; encoding?: string } };
  const had = Boolean(response.status);
  return `<div class="request">
    <p class="full-url"><strong>${esc(request.method || "GET")}</strong> ${esc(request.url || "")}</p>
    ${pairs("Query", request.queryString)}
    ${pairs("Request headers", request.headers)}
    ${bodyText("Request body", request.postData?.text, request.postData?.mimeType || "")}
    ${had ? pairs("Response headers", response.headers) : `<p class="empty">${esc(response.statusText ? `Chrome failed this request: ${response.statusText}` : "No response was recorded for this request.")}</p>`}
    ${had ? bodyText("Response body", response.content?.text, response.content?.mimeType || "", response.content?.encoding) : ""}
  </div>`;
}

interface AxNode { nodeId?: string; parentId?: string; childIds?: string[]; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }

/** `Accessibility.getFullAXTree` as an indented outline of role and name. Ignored nodes pass their children up. */
export function axOutline(ax: unknown): string {
  const nodes = ((ax as { nodes?: AxNode[] } | undefined)?.nodes || []).filter((node) => node.nodeId);
  const byId = new Map(nodes.map((node) => [node.nodeId!, node]));
  const lines: string[] = [];
  const walk = (node: AxNode, depth: number) => {
    const role = node.role?.value || "";
    const shown = !node.ignored && role !== "InlineTextBox" && role !== "none";
    if (shown) lines.push(`${"  ".repeat(depth)}${role === "StaticText" ? "" : `${role} `}${node.name?.value ? JSON.stringify(node.name.value) : ""}`.trimEnd());
    for (const id of node.childIds || []) { const child = byId.get(id); if (child) walk(child, shown ? depth + 1 : depth); }
  };
  for (const node of nodes) if (!node.parentId || !byId.has(node.parentId)) walk(node, 0);
  return lines.filter((line) => line.trim()).join("\n");
}
