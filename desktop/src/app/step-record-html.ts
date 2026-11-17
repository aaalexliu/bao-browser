// HTML for one step's stored record in the run receipt. The browser script fills it in when the owner opens the step's section.
import type { FieldRow, PageFacts, PageMap, Phase, RequestRow, StepRecordView } from "./step-record-view";
import { esc } from "./views";

const SHOWN_REQUESTS = 10;

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function fileLink(runId: string, stepId: string, name: string, label: string): string {
  const href = `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/${name}`;
  return `<a href="${esc(href)}" download="${esc(`${runId}-${stepId}-${name}`)}">${esc(label)}</a>`;
}

/** A load that went wrong: an HTTP error status, or a network error Chrome named. No response with no error is not one. */
function failed(row: RequestRow): boolean {
  return row.status >= 400 || Boolean(row.error);
}

function requestRow(row: RequestRow): string {
  const status = row.status ? String(row.status) : row.error ? "failed" : "no response recorded";
  const facts = [row.error, row.operation ? `GraphQL ${row.operation}` : "", row.type, row.mime, row.ms === undefined ? "" : `${row.ms} ms`].filter(Boolean).join(" · ");
  return `<div class="record-row${failed(row) ? " failed" : ""}"><span class="record-key">${esc(row.method)} ${esc(status)}</span><span class="record-value">${esc(row.url)}${facts ? `<span class="record-facts">${esc(facts)}</span>` : ""}</span></div>`;
}

function collapsed(label: string, rows: string[]): string {
  return rows.length ? `<details><summary>${esc(label)} (${rows.length})</summary><div class="record-rows">${rows.join("")}</div></details>` : "";
}

function timingHtml(view: StepRecordView): string {
  const waits = view.waits.map((wait) => `Waited ${duration(wait.ms)} ${wait.for === "owner" ? "for the owner" : `for ${wait.for} to finish`}.`);
  const reads = (["before", "after"] as const).flatMap((phase) => view.pages[phase] ? [`${duration(view.pages[phase]!.ms)} ${phase}`] : []);
  const read = reads.length ? ` Bao read the page in ${reads.join(" and ")}, outside that wait.` : "";
  const text = `${waits.join(" ") || "The step did not finish, so no wait is recorded."}${read}`;
  return `<section class="record-part" aria-label="Timing"><h4>Timing</h4><p>${esc(text)}</p></section>`;
}

function networkHtml(runId: string, view: StepRecordView): string {
  const { network } = view;
  const filed = network.static.length + network.analytics.length;
  const count = network.total
    ? `${plural(network.total, "request")}. ${network.work.length} did real work${filed ? `; ${[network.static.length ? plural(network.static.length, "static file") : "", network.analytics.length ? plural(network.analytics.length, "analytics request") : ""].filter(Boolean).join(" and ")} ${filed === 1 ? "is" : "are"} filed below them` : ""}.`
    : "No requests recorded for this step.";
  const work = network.work.map(requestRow);
  const shown = work.length > SHOWN_REQUESTS + 2 ? work.slice(0, SHOWN_REQUESTS) : work;
  const more = work.slice(shown.length);
  return `<section class="record-part" aria-label="Network"><h4>Network</h4><p>${esc(count)}</p>
    ${shown.length ? `<div class="record-rows">${shown.join("")}</div>` : ""}
    ${collapsed("More requests that did real work", more)}
    ${collapsed("Static files", network.static.map(requestRow))}
    ${collapsed("Analytics", network.analytics.map(requestRow))}
    ${network.total ? `<p class="record-links">${fileLink(runId, view.id, "network.har", "Download this step's HAR")}</p>` : ""}</section>`;
}

function pageRow(runId: string, stepId: string, phase: Phase, facts: PageFacts): string {
  const word = phase === "before" ? "Before" : "After";
  if ("error" in facts) return `<div class="record-row failed"><span class="record-key">${word}</span><span class="record-value">Bao could not read the page: ${esc(facts.error)}</span></div>`;
  const where = [facts.viewport ? `${facts.viewport.width} × ${facts.viewport.height} viewport` : "", `scrolled to ${Math.round(facts.scroll.x)}, ${Math.round(facts.scroll.y)}`].filter(Boolean).join(" · ");
  const links = [
    fileLink(runId, stepId, `${phase}.dom.json`, "DOM snapshot"),
    facts.axNodes === undefined ? "" : fileLink(runId, stepId, `${phase}.ax.json`, `Accessibility tree (${plural(facts.axNodes, "node")})`),
    facts.mhtml ? fileLink(runId, stepId, `${phase}.mhtml`, "MHTML archive") : "",
  ].filter(Boolean).join(" · ");
  const notes = facts.mhtmlError ? `<span class="record-facts">${esc(`The MHTML archive failed: ${facts.mhtmlError}`)}</span>` : "";
  return `<div class="record-row"><span class="record-key">${word}</span><span class="record-value">${esc(facts.title || "Untitled page")}<span class="record-facts">${esc(facts.url)}</span><span class="record-facts">${esc(where)}</span><span class="record-links">${links}</span>${notes}</span></div>`;
}

function pageHtml(runId: string, view: StepRecordView): string {
  const rows = (["before", "after"] as const).flatMap((phase) => view.pages[phase] ? [pageRow(runId, view.id, phase, view.pages[phase]!)] : []);
  const target = view.target
    ? `<p>Acted on ${esc([view.target.ref, view.target.role, view.target.name ? `"${view.target.name}"` : ""].filter(Boolean).join(" "))}${view.target.box ? `, box ${esc(`${Math.round(view.target.box.x)}, ${Math.round(view.target.box.y)}, ${Math.round(view.target.box.width)} × ${Math.round(view.target.box.height)}`)}` : ""}.</p>`
    : "";
  return `<section class="record-part" aria-label="Page"><h4>Page</h4>${target}${rows.length ? `<div class="record-rows">${rows.join("")}</div>` : `<p>Bao did not read the page for this step.</p>`}</section>`;
}

function fieldText(field: FieldRow): string {
  return `${field.name || `(${field.type} with no name)`} = ${field.value === "" ? "empty" : field.value}`;
}

function framed(text: string, frame: string | undefined): string {
  return `${esc(text)}${frame ? `<span class="record-facts">In frame ${esc(frame)}</span>` : ""}`;
}

function mapRow(key: string, value: string): string {
  return `<div class="record-row"><span class="record-key">${esc(key)}</span><span class="record-value">${value}</span></div>`;
}

function mapHtml(map: PageMap | undefined): string {
  if (!map) return "";
  const groups = [
    collapsed("Links", map.links.map((link) => mapRow("Link", `${esc(link.text || "(no text)")}<span class="record-facts">${esc(link.href)}</span>${link.frame ? `<span class="record-facts">In frame ${esc(link.frame)}</span>` : ""}`))),
    collapsed("Buttons", map.buttons.map((button) => mapRow("Button", framed(button.text || "(no text)", button.frame)))),
    collapsed("Forms", map.forms.map((form) => mapRow(form.method, `${framed(form.action, form.frame)}${form.fields.map((field) => `<span class="record-facts">${esc(fieldText(field))}</span>`).join("")}`))),
    collapsed("Fields outside a form", map.loose.map((field) => mapRow(field.type, framed(fieldText(field), field.frame)))),
    collapsed("Select options", map.selects.map((select) => mapRow(select.name || "(no name)", framed(select.options.map((option) => `${option.text}${option.selected ? " (selected)" : ""}`).join(", "), select.frame)))),
  ].filter(Boolean);
  return `<section class="record-part" aria-label="Links and forms"><h4>Links and forms ${map.phase} this step</h4>${groups.length ? groups.join("") : "<p>The page had no links, buttons, forms, or fields.</p>"}</section>`;
}

function consoleHtml(view: StepRecordView): string {
  const loads = [...view.network.work, ...view.network.static, ...view.network.analytics].filter(failed);
  const rows = [
    ...view.console.map((line) => `<div class="record-row${line.type === "error" ? " failed" : ""}"><span class="record-key">${esc(line.type)}</span><span class="record-value">${esc(line.text)}</span></div>`),
    ...view.errors.map((line) => `<div class="record-row failed"><span class="record-key">Page error</span><span class="record-value">${esc(line.text)}</span></div>`),
    ...loads.map((row) => `<div class="record-row failed"><span class="record-key">${esc(row.status ? `Load ${row.status}` : "Load failed")}</span><span class="record-value">${esc(row.url)}${row.error ? `<span class="record-facts">${esc(row.error)}</span>` : ""}</span></div>`),
  ];
  return `<section class="record-part" aria-label="Console and errors"><h4>Console and errors</h4>${rows.length > SHOWN_REQUESTS + 2 ? collapsed("Messages", rows) : rows.length ? `<div class="record-rows">${rows.join("")}</div>` : "<p>No console messages, page errors, or failed loads recorded.</p>"}</section>`;
}

/** The body of a step's "Network, page, and console" section. */
export function stepRecordBody(runId: string, stepId: string, state: StepRecordView | "loading" | "missing" | "error"): string {
  if (state === "loading") return `<p class="record-quiet">Loading…</p>`;
  if (state === "missing") return `<p class="record-quiet">Bao kept no step record for this step.</p>`;
  if (state === "error") return `<p class="record-quiet">Bao could not load this step's record. Close and open this section to try again.</p>`;
  const error = state.error ? `<section class="record-part" aria-label="Error"><h4>Error</h4><p>${esc(state.error)}</p></section>` : "";
  return `<div class="record" data-record-for="${esc(stepId)}">${error}${timingHtml(state)}${networkHtml(runId, state)}${pageHtml(runId, state)}${mapHtml(state.map)}${consoleHtml(state)}</div>`;
}
