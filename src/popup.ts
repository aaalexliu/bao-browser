import type { Msg, RunState, Step } from "./types";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusEl = $("status"), stepsEl = $("steps"), continueBtn = $("continue");

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id!;
}
// Record/replay are SW-owned now (M1): the state machine survives navigations and
// SW death, so the popup only sends commands and renders status.
const sw = (msg: Msg) => chrome.runtime.sendMessage(msg);
async function contentAlive(): Promise<boolean> {
  try { return !!(await chrome.tabs.sendMessage(await activeTabId(), { cmd: "status" })); }
  catch (_) { return false; }
}

function render(steps: Step[] | undefined, note?: string): void {
  stepsEl.textContent = (steps || [])
    .map((s, i) => `${i + 1}. ${s.label}${s.value ? ` = "${s.value}"` : ""}`)
    .join("\n") || "(no steps yet)";
  if (note) statusEl.textContent = note;
}

$("record").onclick = async () => {
  if (!(await contentAlive())) {
    statusEl.textContent = "No content script on this page (try a normal http page).";
    return;
  }
  await sw({ cmd: "bao-rec-start", tabId: await activeTabId() });
  statusEl.innerHTML = '<span class="rec">● recording…</span> interact with the page (navigations are fine), then Stop';
  stepsEl.textContent = "";
};
$("stop").onclick = async () => {
  const { steps } = await sw({ cmd: "bao-rec-stop" });
  await chrome.storage.local.set({ steps });
  render(steps, `Captured ${steps.length} steps.`);
};
$("replay").onclick = async () => {
  const { steps } = (await chrome.storage.local.get("steps")) as { steps?: Step[] };
  if (!steps || !steps.length) return void (statusEl.textContent = "Nothing recorded yet.");
  statusEl.textContent = "Replaying…";
  await sw({ cmd: "bao-run-start", tabId: await activeTabId(), steps });
  pollRun();
};
continueBtn.onclick = async () => {
  await sw({ cmd: "bao-run-continue" });
  continueBtn.style.display = "none";
  statusEl.textContent = "Resumed…";
  pollRun();
};
$("clear").onclick = async () => {
  await chrome.storage.local.remove("steps");
  render([], "Cleared.");
};

let polling = false;
async function pollRun(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const run: RunState | null = await sw({ cmd: "bao-run-status" });
      if (!run) return;
      if (run.phase === "done") {
        statusEl.textContent = `✓ Replayed ${run.steps.length} steps.`;
        return;
      }
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
  const { steps } = (await chrome.storage.local.get("steps")) as { steps?: Step[] };
  render(steps);
  const run: RunState | null = await sw({ cmd: "bao-run-status" });
  if (run && ["executing", "awaiting_nav", "paused_for_user"].includes(run.phase)) pollRun();
  try {
    const st = await chrome.tabs.sendMessage(await activeTabId(), { cmd: "status" });
    if (st && st.recording) statusEl.innerHTML = '<span class="rec">● recording…</span>';
  } catch (_) {}
})();
