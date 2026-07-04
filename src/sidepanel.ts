// Bao T15 — side panel (replaces the popup). The panel stays open alongside the
// page, so it can show what the popup never could: the live step feed while
// recording and live ✓/✗ progress while replaying. Three views, switched by
// toggling `hidden` on three <section>s: home (workflow library), recording
// (live feed), detail (steps + run progress). Everything renders from storage;
// the SW never knows the panel is watching (§3 of t15-sidepanel-design).
import type { Msg, RunState, Step, Workflow, WorkflowSummary } from "./types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const titleEl = $("title"), statusEl = $("status"), listEl = $("list");
const searchEl = $("search") as HTMLInputElement;
const recordBtn = $("record") as HTMLButtonElement, stopBtn = $("stop") as HTMLButtonElement;
const homeEl = $("home"), recordingEl = $("recording"), recFeedEl = $("recfeed");
const detailEl = $("detail"), dnameEl = $("dname"), dmetaEl = $("dmeta");
const drunBtn = $("drun") as HTMLButtonElement, dpinBtn = $("dpin") as HTMLButtonElement;
const ddeleteBtn = $("ddelete") as HTMLButtonElement, dstepsEl = $("dsteps"), dsummaryEl = $("dsummary");
const toastEl = $("toast"), toastMsg = $("toastmsg"), undoBtn = $("undo") as HTMLButtonElement;

// Record/replay are SW-owned (M1): the panel only sends commands and renders state.
const sw = (msg: Msg) => chrome.runtime.sendMessage(msg);
async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id!;
}
async function contentAlive(): Promise<boolean> {
  try { return !!(await chrome.tabs.sendMessage(await activeTabId(), { cmd: "status" })); }
  catch (_) { return false; }
}

// ---------------------------- view state ----------------------------
type View = "home" | "recording" | "detail";
let view: View = "home";
let detailWf: Workflow | null = null;  // detail view's workflow (null when rendering a bare run)
let detailRun: RunState | null = null; // last-seen RunState, overlays the detail step list
let stopping = false;                  // this panel initiated the stop (suppresses the listener's exit)

function showView(v: View): void {
  view = v;
  homeEl.hidden = v !== "home";
  recordingEl.hidden = v !== "recording";
  detailEl.hidden = v !== "detail";
  if (v === "recording") {
    titleEl.innerHTML = '<span class="rec"><span class="dot">●</span> Recording…</span>';
  } else {
    titleEl.textContent = "Bao";
  }
  recordBtn.hidden = v === "recording";
  stopBtn.hidden = v !== "recording";
}

const stepLabel = (s: Step) => `${s.label}${s.value ? ` = "${s.value}"` : ""}`;
const domainOf = (u: string) => { try { return new URL(u).hostname || "other"; } catch (_) { return "other"; } };
const dateFmt = (ts: number) =>
  new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return dateFmt(ts);
}

function setStatus(text: string): void {
  statusEl.hidden = !text;
  statusEl.textContent = text;
}

// ---------------------------- home view ----------------------------
let summaries: WorkflowSummary[] = [];
let query = "";
const collapsed = new Set<string>(); // in-memory only — resets on panel reopen (§3)
// Optimistic delete (§3): the card vanishes immediately, the real bao-wf-delete
// fires when the undo window expires (or the panel closes). Undo cancels the timer.
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
const UNDO_MS = 5000;

async function refresh(): Promise<void> {
  summaries = (await sw({ cmd: "bao-wf-list" })) || [];
  render();
}

function visible(): WorkflowSummary[] {
  const q = query.trim().toLowerCase();
  return summaries.filter((w) => !pendingDeletes.has(w.id) &&
    (!q || w.name.toLowerCase().includes(q) || domainOf(w.startUrl).toLowerCase().includes(q)));
}

function render(): void {
  const items = visible();
  listEl.textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query.trim() ? "No matches." : "No workflows yet — hit ● Record.";
    listEl.appendChild(empty);
    return;
  }
  const pinned = items.filter((w) => w.pinned).sort((a, b) => b.createdAt - a.createdAt);
  if (pinned.length) {
    listEl.appendChild(groupHeader("📌 Pinned", pinned.length, null));
    if (!collapsed.has(" pinned")) for (const w of pinned) listEl.appendChild(card(w));
  }
  // Site groups ordered by their newest workflow; newest-first inside (§4).
  const groups = new Map<string, WorkflowSummary[]>();
  for (const w of items.filter((w) => !w.pinned)) {
    const d = domainOf(w.startUrl);
    (groups.get(d) || groups.set(d, []).get(d)!).push(w);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((w) => w.createdAt)) - Math.max(...a[1].map((w) => w.createdAt)));
  for (const [domain, ws] of ordered) {
    listEl.appendChild(groupHeader(domain, ws.length, domain));
    if (collapsed.has(domain)) continue;
    for (const w of ws.sort((a, b) => b.createdAt - a.createdAt)) listEl.appendChild(card(w));
  }
}

// key === null → the pinned section (collapsible under a sentinel key).
function groupHeader(label: string, n: number, key: string | null): HTMLElement {
  const k = key ?? " pinned";
  const h = document.createElement("div");
  h.className = "group-h";
  h.textContent = `${collapsed.has(k) ? "▸" : "▾"} ${label} `;
  const count = document.createElement("span");
  count.className = "n";
  count.textContent = `(${n})`;
  h.appendChild(count);
  h.onclick = () => { collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); render(); };
  return h;
}

function card(w: WorkflowSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = "card";

  const body = document.createElement("div");
  body.className = "body";
  body.onclick = () => openDetail(w.id);
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = w.name;
  name.title = w.startUrl;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${w.count} steps · ${relTime(w.createdAt)}`;
  body.append(name, meta);

  // Run from a card goes through the detail view (§3): one codepath for progress,
  // and the user always sees what's happening.
  const play = document.createElement("button");
  play.textContent = "▶";
  play.title = "Run";
  play.onclick = async (e) => { e.stopPropagation(); await openDetail(w.id); runDetail(); };

  const menu = document.createElement("div");
  menu.className = "menu";
  const dots = document.createElement("button");
  dots.textContent = "⋯";
  dots.title = "More";
  menu.appendChild(dots);
  dots.onclick = (e) => {
    e.stopPropagation();
    closeMenus();
    const pop = document.createElement("div");
    pop.className = "menu-pop";
    pop.append(
      menuItem("Rename", () => startRename(name, w)),
      menuItem(w.pinned ? "Unpin" : "Pin", async () => {
        await sw({ cmd: "bao-wf-update", id: w.id, patch: { pinned: !w.pinned } });
        await refresh();
      }),
      menuItem("Export JSON", () => exportWorkflow(w.id)),
      menuItem("Delete", () => deleteWithUndo(w)),
    );
    menu.appendChild(pop);
  };

  el.append(body, play, menu);
  return el;
}

function menuItem(label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); closeMenus(); fn(); };
  return b;
}
const closeMenus = () => document.querySelectorAll(".menu-pop").forEach((p) => p.remove());
document.addEventListener("click", closeMenus);

// Inline rename (home card): the name row becomes an input, pre-selected;
// Enter/blur commits, Escape keeps the old name.
function startRename(nameEl: HTMLElement, w: WorkflowSummary): void {
  const input = document.createElement("input");
  input.value = w.name;
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (name && name !== w.name) await sw({ cmd: "bao-wf-update", id: w.id, patch: { name } });
    await refresh();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; render(); }
  };
}

// ---------------------------- delete + undo toast ----------------------------
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let undoFn: (() => void) | null = null;

function showToast(msg: string, onUndo: (() => void) | null): void {
  toastMsg.textContent = msg;
  undoBtn.hidden = !onUndo;
  undoFn = onUndo;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, UNDO_MS);
}
undoBtn.onclick = () => { toastEl.hidden = true; undoFn?.(); undoFn = null; };

function deleteWithUndo(w: { id: string; name: string }): void {
  const timer = setTimeout(() => {
    pendingDeletes.delete(w.id);
    sw({ cmd: "bao-wf-delete", id: w.id }).then(refresh);
  }, UNDO_MS);
  pendingDeletes.set(w.id, timer);
  render();
  showToast(`Deleted "${w.name}"`, () => {
    const t = pendingDeletes.get(w.id);
    if (t) clearTimeout(t);
    pendingDeletes.delete(w.id);
    render();
  });
}
// Panel closing commits any still-pending deletes (best-effort — sendMessage from
// pagehide usually lands since the SW outlives the page).
window.addEventListener("pagehide", () => {
  for (const id of pendingDeletes.keys()) chrome.runtime.sendMessage({ cmd: "bao-wf-delete", id });
});

// ---------------------------- recording view ----------------------------
// Live feed for free: every recorded step already lands in session storage under
// baoRec (background.ts onRecStep), and the panel is a trusted extension context,
// so it just subscribes. The SW doesn't know the panel is watching.
function renderRecFeed(steps: Step[]): void {
  recFeedEl.textContent = "";
  const sorted = steps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  sorted.forEach((s, i) => {
    const row = document.createElement("div");
    row.textContent = `${i + 1}. ${stepLabel(s)}`;
    recFeedEl.appendChild(row);
  });
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  cursor.textContent = "▊";
  recFeedEl.appendChild(cursor);
}

recordBtn.onclick = async () => {
  if (!(await contentAlive())) {
    setStatus("Can't record this page (try a normal http page).");
    return;
  }
  setStatus("");
  await sw({ cmd: "bao-rec-start", tabId: await activeTabId() });
  showView("recording");
  renderRecFeed([]);
};

// Stop → SW auto-saves (T15 §2) → land in the detail view with the generated name
// in inline-edit mode, pre-selected, so typing replaces it. Zero-step stop → home
// with a "Nothing captured" toast.
stopBtn.onclick = async () => {
  stopping = true;
  const { workflow } = await sw({ cmd: "bao-rec-stop" });
  stopping = false;
  if (workflow) {
    await openDetail(workflow.id, { rename: true });
  } else {
    showView("home");
    showToast("Nothing captured.", null);
  }
  refresh();
};

// ---------------------------- detail view ----------------------------
async function openDetail(id: string, opts: { rename?: boolean } = {}): Promise<void> {
  detailWf = await sw({ cmd: "bao-wf-get", id });
  if (!detailWf) { showView("home"); return; }
  if (!runMatchesDetail()) detailRun = null; // a stale run for another workflow isn't progress here
  showView("detail");
  renderDetail();
  if (opts.rename) startDetailRename();
}

// Boot found an active run (§5): render it as a detail view. RunState.steps is
// embedded so no lookup is strictly needed, but step ids carry the workflow id
// ("wf-xxxxxxxx-3"), so recover the full workflow (name, meta) when we can.
async function enterDetailForRun(run: RunState): Promise<void> {
  detailRun = run;
  const wfId = run.steps[0]?.id?.match(/^(wf-[a-z0-9]+)-\d+$/)?.[1];
  detailWf = wfId ? await sw({ cmd: "bao-wf-get", id: wfId }) : null;
  showView("detail");
  renderDetail();
}

// The run overlay only applies if the RunState's steps are the detail workflow's
// (matched on the first step's stable id; a bare bao-run-start trace has no ids).
function runMatchesDetail(): boolean {
  if (!detailRun) return false;
  if (!detailWf) return true;
  const runId0 = detailRun.steps[0]?.id;
  return !!runId0 && runId0 === detailWf.steps[0]?.id;
}

function renderDetail(): void {
  const wf = detailWf;
  renderDetailName();
  dpinBtn.hidden = ddeleteBtn.hidden = drunBtn.hidden = ($("dexport") as HTMLButtonElement).hidden = !wf;
  if (wf) {
    dmetaEl.textContent =
      `${domainOf(wf.startUrl)} · ${wf.steps.length} steps · created ${dateFmt(wf.createdAt)}`;
    dpinBtn.textContent = wf.pinned ? "📌 Unpin" : "📌 Pin";
  } else {
    dmetaEl.textContent = detailRun ? `${detailRun.steps.length} steps` : "";
  }
  renderDetailSteps();
}

function renderDetailName(): void {
  dnameEl.textContent = "";
  const txt = document.createElement("div");
  txt.className = "txt";
  txt.textContent = detailWf?.name ?? "Run in progress";
  const edit = document.createElement("button");
  edit.className = "edit";
  edit.textContent = "✏️";
  edit.title = "Rename";
  if (detailWf) {
    txt.onclick = edit.onclick = () => startDetailRename();
    dnameEl.append(txt, edit);
  } else {
    dnameEl.append(txt);
  }
}

// Inline rename in the detail header. Pre-selected so typing replaces the
// generated auto-save name; Enter/blur commits, Escape keeps it.
function startDetailRename(): void {
  const wf = detailWf;
  if (!wf) return;
  dnameEl.textContent = "";
  const input = document.createElement("input");
  input.value = wf.name;
  dnameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (name && name !== wf.name) {
      await sw({ cmd: "bao-wf-update", id: wf.id, patch: { name } });
      wf.name = name;
      refresh();
    }
    renderDetailName();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; renderDetailName(); }
  };
}

const ACTIVE_PHASES = ["executing", "awaiting_nav", "awaiting_download", "paused_for_user"];

// The step list doubles as the run progress surface (§3): ✓ done, ▶ current with
// a spinner, ⏸ + Continue when paused_for_user, ✗ + reason on failure (kept
// rendered — it IS the failure report), dimmed pending rows.
function renderDetailSteps(): void {
  const run = runMatchesDetail() ? detailRun : null;
  const steps = detailWf?.steps ?? run?.steps ?? [];
  dstepsEl.textContent = "";
  dsummaryEl.hidden = true;
  drunBtn.disabled = !!(run && ACTIVE_PHASES.includes(run.phase));

  steps.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "srow";
    const mark = document.createElement("span");
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = `${i + 1}. ${stepLabel(s)}`;
    row.append(mark, lbl);

    if (run) {
      const okHere = run.results.some((r) => r.i === i && r.ok);
      if (okHere) {
        row.classList.add("done"); mark.textContent = "✓";
      } else if (run.phase === "failed" && run.lastError?.stepIndex === i) {
        row.classList.add("fail"); mark.textContent = "✗";
        const why = document.createElement("span");
        why.className = "why";
        why.textContent = run.lastError.reason;
        row.appendChild(why);
      } else if (i === run.stepIndex && run.phase === "paused_for_user") {
        row.classList.add("cur"); mark.textContent = "⏸";
        const cont = document.createElement("button");
        cont.textContent = "Continue";
        cont.onclick = () => sw({ cmd: "bao-run-continue" });
        row.appendChild(cont);
      } else if (i === run.stepIndex && ACTIVE_PHASES.includes(run.phase)) {
        row.classList.add("cur"); mark.textContent = "▶";
        const spin = document.createElement("span");
        spin.className = "spin";
        spin.textContent = "⟳";
        row.appendChild(spin);
      } else {
        row.classList.add("pend"); mark.textContent = "·";
      }
    } else {
      mark.textContent = " ";
    }
    dstepsEl.appendChild(row);
  });

  if (run?.phase === "done") {
    dsummaryEl.textContent = `✓ Replayed ${run.steps.length} steps.`;
    dsummaryEl.hidden = false;
  }
}

async function runDetail(): Promise<void> {
  if (!detailWf) return;
  detailRun = null;
  renderDetailSteps();
  await sw({ cmd: "bao-wf-run", tabId: await activeTabId(), id: detailWf.id });
}
drunBtn.onclick = runDetail;
$("dback").onclick = () => { detailWf = null; showView("home"); render(); };
dpinBtn.onclick = async () => {
  if (!detailWf) return;
  await sw({ cmd: "bao-wf-update", id: detailWf.id, patch: { pinned: !detailWf.pinned } });
  detailWf.pinned = !detailWf.pinned;
  renderDetail();
  refresh();
};
ddeleteBtn.onclick = () => {
  if (!detailWf) return;
  const wf = detailWf;
  detailWf = null;
  showView("home");
  deleteWithUndo(wf);
};

// ---------------------------- import / export (§6) ----------------------------
// Export is exactly the stored Workflow shape — directly usable by the harness
// tooling (test/run.mjs consumes `steps`), a deliberate bridge.
const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";

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
$("dexport").onclick = () => { if (detailWf) exportWorkflow(detailWf.id); };

// Minimal validation, no silent partial imports (§6): name + steps with
// action/label or the whole file is rejected. The SW assigns the fresh id.
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
  try { parsed = JSON.parse(await file.text()); } catch (_) {
    showToast("Import failed: not valid JSON.", null);
    return;
  }
  if (!isImportable(parsed)) {
    showToast("Import failed: not a Bao workflow file.", null);
    return;
  }
  const res = await sw({ cmd: "bao-wf-import", workflow: parsed });
  showToast(res?.ok ? `Imported "${parsed.name}".` : "Import failed.", null);
  refresh();
};

// ---------------------------- record availability ----------------------------
// Record is disabled (with a tooltip) on pages the content script can't reach —
// chrome://, the web store, etc. Re-checked when the active tab changes or loads.
async function updateRecordAvail(): Promise<void> {
  const alive = await contentAlive();
  recordBtn.disabled = !alive;
  recordBtn.title = alive ? "" : "Can't record on this page (chrome:// etc.)";
}
chrome.tabs.onActivated.addListener(() => { updateRecordAvail(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") updateRecordAvail(); });

// ---------------------------- boot (§5) ----------------------------
(async () => {
  // Storage listeners first, so nothing lands between the initial read and the wire-up.
  chrome.storage.session.onChanged.addListener((ch) => {
    if (!ch.baoRec) return;
    const rec = ch.baoRec.newValue as { steps?: Step[] } | undefined;
    if (rec) {
      if (view !== "recording") showView("recording");
      renderRecFeed(rec.steps ?? []);
    } else if (view === "recording" && !stopping) {
      // Recording ended elsewhere (another window's panel); this one goes home.
      showView("home");
      refresh();
    }
  });
  chrome.storage.local.onChanged.addListener((ch) => {
    if (ch.baoWorkflows) refresh(); // multi-window consistency for free (§4)
    if (ch.baoRun) {
      detailRun = (ch.baoRun.newValue as RunState | undefined) ?? null;
      if (view === "detail") renderDetailSteps();
    }
  });
  searchEl.oninput = () => { query = searchEl.value; render(); };

  const rec = (await chrome.storage.session.get("baoRec")).baoRec as { steps?: Step[] } | undefined;
  if (rec) {
    showView("recording");
    renderRecFeed(rec.steps ?? []); // opened mid-recording: backfill the feed
  } else {
    const run = (await chrome.storage.local.get("baoRun")).baoRun as RunState | undefined;
    if (run && ACTIVE_PHASES.includes(run.phase)) await enterDetailForRun(run);
    else showView("home");
  }
  await refresh();
  updateRecordAvail();
})();
