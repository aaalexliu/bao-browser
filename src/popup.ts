import type { Msg, RunState, Step, WorkflowSummary } from "./types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusEl = $("status"), stepsEl = $("steps"), continueBtn = $("continue");
const saveRow = $("saverow"), nameInput = $("wfname") as HTMLInputElement, listEl = $("list");

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id!;
}
// Record/replay are SW-owned (M1): the state machine survives navigations and SW
// death, so the popup only sends commands and renders status.
const sw = (msg: Msg) => chrome.runtime.sendMessage(msg);
async function contentAlive(): Promise<boolean> {
  try { return !!(await chrome.tabs.sendMessage(await activeTabId(), { cmd: "status" })); }
  catch (_) { return false; }
}

// The just-recorded, not-yet-saved trace (T14: you name it, then it becomes a Workflow).
let pendingSteps: Step[] = [];

function renderSteps(steps: Step[], note?: string): void {
  stepsEl.textContent = (steps || [])
    .map((s, i) => `${i + 1}. ${s.label}${s.value ? ` = "${s.value}"` : ""}`)
    .join("\n") || "";
  if (note) statusEl.textContent = note;
}

function startUrlOf(steps: Step[]): string {
  return steps.find((s) => s.frame?.url)?.frame?.url || "";
}

$("record").onclick = async () => {
  if (!(await contentAlive())) {
    statusEl.textContent = "No content script on this page (try a normal http page).";
    return;
  }
  saveRow.style.display = "none";
  await sw({ cmd: "bao-rec-start", tabId: await activeTabId() });
  statusEl.innerHTML = '<span class="rec">● recording…</span> interact, then Stop';
  stepsEl.textContent = "";
};
$("stop").onclick = async () => {
  const { steps } = await sw({ cmd: "bao-rec-stop" });
  pendingSteps = steps || [];
  renderSteps(pendingSteps, `Captured ${pendingSteps.length} steps — name & save it.`);
  saveRow.style.display = pendingSteps.length ? "" : "none";
  nameInput.focus();
};
$("save").onclick = async () => {
  if (!pendingSteps.length) return;
  const name = nameInput.value.trim() || "Untitled workflow";
  await sw({ cmd: "bao-wf-save", name, startUrl: startUrlOf(pendingSteps), steps: pendingSteps });
  pendingSteps = [];
  nameInput.value = "";
  saveRow.style.display = "none";
  statusEl.textContent = `Saved "${name}".`;
  stepsEl.textContent = "";
  await refreshList();
};
continueBtn.onclick = async () => {
  await sw({ cmd: "bao-run-continue" });
  continueBtn.style.display = "none";
  statusEl.textContent = "Resumed…";
  pollRun();
};

async function refreshList(): Promise<void> {
  const wfs: WorkflowSummary[] = await sw({ cmd: "bao-wf-list" });
  listEl.textContent = "";
  if (!wfs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No saved workflows yet.";
    listEl.appendChild(empty);
    return;
  }
  for (const wf of wfs) {
    const row = document.createElement("div");
    row.className = "wf";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = wf.name;
    name.title = wf.startUrl;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${wf.count}`;

    const play = document.createElement("button");
    play.textContent = "▶";
    play.title = "Replay";
    play.onclick = async () => {
      statusEl.textContent = `Replaying "${wf.name}"…`;
      await sw({ cmd: "bao-wf-run", tabId: await activeTabId(), id: wf.id });
      pollRun();
    };

    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete";
    del.onclick = async () => { await sw({ cmd: "bao-wf-delete", id: wf.id }); await refreshList(); };

    row.append(name, count, play, del);
    listEl.appendChild(row);
  }
}

let polling = false;
async function pollRun(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const run: RunState | null = await sw({ cmd: "bao-run-status" });
      if (!run) return;
      if (run.phase === "done") { statusEl.textContent = `✓ Replayed ${run.steps.length} steps.`; return; }
      if (run.phase === "failed") {
        statusEl.textContent = `✗ Failed at step ${run.lastError!.stepIndex + 1}: ${run.lastError!.reason}`;
        return;
      }
      if (run.phase === "paused_for_user") {
        const label = run.steps[run.stepIndex]?.label || "waiting for you";
        statusEl.textContent = `⏸ Paused: ${label} — do it, then Continue.`;
        continueBtn.style.display = "";
        return; // continue button re-enters the poll
      }
      statusEl.textContent = `Replaying… (step ${run.stepIndex + 1}/${run.steps.length}, ${run.phase})`;
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    polling = false;
  }
}

// reflect current state on open
(async () => {
  await refreshList();
  const run: RunState | null = await sw({ cmd: "bao-run-status" });
  if (run && ["executing", "awaiting_nav", "awaiting_download", "paused_for_user"].includes(run.phase)) pollRun();
  try {
    const st = await chrome.tabs.sendMessage(await activeTabId(), { cmd: "status" });
    if (st && st.recording) statusEl.innerHTML = '<span class="rec">● recording…</span>';
  } catch (_) {}
})();
