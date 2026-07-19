// Bao T16 — full-page dashboard. The management home the side panel can't be: full
// width for browsing the library, viewing/editing a workflow's steps, and re-watching
// run history. Opened as a normal tab (chrome-extension://<id>/dashboard.html), so it
// shares the extension origin with the SW — it reads storage/IndexedDB directly and
// writes only through SW messages (the single-writer discipline). Live capture stays in
// the panel; this surface is the library + post-hoc filmstrip.
import type { AssertKind, Msg, RunRecord, RunState, Step, Workflow, WorkflowSummary } from "./types";
import { domainOf, dateFmt, relTime, stepLabel, slugify, nSteps, groupWorkflows } from "./wf-view";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const listEl = $("list"), searchEl = $("search") as HTMLInputElement;
const placeholderEl = $("placeholder"), detailEl = $("detail");
const dnameEl = $("dname"), dmetaEl = $("dmeta"), dstepsEl = $("dsteps"), drunsEl = $("druns");
const drunBtn = $("drun") as HTMLButtonElement;
const deditBtn = $("dedit") as HTMLButtonElement, dsaveBtn = $("dsave") as HTMLButtonElement;
const dcancelBtn = $("dcancel") as HTMLButtonElement, dexportBtn = $("dexport") as HTMLButtonElement;
const ddeleteBtn = $("ddelete") as HTMLButtonElement;

const sw = (msg: Msg) => chrome.runtime.sendMessage(msg);

// ---------------------------- library ----------------------------
let summaries: WorkflowSummary[] = [];
let query = "";
let currentId: string | null = null;   // selected workflow (drives the detail pane)
let currentWf: Workflow | null = null;
let editing = false;                    // step-edit mode (T16 light editing)
let draft: Step[] = [];                 // working copy while editing; committed on Save

async function refresh(): Promise<void> {
  summaries = (await sw({ cmd: "bao-wf-list" })) || [];
  renderList();
}

function visible(): WorkflowSummary[] {
  const q = query.trim().toLowerCase();
  return summaries.filter((w) => !q || w.name.toLowerCase().includes(q) ||
    domainOf(w.startUrl).toLowerCase().includes(q));
}

function renderList(): void {
  const items = visible();
  listEl.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query.trim() ? "No matches." : "No workflows yet — record one from the side panel.";
    listEl.appendChild(empty);
    return;
  }
  const { pinned, groups } = groupWorkflows(items);
  if (pinned.length) {
    listEl.appendChild(groupHeader("📌 Pinned", pinned.length));
    for (const w of pinned) listEl.appendChild(card(w));
  }
  for (const [domain, ws] of groups) {
    listEl.appendChild(groupHeader(domain, ws.length));
    for (const w of ws) listEl.appendChild(card(w));
  }
}

function groupHeader(label: string, n: number): HTMLElement {
  const h = document.createElement("div");
  h.className = "group-h";
  h.textContent = `${label} `;
  const count = document.createElement("span");
  count.className = "n";
  count.textContent = `(${n})`;
  h.appendChild(count);
  return h;
}

function card(w: WorkflowSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = "card" + (w.id === currentId ? " sel" : "");
  el.onclick = () => openDetail(w.id);

  const body = document.createElement("div");
  body.className = "body";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = w.name;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${domainOf(w.startUrl)} · ${nSteps(w.count)} · ${relTime(w.createdAt)}`;
  body.append(name, meta);

  const run = document.createElement("button");
  run.className = "run";
  run.textContent = "▶";
  run.title = "Run in a new tab";
  run.onclick = (e) => { e.stopPropagation(); runWorkflow(w.id, w.startUrl); };

  el.append(body, run);
  return el;
}

// ---------------------------- detail ----------------------------
async function openDetail(id: string): Promise<void> {
  currentId = id;
  editing = false; draft = [];
  currentWf = await sw({ cmd: "bao-wf-get", id });
  if (!currentWf) { currentId = null; showPlaceholder(); await refresh(); return; }
  placeholderEl.hidden = true;
  detailEl.hidden = false;
  renderDetail();
  renderList(); // reflect the selection highlight
  await loadHistory(id);
}

function showPlaceholder(): void {
  detailEl.hidden = true;
  placeholderEl.hidden = false;
}

function renderDetail(): void {
  const wf = currentWf!;
  dnameEl.textContent = wf.name;
  dmetaEl.textContent =
    `${domainOf(wf.startUrl)} · ${nSteps(wf.steps.length)} · created ${dateFmt(wf.createdAt)}` +
    (wf.pinned ? " · 📌 pinned" : "");
  setEditUI();
  renderSteps();
}

// Edit mode swaps the action bar and outlines the step list; the read/run/export/delete
// actions are hidden so the surface reads as a focused editor.
function setEditUI(): void {
  deditBtn.hidden = editing;
  drunBtn.hidden = dexportBtn.hidden = ddeleteBtn.hidden = editing;
  dsaveBtn.hidden = dcancelBtn.hidden = !editing;
  dstepsEl.classList.toggle("editing", editing);
  $("stepshead").textContent = editing ? "Steps (editing)" : "Steps";
}

function renderSteps(): void {
  const wf = currentWf!;
  dstepsEl.textContent = "";
  // Lead row: where replay navigates before step 1 (same convention as the panel).
  if (wf.startUrl) {
    const row = document.createElement("div");
    row.className = "srow start";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = "↦";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = `Start at ${wf.startUrl}`;
    row.append(num, lbl);
    dstepsEl.appendChild(row);
  }
  const steps = editing ? draft : wf.steps;
  steps.forEach((s, i) => dstepsEl.appendChild(editing ? editRow(s, i) : readRow(s, i)));
}

function readRow(s: Step, i: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "srow";
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(i + 1);
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = stepLabel(s);
  row.append(num, lbl);
  return row;
}

// An editable step row: ▲▼ reorder, ✕ delete, plus an inline field for the only
// hand-editable bits (input/select `value`, assert kind+value). Structural facts
// (action/target) stay read-only — the SW rejects any attempt to change them anyway.
function editRow(s: Step, i: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "srow edit";

  const ctl = document.createElement("div");
  ctl.className = "ctl";
  const up = mkBtn("▲", "Move up", () => { swap(i, i - 1); });
  const down = mkBtn("▼", "Move down", () => { swap(i, i + 1); });
  up.disabled = i === 0;
  down.disabled = i === draft.length - 1;
  const del = mkBtn("✕", "Delete step", () => removeStep(i));
  del.className = "del";
  ctl.append(up, down, del);

  const num = document.createElement("span");
  num.className = "num";
  num.textContent = String(i + 1);
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = s.label;
  row.append(ctl, num, lbl);

  if (s.action === "input" || s.action === "select") {
    const vedit = document.createElement("div");
    vedit.className = "vedit";
    const input = document.createElement("input");
    input.value = s.value ?? "";
    input.placeholder = "value";
    input.oninput = () => { draft[i] = { ...draft[i], value: input.value }; };
    vedit.appendChild(input);
    row.appendChild(vedit);
  } else if (s.action === "assert") {
    const vedit = document.createElement("div");
    vedit.className = "vedit";
    const kind = document.createElement("select");
    for (const k of ["textPresent", "elementVisible", "elementAbsent", "urlMatches"] as AssertKind[]) {
      const opt = document.createElement("option");
      opt.value = k; opt.textContent = k;
      if (s.assert?.kind === k) opt.selected = true;
      kind.appendChild(opt);
    }
    const val = document.createElement("input");
    val.value = s.assert?.value ?? "";
    val.placeholder = "expected value";
    const sync = () => {
      draft[i] = { ...draft[i], assert: { kind: kind.value as AssertKind, value: val.value } };
    };
    kind.onchange = sync; val.oninput = sync;
    vedit.append(kind, val);
    row.appendChild(vedit);
  }
  return row;
}

function mkBtn(text: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text; b.title = title;
  b.onclick = fn;
  return b;
}
function swap(a: number, b: number): void {
  if (b < 0 || b >= draft.length) return;
  [draft[a], draft[b]] = [draft[b], draft[a]];
  renderSteps();
}
function removeStep(i: number): void {
  if (draft.length === 1 && !confirm("Delete the last step? This leaves the workflow empty.")) return;
  draft.splice(i, 1);
  renderSteps();
}

// ---------------------------- run history ----------------------------
async function loadHistory(id: string): Promise<void> {
  const runs: RunRecord[] = (await sw({ cmd: "bao-runs-list", workflowId: id })) || [];
  if (currentId !== id) return; // selection moved on while we awaited
  drunsEl.textContent = "";
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No runs yet.";
    drunsEl.appendChild(empty);
    return;
  }
  for (const r of runs) drunsEl.appendChild(runRow(r));
}

function runRow(r: RunRecord): HTMLElement {
  const el = document.createElement("div");
  el.className = "run-row";
  const dot = document.createElement("span");
  dot.className = `dot ${r.outcome}`;
  const when = document.createElement("div");
  when.className = "when";
  const top = document.createElement("div");
  top.textContent = `${r.outcome === "passed" ? "Passed" : "Failed"} · ${relTime(r.finishedAt)}`;
  const sub = document.createElement("div");
  sub.className = "sub";
  const okCount = r.results.filter((x) => x.ok).length;
  const dur = Math.max(0, r.finishedAt - r.startedAt);
  sub.textContent = `${okCount}/${r.steps.length} steps · ${(dur / 1000).toFixed(1)}s`;
  when.append(top, sub);
  el.append(dot, when);
  return el;
}

// ---------------------------- actions ----------------------------
// Run from the dashboard needs a target that isn't the dashboard tab itself, so open a
// fresh tab on the start URL and drive the run there. Live progress shows in the panel;
// the completed run lands in this workflow's history (auto-refreshed on the baoRun edit).
async function runWorkflow(id: string, startUrl: string): Promise<void> {
  const tab = await chrome.tabs.create({ url: startUrl || "about:blank", active: true });
  await sw({ cmd: "bao-wf-run", tabId: tab.id!, id });
}
drunBtn.onclick = () => { if (currentWf) runWorkflow(currentWf.id, currentWf.startUrl); };

// ---- edit steps ----
deditBtn.onclick = () => {
  if (!currentWf) return;
  editing = true;
  draft = currentWf.steps.map((s) => ({ ...s })); // shallow clone; edits stay local until Save
  setEditUI();
  renderSteps();
};
dcancelBtn.onclick = () => {
  editing = false; draft = [];
  setEditUI();
  renderSteps();
};
dsaveBtn.onclick = async () => {
  if (!currentWf) return;
  const res = await sw({ cmd: "bao-wf-update-steps", id: currentWf.id, steps: draft });
  if (!res?.ok) { alert(`Couldn't save: ${res?.error || "unknown error"}`); return; }
  editing = false; draft = [];
  await openDetail(currentWf.id); // re-read the committed workflow + refresh history/list
};

async function exportWorkflow(id: string): Promise<void> {
  const wf: Workflow | null = await sw({ cmd: "bao-wf-get", id });
  if (!wf) return;
  const blob = new Blob([JSON.stringify(wf, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bao-${slugify(wf.name)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
$("dexport").onclick = () => { if (currentWf) exportWorkflow(currentWf.id); };

$("ddelete").onclick = async () => {
  if (!currentWf) return;
  if (!confirm(`Delete "${currentWf.name}"? This cannot be undone.`)) return;
  await sw({ cmd: "bao-wf-delete", id: currentWf.id });
  currentId = null; currentWf = null;
  showPlaceholder();
  await refresh();
};

// ---------------------------- import ----------------------------
function isImportable(w: unknown): w is Workflow {
  const c = w as Workflow;
  return !!c && typeof c.name === "string" && Array.isArray(c.steps) &&
    c.steps.every((s) => s && typeof s.action === "string" && typeof s.label === "string");
}
const importFileEl = $("importfile") as HTMLInputElement;
$("import").onclick = () => importFileEl.click();
importFileEl.onchange = async () => {
  const file = importFileEl.files?.[0];
  importFileEl.value = "";
  if (!file) return;
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch (_) { alert("Import failed: not valid JSON."); return; }
  if (!isImportable(parsed)) { alert("Import failed: not a Bao workflow file."); return; }
  const res = await sw({ cmd: "bao-wf-import", workflow: parsed });
  await refresh();
  if (res?.id) openDetail(res.id);
};

// ---------------------------- boot ----------------------------
(async () => {
  searchEl.oninput = () => { query = searchEl.value; renderList(); };
  chrome.storage.local.onChanged.addListener((ch) => {
    if (ch.baoWorkflows) {
      refresh();
      // Don't clobber an in-progress edit with a background refresh.
      if (currentId && !editing) sw({ cmd: "bao-wf-get", id: currentId }).then((wf: Workflow | null) => {
        if (wf && currentId === wf.id && !editing) { currentWf = wf; renderDetail(); }
      });
    }
    // A run finishing flips baoRun to done/failed and writes a history record; refresh
    // the open workflow's history so the new run appears without a manual reload.
    if (ch.baoRun) {
      const run = ch.baoRun.newValue as RunState | undefined;
      if (currentId && (!run || run.phase === "done" || run.phase === "failed")) loadHistory(currentId);
    }
  });
  await refresh();
})();
