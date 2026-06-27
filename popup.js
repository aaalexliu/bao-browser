const $ = (id) => document.getElementById(id);
const statusEl = $("status"), stepsEl = $("steps");

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id;
}
async function send(msg) {
  try { return await chrome.tabs.sendMessage(await activeTabId(), msg); }
  catch (e) { statusEl.textContent = "No content script on this page (try a normal http page)."; throw e; }
}

function render(steps, note) {
  stepsEl.textContent = (steps || [])
    .map((s, i) => `${i + 1}. ${s.label}${s.value ? ` = "${s.value}"` : ""}`)
    .join("\n") || "(no steps yet)";
  if (note) statusEl.textContent = note;
}

$("record").onclick = async () => {
  await send({ cmd: "start-record" });
  statusEl.innerHTML = '<span class="rec">● recording…</span> interact with the page, then Stop';
  stepsEl.textContent = "";
};
$("stop").onclick = async () => {
  const { steps } = await send({ cmd: "stop-record" });
  await chrome.storage.local.set({ steps });
  render(steps, `Captured ${steps.length} steps.`);
};
$("replay").onclick = async () => {
  const { steps } = await chrome.storage.local.get("steps");
  if (!steps || !steps.length) return (statusEl.textContent = "Nothing recorded yet.");
  statusEl.textContent = "Replaying…";
  const res = await send({ cmd: "replay", steps });
  statusEl.textContent = res.ok
    ? `✓ Replayed ${steps.length} steps.`
    : `✗ Failed at step ${res.failedAt + 1}: ${res.results.at(-1).reason}`;
};
$("clear").onclick = async () => {
  await chrome.storage.local.remove("steps");
  render([], "Cleared.");
};

// reflect current state on open
(async () => {
  const { steps } = await chrome.storage.local.get("steps");
  render(steps);
  try {
    const st = await send({ cmd: "status" });
    if (st && st.recording) statusEl.innerHTML = '<span class="rec">● recording…</span>';
  } catch (_) {}
})();
