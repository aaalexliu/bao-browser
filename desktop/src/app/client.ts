// Desktop window. Talks only to this machine's bao server.

import { formatWait } from "../v1/human-ask";
import { trajectoryFromWorkflow } from "../v1/trajectory";
import type { WorkflowV2 } from "../v1/schema";
import {
  actBar,
  commandItems,
  esc,
  healDetail,
  healInbox,
  healWorkflowName,
  importCard,
  inputsPane,
  libraryTable,
  liveStepList,
  notices,
  onboarding,
  paletteView,
  rail,
  recordBar,
  runsList,
  runViewer,
  trailPane,
  workflowDetail,
  type CommandItem,
  type HealView,
  type ImportPending,
  type RunSummary,
  type ShellState,
  type WorkflowSummary,
} from "./views";

type Screen = "library" | "capture" | "runs" | "heals" | "settings" | "replay" | "run";

let state: ShellState & {
  notices?: { title?: string; body?: string }[];
  settings?: { heal?: string };
  trails?: string[];
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
} = {};
let screen: Screen = "library";
let lastWf = "";
let argsWorkflow = "";
let healFilter: "pending" | "kept" | "reverted" = "pending";
let openHeal: { runId: string; healId: string } | null = null;
let openRun = "";
let selectedStep = "";
let banner: { title: string; body: string } | null = null;
let renderKey = "";
let notified = "";
let libraryQuery = "";
let paletteOpen = false;
let paletteQuery = "";
let paletteActive = 0;
let onboarded = false;
let theme: "light" | "dark" = "light";
try {
  onboarded = localStorage.getItem("bao-onboarded") === "1";
  theme = localStorage.getItem("bao-theme") === "dark" ? "dark" : "light";
} catch { /* private mode */ }
const shotCache = new Map<string, { steps: Record<string, string>; any: string }>();

const railEl = () => document.getElementById("rail")!;
const actEl = () => document.getElementById("act")!;
const mainEl = () => document.getElementById("main")!;

async function refresh(): Promise<void> {
  state = await (await fetch("/api/state")).json();
  const key = JSON.stringify({
    recording: state.recording,
    pending: state.pendingImport,
    ask: state.activeAsk,
    notices: state.notices,
    workflows: state.workflows,
    settings: state.settings,
    runs: (state.runs || []).map((run) => ({ id: run.id, status: run.status, decisions: run.decisions, heals: (run.heals || []).map((heal) => heal.id) })),
    helper: state.helper,
    model: state.model,
    paused: state.capturePaused,
    since: state.recordingSince,
    promotions: state.promotions,
    screen,
    healFilter,
    openHeal,
    openRun,
    selectedStep,
    banner,
  });
  noteAsk();
  paintLive();
  if (key === renderKey) return;
  renderKey = key;
  render();
}

function noteAsk(): void {
  const ask = state.activeAsk;
  const id = ask ? `${ask.kind}:${ask.stepId}:${ask.startedAt}` : state.pendingImport?.phase === "confirm" ? `import:${state.pendingImport.id}` : "";
  if (!id || id === notified) return;
  notified = id;
  const title = "You need to act";
  const body = ask?.instruction || (state.pendingImport?.domain ? `Import cookies for ${state.pendingImport.domain}` : "");
  if (body && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

function render(): void {
  applyTheme();
  railEl().innerHTML = rail(state);
  actEl().innerHTML = actBar(state) + importCard(state.pendingImport as ImportPending);
  const onboard = document.getElementById("onboard");
  if (onboard) onboard.innerHTML = onboarded ? "" : onboarding(state.helper);
  const float = document.getElementById("float");
  if (float) float.innerHTML = recordBar(state);
  const replayId = lastWf || (state.workflows && state.workflows[0]?.id) || "";
  const openArgs = document.getElementById("args");
  const keepReplay = screen === "replay" && openArgs !== null && openArgs.childElementCount > 0 && argsWorkflow === replayId;
  if (!keepReplay) {
    const body = screen === "capture" ? capture()
      : screen === "runs" ? runsList(state.runs || [], state.workflows || [])
      : screen === "run" ? `<section id="run-host"><p class="quiet">Loading run…</p></section>`
      : screen === "heals" ? healInbox(state.runs || [], state.workflows || [], healFilter)
      : screen === "settings" ? settings()
      : screen === "replay" ? replayForm()
      : libraryTable(state.workflows || [], state.runs || [], state.promotions || []);
    const typingSearch = document.activeElement?.id === "library-search";
    const caret = typingSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
    mainEl().innerHTML = notices(banner ? [banner, ...(state.notices || [])] : (state.notices || [])) + body;
    const search = document.getElementById("library-search") as HTMLInputElement | null;
    if (search) search.value = libraryQuery;
    if (typingSearch && search) {
      search.focus();
      if (caret != null) search.setSelectionRange(caret, caret);
    }
    if (screen === "replay") void fillArgs(replayId);
  }
  markNav();
  bind();
  applySearch();
  paintPalette();
  paintLive();
  void paintThumbs();
  if (screen === "run" && openRun) void showRun(openRun);
  if (screen === "heals" && openHeal) void showHeal(openHeal.runId, openHeal.healId);
}

function markNav(): void {
  const current = screen === "replay" || screen === "run" ? "runs" : screen;
  document.querySelectorAll("#rail nav button").forEach((btn) => {
    const el = btn as HTMLButtonElement;
    el.classList.toggle("on", el.dataset.screen === current);
  });
}

function capture(): string {
  const ids = (state.trails || []).map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join("");
  return `<section>
    <h2>Capture</h2>
    <p class="quiet">Nothing is recorded until you start. The capture browser uses an app-owned profile, not your daily Chrome.</p>
    <div class="card">
      <h3>Browser</h3>
      <label>Start URL <input id="start-url" value="${location.origin}/fixture"></label>
      <div class="row"><button class="primary" id="start" type="button">Start capture</button><button id="stop" type="button">Stop and save</button></div>
    </div>
    <div class="card">
      <h3>Mac app</h3>
      <p>On macOS the helper is <code>Bao.app/Contents/Resources/BaoOSHelper.app</code> (bundle <code>dev.bao.oshelper</code>). On Linux the AT-SPI helper is <code>bao-os-helper</code>.</p>
    </div>
    <div class="card">
      <h3>Proxy and MCP</h3>
      <p>MCP is a stdio process, <code>bao mcp</code>. It records screenshot, click, type, key, and scroll into the local trail. No call leaves the machine unless you set a model key for healing.</p>
    </div>
    <div class="card">
      <h3>Steps</h3>
      <div id="live-steps"></div>
    </div>
    <div class="card" id="trail-tab">
      <h3>Trail</h3>
      <p class="quiet">Trail is the evidence for a capture, not a place in the sidebar.</p>
      <label>Trail <select id="trail-id">${ids}</select></label>
      <button id="load-trail" type="button">Load</button>
      <pre id="trail-view">Password values are not stored.</pre>
    </div>
  </section>`;
}

function replayForm(): string {
  const selected = lastWf || (state.workflows && state.workflows[0]?.id) || "";
  const current = (state.workflows || []).find((workflow) => workflow.id === selected);
  const mode = (current && current.heal) || "";
  const globalHeal = (state.settings && state.settings.heal) || "auto";
  const options = (state.workflows || []).map((workflow) =>
    `<option value="${esc(workflow.id)}" ${workflow.id === selected ? "selected" : ""}>${esc(workflow.name)}</option>`).join("");
  return `<section id="run-form"><h2>Run ${esc(current?.name || "")}</h2>
    <p class="lede">Inputs are asked once, before the run. Secrets stay masked.</p>
    <label>Workflow <select id="wf">${options}</select></label>
    <label>Healing for this workflow <select id="wf-heal">
      <option value="" ${mode === "" ? "selected" : ""}>Use the global setting (${esc(globalHeal)})</option>
      <option value="auto" ${mode === "auto" ? "selected" : ""}>Auto self-heal</option>
      <option value="approve" ${mode === "approve" ? "selected" : ""}>Approve before applying</option>
    </select></label>
    <form id="args"></form>
    <button class="primary" id="run" type="button">Run</button>
    <div id="live"></div>
  </section>`;
}

function settings(): string {
  const heal = state.settings?.heal || "auto";
  return `<section><h2>Settings</h2>
    <label>When a step misses <select id="heal">
      <option value="auto" ${heal === "auto" ? "selected" : ""}>Auto self-heal</option>
      <option value="approve" ${heal === "approve" ? "selected" : ""}>Approve before applying</option>
    </select></label>
    <p class="quiet">Auto is the default. Healing runs only when a model key is set, or when this build is started with the fixture healer. Otherwise replay stops on the failed step.</p>
    <button id="save-settings" type="button">Save</button>
    <h3>Appearance</h3>
    <label>Theme <select id="theme">
      <option value="light" ${theme === "light" ? "selected" : ""}>Light</option>
      <option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option>
    </select></label>
    <h3>Model</h3>
    <p id="settings-model">${esc(state.model?.label || "no model")}</p>
    <h3>Mac</h3>
    <p>${esc(state.helper?.label || "helper off")}</p>
    ${onboarding(state.helper).replace('id="onboarding"', 'id="settings-perms"').replace('id="onboard-done"', 'id="onboard-done-hidden" hidden')}
  </section>`;
}

function bind(): void {
  document.querySelectorAll("#rail nav button").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      screen = (btn as HTMLButtonElement).dataset.screen as Screen;
      renderKey = "";
      render();
    };
  });
  document.querySelectorAll("[data-screen=replay]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      lastWf = (btn as HTMLButtonElement).dataset.workflow || lastWf;
      screen = "replay";
      renderKey = "";
      render();
    };
  });
  document.querySelectorAll("[data-open-run]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      openRun = (btn as HTMLButtonElement).dataset.openRun || "";
      selectedStep = "";
      screen = "run";
      renderKey = "";
      render();
    };
  });
  const start = document.getElementById("start");
  if (start) start.onclick = async () => {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: (document.getElementById("start-url") as HTMLInputElement).value }),
    });
    renderKey = "";
    await refresh();
  };
  const stop = document.getElementById("stop");
  if (stop) stop.onclick = async () => {
    await fetch("/api/sessions/stop", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const load = document.getElementById("load-trail");
  if (load) load.onclick = () => loadTrail((document.getElementById("trail-id") as HTMLSelectElement).value, "");
  const wf = document.getElementById("wf") as HTMLSelectElement | null;
  if (wf) wf.onchange = () => { lastWf = wf.value; renderKey = ""; render(); };
  const wfHeal = document.getElementById("wf-heal") as HTMLSelectElement | null;
  if (wfHeal) wfHeal.onchange = async () => {
    const id = (document.getElementById("wf") as HTMLSelectElement).value;
    await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heal: wfHeal.value || null }),
    });
    renderKey = "";
    await refresh();
  };
  const run = document.getElementById("run");
  if (run) run.onclick = () => void runReplay();
  bindAsk();
  bindHeal();
  const save = document.getElementById("save-settings");
  if (save) save.onclick = async () => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heal: (document.getElementById("heal") as HTMLSelectElement).value }),
    });
    renderKey = "";
    await refresh();
  };
  document.querySelectorAll("[data-heal-filter]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      healFilter = (btn as HTMLButtonElement).dataset.healFilter as "pending" | "kept" | "reverted";
      openHeal = null;
      renderKey = "";
      render();
    };
  });
  document.querySelectorAll("[data-heal]").forEach((btn) => {
    if ((btn as HTMLButtonElement).dataset.keep || (btn as HTMLButtonElement).dataset.revert) return;
    (btn as HTMLButtonElement).onclick = () => {
      openHeal = {
        runId: (btn as HTMLButtonElement).dataset.run || "",
        healId: (btn as HTMLButtonElement).dataset.heal || "",
      };
      renderKey = "";
      render();
    };
  });
  document.querySelectorAll("[data-open-workflow]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void openEditor((btn as HTMLButtonElement).dataset.openWorkflow || "");
  });
  const search = document.getElementById("library-search") as HTMLInputElement | null;
  if (search) search.oninput = () => {
    libraryQuery = search.value;
    applySearch();
  };
  const paletteBtn = document.getElementById("palette-open");
  if (paletteBtn) paletteBtn.onclick = () => {
    paletteOpen = true;
    paletteQuery = "";
    paletteActive = 0;
    paintPalette();
  };
  const done = document.getElementById("onboard-done");
  if (done) done.onclick = () => {
    onboarded = true;
    try { localStorage.setItem("bao-onboarded", "1"); } catch { /* ignore */ }
    renderKey = "";
    render();
  };
  const themeSel = document.getElementById("theme") as HTMLSelectElement | null;
  if (themeSel) themeSel.onchange = () => {
    theme = themeSel.value === "dark" ? "dark" : "light";
    applyTheme();
  };
  const pause = document.getElementById("rec-pause");
  if (pause) pause.onclick = async () => {
    await fetch("/api/sessions/pause", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const mark = document.getElementById("rec-mark");
  if (mark) mark.onclick = async () => {
    await fetch("/api/sessions/mark", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const recStop = document.getElementById("rec-stop");
  if (recStop) recStop.onclick = async () => {
    await fetch("/api/sessions/stop", { method: "POST" });
    renderKey = "";
    await refresh();
  };
}

function bindAsk(): void {
  const show = document.getElementById("act-show");
  if (show) show.onclick = () => void fetch("/api/replay/show", { method: "POST" });
  const cancel = document.getElementById("act-cancel");
  if (cancel) cancel.onclick = () => void fetch("/api/replay/cancel", { method: "POST" });
  const cont = document.getElementById("act-continue");
  if (cont) cont.onclick = () => void fetch("/api/prompt/continue", { method: "POST" });
  const yes = document.getElementById("import-yes");
  if (yes) yes.onclick = () => void answerImport({ accept: true });
  const no = document.getElementById("import-no");
  if (no) no.onclick = () => void answerImport({ accept: false });
  document.querySelectorAll("[data-import-profile]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void answerImport({ accept: true, profile: (btn as HTMLButtonElement).dataset.importProfile });
  });
}

function bindHeal(): void {
  document.querySelectorAll("[data-keep]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void decide(btn as HTMLButtonElement, "keep");
  });
  document.querySelectorAll("[data-revert]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void decide(btn as HTMLButtonElement, "revert");
  });
}

async function decide(btn: HTMLButtonElement, decision: "keep" | "revert"): Promise<void> {
  const healId = decision === "keep" ? btn.dataset.keep : btn.dataset.revert;
  const runId = btn.dataset.run || "";
  const workflowId = btn.dataset.workflow || "";
  const run = await (await fetch("/api/runs/" + encodeURIComponent(runId))).json() as RunSummary;
  const item = (run.heals || []).find((heal) => heal.id === healId);
  if (!item || !healId) return;
  if (decision === "keep") {
    await fetch("/api/heal/keep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflowId, stepId: item.failedStep?.id, patch: item.proposedPatch, runId, healId }),
    });
  } else {
    await fetch("/api/heal/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflowId, runId, healId }),
    });
  }
  banner = {
    title: decision === "keep" ? "Patch kept" : "Patch reverted",
    body: decision === "keep" ? "Kept the heal in the saved workflow." : "Reverted the saved workflow to the failed step.",
  };
  renderKey = "";
  await refresh();
}

async function showRun(id: string): Promise<void> {
  const run = await (await fetch("/api/runs/" + encodeURIComponent(id))).json() as RunSummary;
  const workflow = await (await fetch("/api/workflows/" + encodeURIComponent(run.workflowId))).json() as { name: string; id: string; steps: { id: string; label?: string; action?: string }[] };
  const host = document.getElementById("run-host");
  if (!host || screen !== "run" || openRun !== id) return;
  const timings = (run.steps || []).map((step) => Math.max(0, (step.endedAt || 0) - (step.startedAt || 0)));
  const recorded = workflow.steps ? trajectoryFromWorkflow(workflow as unknown as WorkflowV2, timings) : [];
  const recent = (state.runs || []).filter((item) => item.workflowId === run.workflowId);
  host.innerHTML = runViewer(run, workflow, selectedStep, { recent: recent.length ? recent : [run], recorded });
  host.querySelectorAll("[data-select-step]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      selectedStep = (btn as HTMLButtonElement).dataset.selectStep || "";
      void showRun(id);
    };
  });
  host.querySelectorAll("[data-shot]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const img = document.getElementById("step-shot") as HTMLImageElement | null;
      if (!img) return;
      const which = (btn as HTMLButtonElement).dataset.shot;
      const src = which === "before" ? img.dataset.before : img.dataset.after;
      if (src) img.src = src;
    };
  });
  const scrub = host.querySelector("#scrubber") as HTMLInputElement | null;
  if (scrub) scrub.onchange = () => {
    const index = Number(scrub.value);
    const step = (run.steps || [])[index];
    if (!step) return;
    selectedStep = step.id;
    seekVideo(step.startedAt);
    void showRun(id);
  };
  host.querySelectorAll("[data-marker]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      selectedStep = (btn as HTMLButtonElement).dataset.marker || "";
      seekVideo(Number((btn as HTMLButtonElement).dataset.at || 0));
      void showRun(id);
    };
  });
  host.querySelectorAll("[data-speed]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const video = document.getElementById("run-video") as HTMLVideoElement | null;
      if (video) video.playbackRate = Number((btn as HTMLButtonElement).dataset.speed || 1);
    };
  });
  const trail = host.querySelector("[data-run-tab=trail]");
  if (trail) (trail as HTMLButtonElement).onclick = () => void loadTrail(run.workflowId, "run-extra");
  const inputs = host.querySelector("[data-run-tab=inputs]");
  if (inputs) (inputs as HTMLButtonElement).onclick = () => {
    const extra = document.getElementById("run-extra");
    if (extra) extra.innerHTML = inputsPane(run.inputs);
  };
}

async function showHeal(runId: string, healId: string): Promise<void> {
  const run = await (await fetch("/api/runs/" + encodeURIComponent(runId))).json() as RunSummary;
  const heal = (run.heals || []).find((item) => item.id === healId);
  const host = document.getElementById("heal-detail");
  if (!host || !heal || screen !== "heals") return;
  const names = new Map((state.workflows || []).map((workflow) => [workflow.id, workflow.name]));
  const promotion = (state.promotions || []).find((item) => item.healId === heal.id)
    || (run.promotion && run.promotion.healId === heal.id ? run.promotion : undefined);
  host.outerHTML = healDetail(run, heal as HealView, [], {
    workflowName: healWorkflowName(heal, run, names),
    promotion,
  });
  bindHeal();
  const slider = document.getElementById("shot-slider") as HTMLInputElement | null;
  const top = document.getElementById("compare-top") as HTMLImageElement | null;
  if (slider && top) {
    slider.oninput = () => {
      const right = 100 - Number(slider.value);
      top.style.clipPath = `inset(0 ${right}% 0 0)`;
    };
  }
}

async function loadTrail(id: string, hostId: string): Promise<void> {
  if (!id) return;
  const trail = await (await fetch("/api/trails/" + encodeURIComponent(id))).json() as { id?: string; ts?: number; op?: string; kind?: string }[];
  const html = trailPane(Array.isArray(trail) ? trail : []);
  if (hostId) {
    const host = document.getElementById(hostId);
    if (host) host.innerHTML = html;
    return;
  }
  const pre = document.getElementById("trail-view");
  if (pre) pre.outerHTML = html;
}

async function openEditor(id: string): Promise<void> {
  const doc = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json();
  const host = document.getElementById("library-extra");
  if (!host) return;
  const last = (state.runs || []).filter((run) => run.workflowId === id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  host.innerHTML = workflowDetail(doc, last?.id || "") + `<div class="card"><h3>Edit ${esc(doc.name)}</h3>
    <div class="row">
      <button type="button" data-rename="${esc(id)}">Rename</button>
      <button type="button" data-export="${esc(id)}">Export</button>
      <button type="button" data-delete="${esc(id)}">Delete</button>
    </div>
    <textarea id="edit-json" rows="14"></textarea>
    <button id="save-edit" type="button">Save steps</button>
    <h3>Import JSON</h3>
    <textarea id="import-json" rows="4"></textarea>
    <button id="import" type="button">Import JSON</button>
  </div>`;
  (document.getElementById("edit-json") as HTMLTextAreaElement).value = JSON.stringify(doc, null, 2);
  document.getElementById("save-edit")!.onclick = async () => {
    const workflow = JSON.parse((document.getElementById("edit-json") as HTMLTextAreaElement).value);
    await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
    renderKey = "";
    await refresh();
  };
  const rename = host.querySelector("[data-rename]") as HTMLButtonElement;
  rename.onclick = async () => {
    const name = prompt("Name");
    if (!name) return;
    await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    renderKey = "";
    await refresh();
  };
  const del = host.querySelector("[data-delete]") as HTMLButtonElement;
  del.onclick = async () => {
    if (!confirm("Delete this workflow?")) return;
    await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    renderKey = "";
    await refresh();
  };
  const exp = host.querySelector("[data-export]") as HTMLButtonElement;
  exp.onclick = async () => {
    const body = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json();
    (document.getElementById("import-json") as HTMLTextAreaElement).value = JSON.stringify(body, null, 2);
  };
  document.getElementById("import")!.onclick = async () => {
    await fetch("/api/workflows/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: (document.getElementById("import-json") as HTMLTextAreaElement).value,
    });
    renderKey = "";
    await refresh();
  };
  host.querySelectorAll("[data-screen=replay]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      lastWf = (btn as HTMLButtonElement).dataset.workflow || id;
      screen = "replay";
      renderKey = "";
      render();
    };
  });
  void paintThumbs();
}

async function fillArgs(id: string): Promise<void> {
  if (!id) return;
  const doc = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json() as {
    inputs: { name: string; type: string; label?: string; default?: string; choices?: string[]; multiple?: boolean }[];
  };
  const form = document.getElementById("args");
  if (!form || screen !== "replay") return;
  const last = (state.runs || []).filter((run) => run.workflowId === id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const prev = last?.inputs || {};
  form.innerHTML = doc.inputs.map((input) => field(input, prev[input.name])).join("") || "<p>This workflow has no inputs.</p>";
  argsWorkflow = id;
  form.querySelectorAll(".drop").forEach((zone) => {
    const el = zone as HTMLElement;
    el.ondragover = (event) => { event.preventDefault(); el.classList.add("over"); };
    el.ondragleave = () => el.classList.remove("over");
    el.ondrop = (event) => {
      event.preventDefault();
      el.classList.remove("over");
      const list = event.dataTransfer && event.dataTransfer.files;
      const file = list && list[0];
      const input = el.querySelector("input") as HTMLInputElement | null;
      if (input && list && list.length) {
        try { input.files = list; } catch { /* some engines reject the assignment */ }
      }
      (el as HTMLElement & { _baoFile?: File | null })._baoFile = file || null;
      const span = el.querySelector("span");
      if (span) span.textContent = file ? file.name : "Drop a file here, or choose one.";
    };
  });
}

function field(input: { name: string; type: string; label?: string; default?: string; choices?: string[]; multiple?: boolean }, previous?: string): string {
  const label = esc(input.label || input.name);
  if (input.type === "secret") {
    const hint = previous ? "Last run used a secret" : "";
    return `<label>${label} <input name="${esc(input.name)}" type="password" autocomplete="off" placeholder="${esc(hint)}"></label>`;
  }
  if (input.type === "number") return `<label>${label} <input name="${esc(input.name)}" type="number" value="${esc(previous || input.default || "")}"></label>`;
  if (input.type === "choice") {
    const opts = (input.choices || []).map((choice) => `<option ${choice === previous ? "selected" : ""}>${esc(choice)}</option>`).join("");
    return `<label>${label} <select name="${esc(input.name)}">${opts}</select></label>`;
  }
  if (input.type === "file") {
    const hint = previous ? `Last file: ${previous}. Drop a file here, or choose one.` : "Drop a file here, or choose one.";
    return `<label class="drop">${label} <input name="${esc(input.name)}" type="file" ${input.multiple ? "multiple" : ""}> <span>${esc(hint)}</span></label>`;
  }
  const text = previous && previous !== "••••" ? previous : input.default || "";
  return `<label>${label} <textarea name="${esc(input.name)}" rows="2">${esc(text)}</textarea></label>`;
}

async function runReplay(): Promise<void> {
  const wf = document.getElementById("wf") as HTMLSelectElement;
  const id = wf.value;
  lastWf = id;
  const form = document.getElementById("args")!;
  const args: Record<string, unknown> = {};
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name]")) {
    if (el instanceof HTMLInputElement && el.type === "file") {
      const zone = el.closest(".drop") as HTMLElement & { _baoFile?: File | null };
      const file = el.files?.[0] || (zone && zone._baoFile);
      if (!file) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (const byte of bytes) bin += String.fromCharCode(byte);
      args[el.name] = { name: file.name, base64: btoa(bin) };
    } else if (el instanceof HTMLInputElement && el.type === "number") args[el.name] = Number(el.value);
    else args[el.name] = el.value;
  }
  const live = document.getElementById("live");
  if (live) live.textContent = "Running…";
  const res = await fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args }),
  });
  const run = await res.json() as RunSummary & { runId?: string; error?: string };
  const runId = run.id || run.runId || "";
  if (!res.ok || !runId) {
    if (live) live.textContent = run.error || "The run did not start.";
    return;
  }
  openRun = runId;
  selectedStep = "";
  screen = "run";
  renderKey = "";
  await refresh();
}

async function answerImport(body: { accept: boolean; profile?: string }): Promise<void> {
  const pending = state.pendingImport;
  if (!pending?.id) return;
  renderKey = "";
  await fetch("/api/import-login/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pending.id, ...body }),
  });
  await refresh();
}

function tickClock(): void {
  const node = document.getElementById("act-timeout");
  if (node && node.dataset.deadline) {
    const deadline = Number(node.dataset.deadline);
    if (deadline) node.textContent = formatWait(Date.now(), deadline, node.dataset.effect || "run stops, nothing applied");
  }
  const timer = document.getElementById("rec-timer");
  if (!timer?.dataset.since) return;
  const since = Number(timer.dataset.since);
  if (!since) return;
  const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("bao-theme", theme); } catch { /* ignore */ }
}

function applySearch(): void {
  const q = libraryQuery.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>(".wf-card").forEach((card) => {
    const name = (card.querySelector("h3")?.textContent || "").toLowerCase();
    card.hidden = !!q && !name.includes(q);
  });
}

function paintLive(): void {
  const host = document.getElementById("live-steps");
  if (!host) return;
  const live = (state as ShellState & { liveTrail?: { id?: string; op?: string; kind?: string }[] }).liveTrail || [];
  const html = liveStepList(live);
  if (host.innerHTML !== html) host.innerHTML = html;
}

function filteredCommands(): CommandItem[] {
  const q = paletteQuery.trim().toLowerCase();
  return commandItems(state.workflows || []).filter((item) => !q || item.label.toLowerCase().includes(q));
}

function paintPalette(): void {
  const host = document.getElementById("palette");
  if (!host) return;
  host.toggleAttribute("hidden", !paletteOpen);
  if (!paletteOpen) {
    host.innerHTML = "";
    return;
  }
  const had = document.activeElement?.id === "palette-input";
  const pos = had ? (document.activeElement as HTMLInputElement).selectionStart : null;
  host.innerHTML = paletteView(commandItems(state.workflows || []), paletteQuery, paletteActive);
  const input = document.getElementById("palette-input") as HTMLInputElement | null;
  if (input) input.oninput = () => {
    paletteQuery = input.value;
    paletteActive = 0;
    paintPalette();
  };
  host.querySelectorAll("[data-command]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const id = (btn as HTMLButtonElement).dataset.command || "";
      runCommand(filteredCommands().find((item) => item.id === id));
    };
  });
  if (input) {
    input.focus();
    if (pos != null) input.setSelectionRange(pos, pos);
  }
}

function runCommand(item?: CommandItem): void {
  if (!item) return;
  paletteOpen = false;
  if (item.kind === "theme") theme = theme === "dark" ? "light" : "dark";
  else if (item.screen === "replay" && item.workflowId) {
    lastWf = item.workflowId;
    screen = "replay";
  } else if (item.kind === "workflow" && item.workflowId) {
    screen = "library";
    renderKey = "";
    render();
    void openEditor(item.workflowId);
    return;
  } else if (item.screen) screen = item.screen as Screen;
  renderKey = "";
  render();
}

function seekVideo(at: number | undefined): void {
  const video = document.getElementById("run-video") as HTMLVideoElement | null;
  const origin = Number((document.getElementById("video-bar") as HTMLElement | null)?.dataset.origin || 0);
  if (video && at && origin) video.currentTime = Math.max(0, (at - origin) / 1000);
}

async function paintThumbs(): Promise<void> {
  const nodes = [...document.querySelectorAll<HTMLElement>("[data-thumb-run]")];
  const ids = [...new Set(nodes.map((node) => node.dataset.thumbRun || "").filter(Boolean))];
  await Promise.all(ids.map(async (id) => {
    if (shotCache.has(id)) return;
    const run = await (await fetch("/api/runs/" + encodeURIComponent(id))).json() as RunSummary & {
      failure?: { stepId?: string; beforeShot?: string; snapshot?: { screenshot?: string } };
    };
    const steps: Record<string, string> = {};
    let any = "";
    for (const step of run.steps || []) {
      const shot = step.afterShot || step.beforeShot || "";
      if (shot && /^[A-Za-z0-9+/=]+$/.test(shot)) {
        steps[step.id] = shot;
        any = shot;
      }
    }
    const failShot = run.failure?.snapshot?.screenshot || run.failure?.beforeShot || "";
    if (failShot && /^[A-Za-z0-9+/=]+$/.test(failShot)) {
      if (run.failure?.stepId) steps[run.failure.stepId] = steps[run.failure.stepId] || failShot;
      any = any || failShot;
    }
    shotCache.set(id, { steps, any });
  }));
  for (const node of document.querySelectorAll<HTMLElement>("[data-thumb-run]")) {
    if (node.querySelector("img")) continue;
    const cached = shotCache.get(node.dataset.thumbRun || "");
    const shot = (node.dataset.thumbStep && cached?.steps[node.dataset.thumbStep]) || cached?.any || "";
    if (!shot) continue;
    const img = document.createElement("img");
    img.alt = "";
    img.src = `data:image/png;base64,${shot}`;
    node.prepend(img);
  }
}

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen = !paletteOpen;
    if (paletteOpen) {
      paletteQuery = "";
      paletteActive = 0;
    }
    paintPalette();
    return;
  }
  if (!paletteOpen) {
    const tag = document.activeElement?.tagName;
    if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      const search = document.getElementById("library-search");
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
    return;
  }
  const items = filteredCommands();
  if (event.key === "Escape") {
    paletteOpen = false;
    paintPalette();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    paletteActive = Math.min(Math.max(0, items.length - 1), paletteActive + 1);
    paintPalette();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    paletteActive = Math.max(0, paletteActive - 1);
    paintPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runCommand(items[paletteActive]);
  }
});

if ("Notification" in window && Notification.permission === "default") {
  void Notification.requestPermission().catch(() => undefined);
}
void refresh();
setInterval(() => { refresh().catch(() => undefined); }, 400);
setInterval(tickClock, 250);
