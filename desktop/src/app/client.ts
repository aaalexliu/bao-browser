// Desktop window. Talks only to this machine's bao server.

import { attentionCount, formatWait, pendingHealCount } from "../v1/human-ask";
import { sitesForTrust } from "../v1/site-trust";
import { expandControlKey } from "../v1/visible-copy";
import { formatWhen } from "../v1/time";
import { trajectoryFromWorkflow } from "../v1/trajectory";
import type { WorkflowV2 } from "../v1/schema";
import { captureTrailOwnsSteps, livePageFromQuery, liveSessionView, screenFromQuery } from "./live-view";
import type { LiveSessionRecord } from "../cdp-live/live-record";
import { emptyLogin, loginAct, loginsScreen, needsSignInHtml, preferredDirectory, syncPanel, type LoginForm, type SavedSite } from "./logins-view";
import type { PublicImportResult, PublicPreview } from "../login-import/types";
import {
  actBar,
  remoteBanner,
  remoteMcpSetting,
  commandItems,
  esc,
  healDetail,
  healInbox,
  healWorkflowName,
  importCard,
  consolePane,
  inputsPane,
  guidePanel,
  libraryTable,
  networkPane,
  liveStepList,
  macPermissionMissing,
  notices,
  onboarding,
  paletteView,
  helperStatusText,
  rail,
  recordBar,
  saveSheetView,
  runsList,
  runKind,
  reviewItems,
  runViewer,
  statusLabel,
  runField,
  hostAccessPanel,
  siteTrustPanel,
  tryResult,
  fixtureStartValue,
  productWindowTitle,
  teachHome,
  teachPanel,
  teachReview,
  trailPane,
  imageRef,
  versionsPanel,
  workflowDetail,
  runDriverField,
  type CommandItem,
  type HealView,
  type ImportPending,
  type RunSummary,
  type ShellState,
  type WorkflowSummary,
} from "./views";

type Screen = "library" | "capture" | "runs" | "live" | "heals" | "settings" | "replay" | "run" | "workflow" | "logins" | "import" | "teach";

interface OpenedState {
  kind: "workflow" | "import" | "run";
  id: string;
  name: string;
  link: string;
  importLink: string;
  saved: boolean;
  inputs?: Record<string, string>;
  questions: { name: string; type: string; label: string; required: boolean; choices?: string[]; prompt: string; hint?: string; example?: string; cleared?: string }[];
}

let state: ShellState & {
  notices?: { id?: string; title?: string; body?: string; runId?: string; stepId?: string }[];
  settings?: { heal?: string; promoteAfter?: number; actTimeoutMs?: number; circuitLimit?: number; syncServer?: string; remoteMcp?: boolean; remotePermission?: "ask" | "deny"; siteTrust?: Record<string, "ask" | "allow">; hostAccess?: "all" | "site" | "none" };
  relay?: { paired?: boolean; deviceId?: string };
  sync?: {
    server?: string;
    deviceName?: string;
    paired?: boolean;
    lastResult?: string;
    backupPath?: string;
    lastSyncedAt?: string;
    devices?: { name: string; last_seen_at?: string | null }[];
    categories?: { category: string; count: number }[];
    localCategories?: { category: string; count: number }[];
    conflicts?: { id: string; remoteVersion: number; file: string }[];
  };
  trails?: string[];
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
  opened?: OpenedState | null;
  liveSession?: LiveSessionRecord | null;
  librarySplits?: string[];
  home?: string;
} = {};
let conflictCopy: { id: string; name: string; steps: string[] } | null = null;
let screen: Screen = screenFromQuery(location.search) || "library";
let lastWf = "";
let deeplinkInputs: Record<string, string> = {};
let deeplinkPending = false;
let argsWorkflow = "";
let openWorkflow = "";
let healFilter: "pending" | "kept" | "reverted" = "pending";
let openHeal: { runId: string; healId: string } | null = null;
let openRun = "";
let selectedStep = "";
let banner: { id: string; title: string; body: string } | null = null;
const dismissed = new Set<string>();
let renderKey = "";
let libraryQuery = "";
let paletteOpen = false;
let paletteQuery = "";
let paletteActive = 0;
let onboarded = false;
let theme: "light" | "dark" = "light";
let login: LoginForm = emptyLogin();
let gateNote = "";
let gateUrl = "";
let pinnedRunId = "";
let pinnedInputs: Record<string, string> | null = null;
let debugStepId = "";
let runFromN = 0;
let fromNote: "" | "run" | "debug" = "";
let pendingSeek: number | undefined;
let seenOpen = "";
const noteTimers = new Map<string, number>();
let teachOpenId = "";
let teachHighlighted = "";
try {
  onboarded = localStorage.getItem("bao-onboarded") === "1";
  theme = localStorage.getItem("bao-theme") === "dark" ? "dark" : "light";
} catch { /* private mode */ }
const railEl = () => document.getElementById("rail")!;
const actEl = () => document.getElementById("act")!;
const mainEl = () => document.getElementById("main")!;

async function loadHostAccess(): Promise<void> {
  await fetch("/api/extension/host-access").catch(() => undefined);
  renderKey = "";
  await refresh();
}

async function refresh(): Promise<void> {
  try {
    const stored = localStorage.getItem("bao-theme");
    if (stored === "dark" || stored === "light") theme = stored;
  } catch { /* private mode */ }
  state = await (await fetch("/api/state")).json();
  const opened = state.opened;
  if (opened) {
    const token = `${opened.kind}:${opened.id}:${opened.saved}:${JSON.stringify(opened.inputs || {})}`;
    if (token !== seenOpen) {
      seenOpen = token;
      if (opened.kind === "import") screen = "import";
      else if (opened.kind === "run") {
        openWorkflow = opened.id;
        lastWf = opened.id;
        deeplinkInputs = opened.inputs || {};
        deeplinkPending = true;
        screen = "replay";
      } else {
        openWorkflow = opened.id;
        screen = "workflow";
      }
    }
  }
  const key = JSON.stringify({
    recording: state.recording,
    pending: state.pendingImport,
    ask: state.activeAsk,
    notices: state.notices,
    workflows: state.workflows,
    settings: state.settings,
    runs: (state.runs || []).map((run) => ({ id: run.id, status: run.status, decisions: run.decisions, heals: (run.heals || []).map((heal) => heal.id) })),
    reviews: reviewItems(state.runs).map((item) => `${item.workflowId}:${item.stepId}`),
    helper: state.helper,
    model: state.model,
    paused: state.capturePaused,
    since: state.recordingSince,
    promotions: state.promotions,
    live: state.liveSession ? { status: state.liveSession.status, updatedAt: state.liveSession.updatedAt, n: state.liveSession.audit.length } : null,
    sync: state.sync,
    // Step selection stays out of this key. The run viewer owns it, and a poll rebuild would drop the video seek.
    teach: state.teach ? { phase: state.teach.phase, decisions: (state.teach.decisions || []).length, paused: state.teach.paused, error: state.teach.error } : null,
    guide: state.guide ? { status: state.guide.status, stepId: state.guide.stepId, actions: state.guide.actions } : null,
    extract: state.extractPicker || "",
    saveSheet: state.saveSheet?.id || "",
    remote: state.remote,
    screen,
    healFilter,
    openHeal,
    openRun,
    openWorkflow,
    banner,
    opened: state.opened,
  });
  paintDockBadge();
  paintLive();
  paintTeach();
  paintGuide();
  if (key === renderKey) return;
  renderKey = key;
  render();
  paintGuide();
}

function render(): void {
  applyTheme();
  if (screen === "logins") readLoginForm();
  const missing = macPermissionMissing(state.helper);
  const showCard = missing && !onboarded && screen === "library";
  railEl().innerHTML = rail({ ...state, permDot: missing && !showCard });
  const importAsk = screen === "logins" ? loginAct(login) : "";
  actEl().innerHTML = remoteBanner(state.remote) + (importAsk || actBar(state)) + importCard(state.pendingImport as ImportPending);
  const onboard = document.getElementById("onboard");
  if (onboard) onboard.innerHTML = showCard ? onboarding(state.helper) : "";
  const float = document.getElementById("float");
  if (float && state.teach?.phase !== "live" && !state.guide) float.innerHTML = recordBar(state) + (state.extractPicker || "");
  const replayId = lastWf || (state.workflows && state.workflows[0]?.id) || "";
  const openArgs = document.getElementById("args");
  const keepReplay = screen === "replay" && !deeplinkPending && openArgs !== null && openArgs.childElementCount > 0 && argsWorkflow === replayId;
  const keepWorkflow = screen === "workflow" && document.getElementById("workflow-detail")?.getAttribute("data-workflow") === openWorkflow;
  const keepImport = screen === "import" && document.getElementById("import-sheet")?.getAttribute("data-id") === state.opened?.id;
  if (!keepReplay && !keepWorkflow && !keepImport) {
    const body = screen === "capture" ? capture()
      : screen === "teach" ? teachScreen()
      : screen === "runs" ? runsList(state.runs || [], state.workflows || [])
      : screen === "live" ? liveSessionView(state.liveSession, livePageFromQuery(location.search))
      : screen === "run" ? `<section id="run-host"><p class="meta">Loading run…</p></section>`
      : screen === "heals" ? healInbox(state.runs || [], state.workflows || [], healFilter)
      : screen === "settings" ? settings()
      : screen === "logins" ? loginsScreen(login)
      : screen === "replay" ? replayForm()
      : screen === "import" ? importSheet()
      : screen === "workflow" ? `<section id="workflow-host"><p class="meta">Loading workflow…</p></section>`
      : libraryTable(state.workflows || [], state.runs || [], state.promotions || [], state.librarySplits || [], state.home || "");
    const typingSearch = document.activeElement?.id === "library-search";
    const caret = typingSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
    mainEl().innerHTML = body;
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
  paintSaveSheet();
  mountShots();
  paintToasts();
  if (screen === "workflow" && openWorkflow && !keepWorkflow) void openEditor(openWorkflow);
  if (screen === "run" && openRun) void showRun(openRun);
  if (screen === "heals" && openHeal) void showHeal(openHeal.runId, openHeal.healId);
}

function markNav(): void {
  const current = screen === "run" ? "runs" : screen === "workflow" || screen === "import" ? "library" : screen;
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
      <label>Start URL <input id="start-url" value="${esc(fixtureStartValue())}"></label>
      <div class="row"><button class="primary" id="start" type="button">Start capture</button><button id="open-teach" type="button">Teach</button><button id="stop" type="button">Stop and save</button></div>
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

function teachScreen(): string {
  const teach = state.teach;
  if (teach?.phase === "review") return teachReview(teach);
  if (teach?.phase === "live") {
    const fixing = teach.fix ? `<p class="lede">Teaching a fix for <code>${esc(teach.fix.stepId)}</code>. Demonstrate the missing steps, then stop.</p>` : `<p class="lede">The teach panel names each step as it lands. Click a row to correct it.</p>`;
    return `<section><h2>Teach</h2>${fixing}</section>`;
  }
  return teachHome(state.workflows || []);
}

function replayForm(): string {
  const selected = lastWf || (state.workflows && state.workflows[0]?.id) || "";
  const current = (state.workflows || []).find((workflow) => workflow.id === selected);
  const mode = (current && current.heal) || "";
  const globalHeal = (state.settings && state.settings.heal) || "auto";
  const options = (state.workflows || []).map((workflow) =>
    `<option value="${esc(workflow.id)}" ${workflow.id === selected ? "selected" : ""}>${esc(workflow.name)}</option>`).join("");
  const prefill = Object.keys(deeplinkInputs).length
    ? `<p id="run-prefill">Prefilled from the link. A secret is asked again.</p>`
    : "";
  return `<section id="run-form"><h2>Run ${esc(current?.name || "")}</h2>
    <p class="lede">Inputs are asked once, before the run. Secrets stay masked.</p>
    ${prefill}
    ${fromLine()}
    <label>Workflow <select id="wf">${options}</select></label>
    ${runDriverField(current?.driver)}
    <label>Healing for this workflow <select id="wf-heal">
      <option value="" ${mode === "" ? "selected" : ""}>Use the global setting (${esc(globalHeal)})</option>
      <option value="auto" ${mode === "auto" ? "selected" : ""}>Auto self-heal</option>
      <option value="approve" ${mode === "approve" ? "selected" : ""}>Approve before applying</option>
    </select></label>
    <form id="args"></form>
    <p class="mono" data-testid="deeplink">bao://workflow/${esc(selected)}</p>
    <p class="mono" data-testid="import-link">bao://import/${esc(selected)}</p>
    <div class="row">
      <button class="primary" id="run" type="button">Run</button>
      <button id="rerun" type="button">Re-run with past inputs</button>
    </div>
    <div id="live">${gateNote ? needsSignInHtml(gateNote) : ""}</div>
  </section>`;
}

function fromLine(): string {
  if (fromNote === "run" && debugStepId) {
    return `<p id="run-from-note">Run from step ${esc(String(runFromN || debugStepId))}. Earlier steps are not re-run.</p>`;
  }
  if (debugStepId) return `<p id="debug-note">Debug from this step (${esc(debugStepId)}). Earlier steps are not re-run. A secret is asked again.</p>`;
  return "";
}

function settings(): string {
  const heal = state.settings?.heal || "auto";
  const promoteAfter = state.settings?.promoteAfter ?? 3;
  const actMin = Math.round((state.settings?.actTimeoutMs ?? 120 * 60 * 1000) / 60000);
  const circuit = state.settings?.circuitLimit ?? 3;
  const libraryHome = state.home ? `<p class="meta" id="settings-home">${esc(state.home)}</p>` : "";
  return `<section><h2>Settings</h2>
    ${libraryHome}
    ${hostAccessPanel(state.settings?.hostAccess)}
    <label>When a step misses <select id="heal">
      <option value="auto" ${heal === "auto" ? "selected" : ""}>Auto self-heal</option>
      <option value="approve" ${heal === "approve" ? "selected" : ""}>Approve before applying</option>
    </select></label>
    <p class="quiet">Auto is the default. A step can override it with auto, ask, or never. Healing runs when the Cursor CLI is logged in, when a model key is set, or when this build is started with the fixture healer. A real change is the only miss that is healed. A temporary blocker or an outage stops the run. After ${esc(String(circuit))} failed runs in a short window, auto-heal stays off.</p>
    <label>Real runs before a heal is kept <input id="promote-after" type="number" min="1" max="20" value="${promoteAfter}"></label>
    <label>Minutes to wait when you need to act <input id="act-minutes" type="number" min="1" max="1440" value="${actMin}"></label>
    <label>Failed runs that stop auto-heal <input id="circuit-limit" type="number" min="1" max="50" value="${circuit}"></label>
    ${remoteMcpSetting(state.settings?.remoteMcp === true, {
      paired: state.relay?.paired === true,
      permission: state.settings?.remotePermission,
    })}
    ${siteTrustPanel(sitesForTrust(state.workflows || [], state.settings?.siteTrust))}
    <button id="save-settings" class="primary" type="button">Save</button>
    ${syncPanel(state.sync, conflictCopy)}
    <h3>Appearance</h3>
    <label>Theme <select id="theme">
      <option value="light" ${theme === "light" ? "selected" : ""}>Light</option>
      <option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option>
    </select></label>
    <div class="card">
      <h3>Model</h3>
      <p id="settings-model">${esc(state.model?.label || "no model")}</p>
    </div>
    <div class="card">
      <h3>Mac</h3>
      <p id="settings-helper">${esc(helperStatusText(state.helper))}</p>
    </div>
  </section>`;
}

function importSheet(): string {
  const opened = state.opened;
  if (!opened) return `<section id="import-sheet" data-testid="import-sheet"><h2>Import</h2><p>Nothing is waiting.</p></section>`;
  const fields = opened.questions.map((question) => {
    const hint = question.hint ? `<span class="meta">${esc(question.hint)}</span>` : "";
    if (question.type === "file") {
      return `<label>${esc(question.prompt)} ${hint}<input type="file" disabled></label>`;
    }
    if (question.type === "secret") {
      return `<label>${esc(question.prompt)} ${hint}<input disabled placeholder="Entered on your device, never sent"></label>`;
    }
    if (question.type === "choice") {
      const options = (question.choices || []).map((choice) => `<option>${esc(choice)}</option>`).join("");
      return `<label>${esc(question.prompt)} ${hint}<select name="a_${esc(question.name)}">${options}</select></label>`;
    }
    const example = question.example ? ` placeholder="for example ${esc(question.example)}"` : "";
    return `<label>${esc(question.prompt)} ${hint}<input name="a_${esc(question.name)}" ${question.required ? "required" : ""}${example}></label>`;
  }).join("");
  return `<section id="import-sheet" data-testid="import-sheet" data-id="${esc(opened.id)}">
    <h2>Import</h2>
    <p>${esc(opened.name)}</p>
    <p class="notice">Nothing is saved until you answer these.</p>
    <p class="mono" data-testid="import-link">${esc(opened.importLink)}</p>
    ${fields || `<p>This workflow has no import questions.</p>`}
    <p id="import-error" class="notice" hidden></p>
    <button class="primary" id="import-save" type="button">Save</button>
  </section>`;
}

function bind(): void {
  document.querySelectorAll("#rail nav button").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      screen = (btn as HTMLButtonElement).dataset.screen as Screen;
      renderKey = "";
      if (screen === "logins") void loadSaved();
      if (screen === "settings") void loadHostAccess();
      render();
    };
  });
  document.querySelectorAll("[data-screen=replay]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      lastWf = (btn as HTMLButtonElement).dataset.workflow || lastWf;
      debugStepId = "";
      runFromN = 0;
      fromNote = "";
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
  const saveImport = document.getElementById("import-save");
  if (saveImport) saveImport.onclick = async () => {
    const answers: Record<string, string> = {};
    document.querySelectorAll("#import-sheet input[name], #import-sheet select[name]").forEach((node) => {
      const field = node as HTMLInputElement;
      if (field.name.startsWith("a_")) answers[field.name.slice(2)] = field.value;
    });
    const res = await fetch("/api/open/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    const body = await res.json() as { error?: string };
    if (!res.ok) {
      const note = document.getElementById("import-error");
      if (note) {
        note.hidden = false;
        note.textContent = body.error || "answer the questions";
      }
      return;
    }
    renderKey = "";
    await refresh();
  };
  const openTeach = document.getElementById("open-teach");
  if (openTeach) openTeach.onclick = () => {
    screen = "teach";
    renderKey = "";
    render();
  };
  const teachStart = document.getElementById("teach-start");
  if (teachStart) teachStart.onclick = async () => {
    const url = (document.getElementById("teach-url") as HTMLInputElement | null)?.value;
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, teach: true }),
    });
    screen = "teach";
    renderKey = "";
    await refresh();
  };
  const teachMerge = document.getElementById("teach-merge");
  if (teachMerge) teachMerge.onclick = async () => {
    const ids = [...document.querySelectorAll<HTMLInputElement>("input[name=merge]:checked")].map((box) => box.value);
    const res = await fetch("/api/teach/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const doc = await res.json() as { id?: string; error?: string };
    if (doc.id) {
      openWorkflow = doc.id;
      screen = "workflow";
    }
    renderKey = "";
    await refresh();
  };
  const teachSave = document.getElementById("teach-save");
  if (teachSave) teachSave.onclick = async () => {
    const res = await fetch("/api/teach/save", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const doc = await res.json() as { id?: string };
    if (doc.id) {
      openWorkflow = doc.id;
      screen = "workflow";
    }
    renderKey = "";
    await refresh();
  };
  bindTeachFix(document);
  bindTeach(document);
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
  if (wf) wf.onchange = () => {
    lastWf = wf.value;
    deeplinkInputs = {};
    deeplinkPending = false;
    pinnedRunId = "";
    pinnedInputs = null;
    debugStepId = "";
    runFromN = 0;
    fromNote = "";
    renderKey = "";
    render();
  };
  const wfDriver = document.getElementById("wf-driver") as HTMLSelectElement | null;
  if (wfDriver) wfDriver.onchange = async () => {
    const id = (document.getElementById("wf") as HTMLSelectElement).value;
    await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driver: wfDriver.value === "extension" ? "extension" : "playwright" }),
    });
    renderKey = "";
    await refresh();
  };
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
  const rerun = document.getElementById("rerun");
  if (rerun) rerun.onclick = () => void fillPastInputs();
  const review = document.getElementById("act-review");
  if (review) review.onclick = () => {
    const workflowId = review.dataset.workflow || "";
    const stepId = review.dataset.step || "";
    const run = (state.runs || []).filter((item) => item.workflowId === workflowId).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    if (run) {
      openRun = run.id;
      selectedStep = stepId;
      screen = "run";
    } else {
      openWorkflow = workflowId;
      screen = "workflow";
    }
    renderKey = "";
    render();
  };
  const pair = document.getElementById("pair");
  if (pair) pair.onclick = () => void postSync("/api/sync/pair", {
    code: (document.getElementById("pair-code") as HTMLInputElement).value,
    server: (document.getElementById("sync-server") as HTMLInputElement).value,
    name: (document.getElementById("device-name") as HTMLInputElement).value,
    secret: (document.getElementById("invite-secret") as HTMLInputElement | null)?.value || "",
  });
  const syncNow = document.getElementById("sync-now");
  if (syncNow) syncNow.onclick = () => void postSync("/api/sync", { mode: "sync" });
  const syncPush = document.getElementById("sync-push");
  if (syncPush) syncPush.onclick = () => void postSync("/api/sync", { mode: "push" });
  const syncPull = document.getElementById("sync-pull");
  if (syncPull) syncPull.onclick = () => void postSync("/api/sync", { mode: "pull" });
  document.querySelectorAll("[data-open-conflict]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void postSync("/api/sync/conflict", {
      id: (btn as HTMLButtonElement).dataset.openConflict,
      action: "open",
    });
  });
  document.querySelectorAll("[data-keep-mine]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void postSync("/api/sync/conflict", {
      id: (btn as HTMLButtonElement).dataset.keepMine,
      action: "keep",
    });
  });
  document.querySelectorAll<HTMLInputElement>("[data-sync-category]").forEach((input) => {
    input.onchange = () => void postSync("/api/sync/category", {
      category: input.dataset.syncCategory,
      enabled: input.checked,
    });
  });
  const schedule = document.getElementById("backup-schedule");
  if (schedule) schedule.onchange = () => void postSync("/api/sync/backup", {
    schedule: (schedule as HTMLSelectElement).value,
  });
  const restore = document.getElementById("restore-backup");
  if (restore) restore.onclick = () => void postSync("/api/sync/backup", { action: "restore" });
  const reveal = document.getElementById("reveal-backup");
  if (reveal) reveal.onclick = () => void postSync("/api/sync/reveal", {});
  bindAsk();
  bindRemote();
  bindHeal();
  const revokeHosts = document.getElementById("revoke-hosts");
  if (revokeHosts) revokeHosts.onclick = async () => {
    await fetch("/api/extension/host-access/revoke", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const save = document.getElementById("save-settings");
  if (save) save.onclick = async () => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        heal: (document.getElementById("heal") as HTMLSelectElement).value,
        promoteAfter: Number((document.getElementById("promote-after") as HTMLInputElement).value),
        actTimeoutMin: Number((document.getElementById("act-minutes") as HTMLInputElement).value),
        circuitLimit: Number((document.getElementById("circuit-limit") as HTMLInputElement).value),
        syncServer: (document.getElementById("sync-server") as HTMLInputElement | null)?.value,
        remoteMcp: (document.getElementById("remote-mcp") as HTMLInputElement | null)?.checked === true,
        remotePermission: (document.getElementById("remote-permission") as HTMLSelectElement | null)?.value === "deny" ? "deny" : "ask",
        siteTrust: readSiteTrust(),
      }),
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
    (btn as HTMLButtonElement).onclick = () => {
      openWorkflow = (btn as HTMLButtonElement).dataset.openWorkflow || "";
      screen = "workflow";
      renderKey = "";
      render();
    };
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
  bindLogins();
  bindGate();
  const pause = document.getElementById("rec-pause");
  if (pause) pause.onclick = async () => {
    await fetch("/api/sessions/pause", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const recNote = document.getElementById("rec-note") as HTMLInputElement | null;
  const recNoteAdd = document.getElementById("rec-note-add");
  const sendRecNote = async () => {
    const text = recNote?.value.trim() || "";
    if (!text || !recNote) return;
    recNote.value = "";
    await fetch("/api/sessions/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    renderKey = "";
    await refresh();
  };
  if (recNoteAdd) recNoteAdd.onclick = () => void sendRecNote();
  if (recNote) recNote.onkeydown = (ev) => {
    if (ev.key === "Enter") void sendRecNote();
  };
  const mark = document.getElementById("rec-mark");
  if (mark) mark.onclick = async () => {
    await fetch("/api/sessions/mark", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const recExtract = document.getElementById("rec-extract");
  if (recExtract) recExtract.onclick = async () => {
    await fetch("/api/sessions/extract/arm", { method: "POST" });
  };
  const extractCommit = document.getElementById("extract-commit");
  if (extractCommit) extractCommit.onclick = async () => {
    const names: Record<string, string> = {};
    const drop: string[] = [];
    document.querySelectorAll<HTMLInputElement>("[data-col-keep]").forEach((box) => {
      const id = box.dataset.colKeep || "";
      const field = document.querySelector<HTMLInputElement>(`[data-col-name="${id}"]`);
      if (!box.checked) drop.push(id);
      else if (field) names[id] = field.value;
    });
    const pages = document.getElementById("extract-pages") as HTMLInputElement | null;
    await fetch("/api/sessions/extract/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names, drop, maxPages: pages ? Number(pages.value) : 1, as: "items" }),
    });
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

function paintSaveSheet(): void {
  const host = document.getElementById("sheet");
  if (!host) return;
  const sheet = state.saveSheet;
  if (!sheet) {
    if (host.innerHTML) host.innerHTML = "";
    return;
  }
  const existing = host.querySelector("#save-sheet");
  if (existing && existing.getAttribute("data-id") === sheet.id) return;
  host.innerHTML = saveSheetView(sheet);
  const form = host.querySelector("#save-sheet-form") as HTMLFormElement | null;
  if (form) form.onsubmit = (ev) => {
    ev.preventDefault();
    void commitSaveSheet();
  };
  const discard = host.querySelector("#save-discard");
  if (discard) (discard as HTMLButtonElement).onclick = () => void discardSaveSheet();
}

async function commitSaveSheet(): Promise<void> {
  const name = (document.getElementById("save-title") as HTMLInputElement | null)?.value || "";
  const summary = (document.getElementById("save-summary") as HTMLInputElement | null)?.value || "";
  const intent = (document.getElementById("save-intent") as HTMLTextAreaElement | null)?.value || "";
  const res = await fetch("/api/sessions/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, summary, intent }),
  });
  const doc = await res.json() as { id?: string; error?: string };
  if (!res.ok || !doc.id) {
    const note = document.getElementById("save-error");
    if (note) {
      note.hidden = false;
      note.textContent = doc.error || "Could not save";
    }
    return;
  }
  openWorkflow = doc.id;
  screen = "workflow";
  renderKey = "";
  await refresh();
}

async function discardSaveSheet(): Promise<void> {
  await fetch("/api/sessions/save/discard", { method: "POST" });
  renderKey = "";
  await refresh();
}

function bindTeachFix(root: ParentNode): void {
  const fix = root.querySelector("#teach-fix") as HTMLButtonElement | null;
  if (!fix) return;
  fix.onclick = async () => {
    const workflow = fix.dataset.workflow || "";
    const step = fix.dataset.step || "";
    const saved = await (await fetch("/api/workflows/" + encodeURIComponent(workflow))).json() as { startUrl?: string };
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: saved.startUrl, teach: true, fix: { workflowId: workflow, stepId: step } }),
    });
    screen = "teach";
    renderKey = "";
    await refresh();
  };
}

function bindRemote(): void {
  const allow = document.getElementById("remote-allow");
  if (allow) allow.onclick = () => void fetch("/api/remote/allow", { method: "POST" });
  const deny = document.getElementById("remote-deny");
  if (deny) deny.onclick = () => void fetch("/api/remote/deny", { method: "POST" });
  const kill = document.getElementById("remote-kill");
  if (kill) kill.onclick = () => void fetch("/api/remote/kill", { method: "POST" });
  const confirm = document.getElementById("remote-confirm-allow");
  if (confirm) confirm.onclick = () => void fetch("/api/remote/confirm", { method: "POST" });
  const pair = document.getElementById("relay-pair");
  if (pair) pair.onclick = async () => {
    const code = (document.getElementById("relay-code") as HTMLInputElement | null)?.value || "";
    await fetch("/api/remote/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    renderKey = "";
    await refresh();
  };
  const revoke = document.getElementById("relay-revoke");
  if (revoke) revoke.onclick = async () => {
    await fetch("/api/remote/revoke", { method: "POST" });
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
    id: `decision-${decision}-${Date.now()}`,
    title: decision === "keep" ? "Patch kept" : "Patch reverted",
    body: decision === "keep" ? "Saved a draft. Replay still uses the live version until you promote it." : "Reverted the live workflow to the failed step.",
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
  const merged = new Map(recent.map((item) => [item.id, item]));
  merged.set(run.id, run);
  const history = [...merged.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-8);
  const reviewStepIds = reviewItems((state.runs || []).filter((item) => item.workflowId === run.workflowId)).map((item) => item.stepId);
  host.innerHTML = runViewer(run, workflow, selectedStep, { recent: history, recorded, reviewStepIds });
  bindTeachFix(host);
  host.querySelectorAll("[data-select-step]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const stepId = (btn as HTMLButtonElement).dataset.selectStep || "";
      const step = (run.steps || []).find((item) => item.id === stepId);
      selectedStep = stepId;
      pendingSeek = stepMoment(step);
      void showRun(id);
    };
  });
  host.querySelectorAll("#filmstrip img").forEach((node) => {
    const img = node as HTMLImageElement;
    const drop = () => {
      const frame = img.parentElement;
      img.remove();
      frame?.classList.remove("has-shot");
    };
    img.addEventListener("error", drop);
    img.addEventListener("load", () => {
      if (img.naturalWidth === 96 && img.naturalHeight === 54) drop();
    });
  });
  host.querySelectorAll("[data-frame]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const stage = document.getElementById("shot-stage");
      if (!stage) return;
      const which = (btn as HTMLButtonElement).dataset.frame || "after";
      if ((btn as HTMLButtonElement).disabled) return;
      stage.dataset.which = which;
      host.querySelectorAll("[data-frame]").forEach((el) => el.classList.toggle("on", (el as HTMLElement).dataset.frame === which));
      mountStage(stage);
      const thumb = host.querySelector("#filmstrip .frame.on img") as HTMLImageElement | null;
      const next = which === "before" ? thumb?.dataset.before : thumb?.dataset.after;
      if (thumb && next) thumb.src = next;
    };
  });
  mountShots(host);
  const stage = document.getElementById("shot-stage");
  if (stage) mountStage(stage);
  const scrub = host.querySelector("#scrubber") as HTMLInputElement | null;
  if (scrub) scrub.onchange = () => {
    const index = Number(scrub.value);
    const step = (run.steps || [])[index];
    if (!step) return;
    selectedStep = step.id;
    pendingSeek = stepMoment(step);
    void showRun(id);
  };
  host.querySelectorAll("[data-marker]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const stepId = (btn as HTMLButtonElement).dataset.marker || "";
      const step = (run.steps || []).find((item) => item.id === stepId);
      selectedStep = stepId;
      pendingSeek = stepMoment(step) ?? Number((btn as HTMLButtonElement).dataset.at || 0);
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
  const consoleTab = host.querySelector("[data-run-tab=console]");
  if (consoleTab) (consoleTab as HTMLButtonElement).onclick = () => {
    const extra = document.getElementById("run-extra");
    if (extra) extra.innerHTML = consolePane(run.console, selectedStep);
  };
  const networkTab = host.querySelector("[data-run-tab=network]");
  if (networkTab) (networkTab as HTMLButtonElement).onclick = () => {
    const extra = document.getElementById("run-extra");
    if (extra) extra.innerHTML = networkPane(run.network, selectedStep);
  };
  const rerunRun = host.querySelector("#rerun-run");
  if (rerunRun) (rerunRun as HTMLButtonElement).onclick = () => openPastRun(run.workflowId, run.id, "", run.inputs);
  const debug = host.querySelector("#debug-step");
  if (debug) (debug as HTMLButtonElement).onclick = () => openPastRun(run.workflowId, run.id, (debug as HTMLButtonElement).dataset.step || "", run.inputs);
  bindVideoSkip();
  if (typeof pendingSeek === "number") {
    const at = pendingSeek;
    pendingSeek = undefined;
    seekVideo(at);
  }
}

function openPastRun(workflowId: string, runId: string, stepId: string, inputs?: Record<string, string>): void {
  pinnedRunId = runId;
  pinnedInputs = inputs || null;
  debugStepId = stepId;
  runFromN = 0;
  fromNote = stepId ? "debug" : "";
  lastWf = workflowId;
  screen = "replay";
  renderKey = "";
  render();
}

function bindVideoSkip(): void {
  const video = document.getElementById("run-video") as HTMLVideoElement | null;
  if (!video) return;
  let skips: { from: number; to: number; label: string }[] = [];
  try { skips = JSON.parse(video.dataset.skips || "[]") as { from: number; to: number; label: string }[]; } catch { skips = []; }
  const follow = () => highlightStepAt(video.currentTime);
  video.ontimeupdate = () => {
    if (!video.paused) {
      const hit = skips.find((item) => video.currentTime >= item.from && video.currentTime < item.to - 0.05);
      if (hit) {
        video.currentTime = hit.to;
        const live = document.getElementById("skip-live");
        if (live) live.textContent = hit.label;
        return;
      }
    }
    follow();
  };
  video.onseeked = follow;
}

/** The step whose start is at or before the video time stays highlighted. */
function highlightStepAt(time: number): void {
  const origin = Number((document.getElementById("video-bar") as HTMLElement | null)?.dataset.origin || 0);
  const frames = [...document.querySelectorAll<HTMLElement>("#filmstrip [data-select-step]")];
  let chosen = "";
  let best = -Infinity;
  for (const frame of frames) {
    const at = Number(frame.dataset.at);
    if (!Number.isFinite(at)) continue;
    const start = (at - origin) / 1000;
    if (start <= time + 0.04 && start >= best) {
      best = start;
      chosen = frame.dataset.selectStep || "";
    }
  }
  if (!chosen) return;
  selectedStep = chosen;
  document.querySelectorAll<HTMLElement>("[data-select-step], [data-marker]").forEach((el) => {
    const id = el.dataset.selectStep || el.dataset.marker || "";
    el.classList.toggle("on", id === chosen);
  });
  const listed = [...document.querySelectorAll<HTMLElement>("#step-list [data-select-step]")];
  const index = listed.findIndex((el) => el.dataset.selectStep === chosen);
  const scrub = document.getElementById("scrubber") as HTMLInputElement | null;
  if (scrub && index >= 0) scrub.value = String(index);
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
  const compare = document.getElementById("shot-compare");
  if (compare) mountCompare(compare);
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
  const [listed, shareRes] = await Promise.all([
    fetch("/api/workflows/" + encodeURIComponent(id) + "/versions").then((res) => res.json()) as Promise<{
      versions?: { n: number; role: string; source: string; createdAt: number }[];
    }>,
    fetch("/api/workflows/" + encodeURIComponent(id) + "/share").then((res) => res.ok ? res.json() : undefined),
  ]);
  const host = document.getElementById("workflow-host");
  if (!host || !host.isConnected || screen !== "workflow" || openWorkflow !== id) return;
  const last = (state.runs || []).filter((run) => run.workflowId === id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const lastLabel = last ? `Last run · ${statusLabel(runKind(last))}${typeof last.at === "number" ? ` · ${formatWhen(last.at)}` : ""}` : "Not run yet";
  const shots = last?.id ? await stepCrops(last.id) : {};
  if (!host.isConnected || screen !== "workflow" || openWorkflow !== id) return;
  host.innerHTML = workflowDetail(doc, { lastRunId: last?.id, lastLabel, shots, share: shareRes }) + versionsPanel(listed.versions || []) + `<details class="card" id="workflow-edit"><summary>Edit workflow</summary>
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
  </details>`;
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
    await openEditor(id);
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
    await openEditor(id);
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
  host.querySelectorAll("[data-guide]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void startGuide((btn as HTMLButtonElement).dataset.guide || id);
  });
  host.querySelectorAll("[data-screen=replay]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      lastWf = (btn as HTMLButtonElement).dataset.workflow || id;
      debugStepId = "";
      runFromN = 0;
      fromNote = "";
      screen = "replay";
      renderKey = "";
      render();
    };
  });
  host.querySelectorAll("[data-try-step]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void tryWorkflowStep(id, (btn as HTMLButtonElement).dataset.tryStep || "");
  });
  host.querySelectorAll("[data-run-from]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const el = btn as HTMLButtonElement;
      debugStepId = el.dataset.runFrom || "";
      runFromN = Number(el.dataset.stepN || 0);
      fromNote = "run";
      pinnedRunId = "";
      pinnedInputs = null;
      lastWf = id;
      screen = "replay";
      renderKey = "";
      render();
    };
  });
  bindTokens(host, id);
  host.querySelectorAll("[data-screen=library]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      screen = "library";
      renderKey = "";
      render();
    };
  });
  bindShare(host, id);
  host.querySelectorAll("[data-resolve]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = async () => {
      const action = (btn as HTMLButtonElement).dataset.resolve || "";
      await fetch("/api/sync/conflict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      renderKey = "";
      await refresh();
      await openEditor(id);
    };
  });
  host.querySelectorAll("[data-promote-version], [data-restore-version]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = async () => {
      const el = btn as HTMLButtonElement;
      const n = Number(el.dataset.promoteVersion || el.dataset.restoreVersion);
      const action = el.dataset.promoteVersion ? "promote" : "restore";
      await fetch("/api/workflows/" + encodeURIComponent(id) + "/versions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, n }),
      });
      renderKey = "";
      await refresh();
      await openEditor(id);
    };
  });
  host.querySelectorAll("[data-step-heal]").forEach((sel) => {
    (sel as HTMLSelectElement).onchange = async () => {
      const stepId = (sel as HTMLSelectElement).dataset.stepHeal || "";
      const heal = (sel as HTMLSelectElement).value;
      await fetch("/api/workflows/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepHeal: { stepId, heal: heal || null } }),
      });
      renderKey = "";
      await refresh();
      await openEditor(id);
    };
  });
  mountShots(host);
}

async function fillArgs(id: string): Promise<void> {
  if (!id) return;
  const doc = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json() as {
    inputs: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean; fromOutput?: string; relative?: string; format?: string; zone?: string }[];
    steps?: { label?: string; download?: { output?: string } }[];
  };
  const form = document.getElementById("args");
  if (!form || screen !== "replay") return;
  const pinned = pinnedRunId ? (state.runs || []).find((run) => run.id === pinnedRunId && run.workflowId === id) : undefined;
  const last = (state.runs || []).filter((run) => run.workflowId === id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const prev = { ...((pinnedRunId && pinnedInputs) || pinned?.inputs || last?.inputs || {}), ...deeplinkInputs };
  form.innerHTML = doc.inputs.map((input) => field(input, input.type === "secret" ? undefined : prev[input.name], doc.steps || [])).join("") || "<p>This workflow has no inputs.</p>";
  argsWorkflow = id;
  deeplinkPending = false;
  form.querySelectorAll(".drop").forEach((zone) => {
    const el = zone as HTMLElement;
    if (el.dataset.fromOutput) return;
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

function field(
  input: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean; fromOutput?: string; relative?: string; format?: string; zone?: string },
  previous: string | undefined,
  steps: { label?: string; download?: { output?: string } }[],
): string {
  const boundStep = input.fromOutput
    ? steps.find((step) => step.download?.output === input.fromOutput)?.label || input.fromOutput
    : undefined;
  return runField({ ...input, boundStep }, previous);
}

function readSiteTrust(): Record<string, "ask" | "allow"> {
  const siteTrust: Record<string, "ask" | "allow"> = {};
  document.querySelectorAll<HTMLSelectElement>("[data-site-trust]").forEach((sel) => {
    const origin = expandControlKey(sel.dataset.siteTrust || "");
    if (!origin) return;
    siteTrust[origin] = sel.value === "ask" ? "ask" : "allow";
  });
  return siteTrust;
}

async function tryWorkflowStep(id: string, stepId: string): Promise<void> {
  const slot = document.querySelector(`[data-try-slot="${CSS.escape(stepId)}"]`);
  if (slot) slot.innerHTML = `<p class="quiet">Looking up…</p>`;
  const res = await fetch("/api/workflows/" + encodeURIComponent(id) + "/try", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stepId }),
  });
  const body = await res.json() as { error?: string; matched?: boolean };
  if (slot) slot.innerHTML = tryResult(res.ok ? body : { error: body.error || "Try failed" });
}

function bindTokens(host: HTMLElement, id: string): void {
  host.querySelectorAll("[data-edit-input]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => openTokenEditor(btn as HTMLButtonElement, id);
  });
}

function openTokenEditor(token: HTMLButtonElement, id: string): void {
  const name = token.dataset.editInput || "";
  const secret = token.dataset.type === "secret";
  const editor = document.createElement("form");
  editor.id = "input-editor";
  editor.className = "token-editor";
  editor.innerHTML = `<p class="quiet">Edit ${esc(token.dataset.label || name)}</p>
    <label>Label <input name="label" value="${esc(token.dataset.label || name)}"></label>
    <label>Type <select name="type">
      ${["text", "secret", "number", "choice", "file"].map((type) => `<option value="${type}" ${token.dataset.type === type ? "selected" : ""}>${type}</option>`).join("")}
    </select></label>
    <label data-default-row ${secret ? "hidden" : ""}>Default <input name="default" value="${esc(secret ? "" : token.dataset.default || "")}" ${secret ? "disabled" : ""}></label>
    <label>Required <input name="required" type="checkbox" ${token.dataset.required === "1" ? "checked" : ""}></label>
    <p class="quiet" data-secret-note ${secret ? "" : "hidden"}>A secret stays masked. The value is not stored.</p>
    <button type="button" data-save-input>Save</button>`;
  document.getElementById("input-editor")?.remove();
  token.closest(".step-copy")?.appendChild(editor);
  const typeSel = editor.querySelector("[name=type]") as HTMLSelectElement;
  const defaultRow = editor.querySelector("[data-default-row]") as HTMLElement;
  const secretNote = editor.querySelector("[data-secret-note]") as HTMLElement;
  const defaultInput = editor.querySelector("[name=default]") as HTMLInputElement;
  typeSel.onchange = () => {
    const hide = typeSel.value === "secret";
    defaultRow.hidden = hide;
    secretNote.hidden = !hide;
    defaultInput.disabled = hide;
    if (hide) defaultInput.value = "";
  };
  editor.querySelector("[data-save-input]")!.addEventListener("click", async () => {
    const type = typeSel.value;
    const res = await fetch("/api/workflows/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputEdit: {
          name,
          label: (editor.querySelector("[name=label]") as HTMLInputElement).value,
          type,
          default: type === "secret" ? "" : defaultInput.value,
          required: (editor.querySelector("[name=required]") as HTMLInputElement).checked,
        },
      }),
    });
    if (!res.ok) return;
    renderKey = "";
    await refresh();
    await openEditor(id);
  });
}

async function startGuide(id: string): Promise<void> {
  lastWf = id;
  const res = await fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args: {}, guide: true }),
  });
  const run = await res.json() as { status?: string; actions?: number; error?: string };
  const live = document.getElementById("guide-actions");
  if (live && typeof run.actions === "number") live.textContent = `${run.actions} automated actions`;
  renderKey = "";
  await refresh();
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
  gateNote = "";
  const fromStep = debugStepId;
  const res = await fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args, fromStep: fromStep || undefined }),
  });
  const run = await res.json() as RunSummary & { runId?: string; error?: string; message?: string; signInUrl?: string };
  if (run.status === "needs-sign-in") {
    gateNote = run.message || "Needs sign-in. The session is not live, so Bao did not start the run.";
    gateUrl = run.signInUrl || "";
    if (live) live.innerHTML = needsSignInHtml(gateNote);
    bindGate();
    return;
  }
  const runId = run.id || run.runId || "";
  if (!res.ok || !runId) {
    if (live) live.textContent = run.error || "The run did not start.";
    return;
  }
  openRun = runId;
  selectedStep = fromStep;
  pinnedRunId = "";
  pinnedInputs = null;
  debugStepId = "";
  runFromN = 0;
  fromNote = "";
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

function paintDockBadge(): void {
  const count = attentionCount({
    ask: state.activeAsk,
    importPhase: state.pendingImport?.phase,
    pendingHeals: pendingHealCount(state.runs || []),
    reviews: reviewItems(state.runs).length,
  });
  document.title = productWindowTitle();
  const nav = navigator as Navigator & { setAppBadge?: (value: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0) void nav.setAppBadge?.(count).catch(() => undefined);
  else void nav.clearAppBadge?.().catch(() => undefined);
}

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("bao-theme", theme); } catch { /* ignore */ }
}

function readLoginForm(): void {
  const site = document.getElementById("login-site") as HTMLInputElement | null;
  if (!site) return;
  login.site = site.value.trim();
  const advanced = document.getElementById("login-advanced") as HTMLDetailsElement | null;
  login.advancedOpen = Boolean(advanced && advanced.open);
  login.probeUrl = (document.getElementById("login-probe") as HTMLInputElement).value.trim();
  login.selector = (document.getElementById("login-selector") as HTMLInputElement).value.trim();
  login.text = (document.getElementById("login-text") as HTMLInputElement).value.trim();
  login.origins = (document.getElementById("login-origins") as HTMLInputElement).value.trim();
  login.botCookies = (document.getElementById("login-bots") as HTMLSelectElement).value === "include" ? "include" : "skip";
}

function loginPayload(): Record<string, unknown> {
  return {
    site: login.site,
    consent: true,
    probeUrl: login.probeUrl,
    signedInSelector: login.selector,
    signedInText: login.text,
    origins: login.origins,
    botCookies: login.botCookies,
  };
}

async function loadSaved(): Promise<void> {
  const listed = await (await fetch("/api/login-sites")).json() as { sites?: SavedSite[] };
  login.saved = listed.sites || [];
  renderKey = "";
  render();
}

function bindLogins(): void {
  if (screen !== "logins") return;
  const show = document.getElementById("show-profiles");
  if (show) show.onclick = async () => {
    readLoginForm();
    login.error = "";
    login.report = null;
    login.settled = false;
    const res = await fetch("/api/login-import/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loginPayload()),
    });
    const body = await res.json() as PublicPreview & { error?: string };
    if (!res.ok) {
      login.error = body.error || "Import failed";
      login.preview = null;
      login.selected = "";
      renderKey = "";
      render();
      return;
    }
    login.preview = body;
    const profiles = body.profiles || [];
    login.selected = profiles.some((profile) => profile.directory === body.preferred) ? (body.preferred || "") : preferredDirectory(profiles);
    await loadSaved();
  };
  document.querySelectorAll<HTMLButtonElement>("[data-import-profile]").forEach((btn) => {
    btn.onclick = () => {
      readLoginForm();
      login.selected = btn.dataset.importProfile || "";
      login.settled = false;
      renderKey = "";
      render();
    };
  });
  const go = document.getElementById("import-selected");
  if (go) go.onclick = async () => {
    readLoginForm();
    if (!login.selected) return;
    login.error = "";
    (go as HTMLButtonElement).disabled = true;
    const res = await fetch("/api/login-import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...loginPayload(), profile: login.selected }),
    });
    const body = await res.json() as PublicImportResult & { error?: string };
    if (!res.ok) {
      login.error = body.error || "Import failed";
      renderKey = "";
      render();
      return;
    }
    login.report = body;
    login.settled = true;
    await loadSaved();
  };
  const decline = document.getElementById("import-decline");
  if (decline) decline.onclick = () => {
    readLoginForm();
    login.settled = true;
    renderKey = "";
    render();
  };
  document.querySelectorAll<HTMLButtonElement>("[data-recheck]").forEach((btn) => {
    btn.onclick = async () => {
      readLoginForm();
      btn.disabled = true;
      btn.textContent = "Checking…";
      const res = await fetch("/api/login-sites/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: expandControlKey(btn.dataset.recheck || "") }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) login.error = body.error || "Re-check failed";
      await loadSaved();
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      readLoginForm();
      await fetch("/api/login-sites", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: expandControlKey(btn.dataset.remove || "") }),
      });
      await loadSaved();
    };
  });
  const once = document.getElementById("sign-in-once");
  if (once) once.onclick = () => void signInOnce(login.report?.signInUrl);
}

function bindGate(): void {
  const once = document.getElementById("run-sign-in");
  if (once) once.onclick = () => void signInOnce(gateUrl);
}

async function postSync(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({})) as { error?: string; id?: string; name?: string; steps?: string[] };
  if (!res.ok) {
    banner = { id: "sync", title: "Sync", body: payload.error || "Sync failed" };
  } else if (Array.isArray(payload.steps) && payload.id) {
    conflictCopy = { id: payload.id, name: payload.name || payload.id, steps: payload.steps };
  } else if (url.endsWith("/conflict")) {
    conflictCopy = null;
  }
  renderKey = "";
  await refresh();
}

async function fillPastInputs(): Promise<void> {
  const wf = document.getElementById("wf") as HTMLSelectElement | null;
  if (!wf?.value) return;
  const saved = await (await fetch("/api/workflows/" + encodeURIComponent(wf.value) + "/inputs")).json() as Record<string, string | number>;
  const form = document.getElementById("args");
  if (!form) return;
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name]")) {
    if (el instanceof HTMLInputElement && (el.type === "password" || el.type === "file")) continue;
    const value = saved[el.name];
    if (typeof value === "string" || typeof value === "number") el.value = String(value);
  }
}

async function signInOnce(url?: string): Promise<void> {
  if (document.getElementById("login-site")) readLoginForm();
  const payload = url ? { site: url, consent: true, probeUrl: url } : loginPayload();
  const res = await fetch("/api/login-import/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json() as { error?: string };
  if (!res.ok) {
    login.error = body.error || "Could not open Bao's window";
    renderKey = "";
    render();
  }
}

function applySearch(): void {
  const q = libraryQuery.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>(".wf-card").forEach((card) => {
    const name = (card.querySelector("h3")?.textContent || "").toLowerCase();
    card.hidden = !!q && !name.includes(q);
  });
}

function teachFieldKey(el: HTMLInputElement): string {
  const card = CSS.escape(el.closest("[data-card]")?.getAttribute("data-card") || "");
  if (el.hasAttribute("data-note")) return `[data-card="${card}"] [data-note]`;
  if (el.hasAttribute("data-intent")) return `[data-card="${card}"] [data-intent]`;
  if (el.hasAttribute("data-param")) {
    const role = CSS.escape(el.closest(".teach-value")?.getAttribute("data-role") || "");
    return `[data-card="${card}"] .teach-value[data-role="${role}"] [data-param]`;
  }
  return "";
}

function teachMarkup(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const timer = clone.querySelector("#rec-timer");
  if (timer) timer.textContent = "0:00";
  clone.querySelectorAll(".teach-card.open").forEach((el) => el.classList.remove("open"));
  clone.querySelectorAll(".teach-row[aria-expanded]").forEach((el) => el.setAttribute("aria-expanded", "false"));
  clone.querySelectorAll(".thumb img").forEach((img) => img.remove());
  clone.querySelectorAll(".has-shot").forEach((el) => el.classList.remove("has-shot"));
  clone.querySelectorAll("[data-shot-mounted]").forEach((el) => el.removeAttribute("data-shot-mounted"));
  return clone.innerHTML;
}

function retryShots(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-shot]:not(.has-shot)").forEach((node) => {
    delete node.dataset.shotMounted;
  });
  mountShots(root);
}

function paintTeach(): void {
  const float = document.getElementById("float");
  if (!float || state.teach?.phase !== "live") return;
  const html = teachPanel(state.teach);
  if (float.querySelector("#teach-panel") && teachMarkup(float) === html) {
    retryShots(float);
    return;
  }
  const active = document.activeElement;
  const barNote = active instanceof HTMLInputElement && active.id === "teach-note" ? active.value : "";
  const editing = active instanceof HTMLInputElement && float.contains(active) && active.id !== "teach-note" ? teachFieldKey(active) : "";
  const value = editing && active instanceof HTMLInputElement ? active.value : "";
  const start = editing && active instanceof HTMLInputElement ? active.selectionStart : null;
  const end = editing && active instanceof HTMLInputElement ? active.selectionEnd : null;
  if (active instanceof HTMLInputElement && float.contains(active)) active.onchange = null;
  const openId = float.querySelector(".teach-card.open")?.getAttribute("data-card") || teachOpenId;
  float.innerHTML = html;
  if (openId) {
    const opened = float.querySelector(`[data-card="${CSS.escape(openId)}"]`);
    opened?.classList.add("open");
    opened?.querySelector(".teach-row")?.setAttribute("aria-expanded", "true");
  }
  bindTeach(float);
  mountShots(float);
  if (barNote) {
    const nextNote = float.querySelector<HTMLInputElement>("#teach-note");
    if (nextNote) {
      nextNote.value = barNote;
      nextNote.focus();
    }
  }
  const highlighted = float.querySelector(".teach-card.on");
  const highlightedId = highlighted?.getAttribute("data-card") || "";
  if (highlightedId && highlightedId !== teachHighlighted) {
    teachHighlighted = highlightedId;
    highlighted?.scrollIntoView({ block: "nearest" });
  }
  if (!editing) return;
  const next = float.querySelector(editing) as HTMLInputElement | null;
  if (!next) return;
  if (next.value !== value) next.value = value;
  next.focus();
  if (start != null && end != null) next.setSelectionRange(start, end);
}

async function correct(card: string, kind: string, extra: Record<string, string> = {}): Promise<void> {
  await fetch("/api/teach/correct", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cardId: card, kind, ...extra }),
  });
  renderKey = "";
  await refresh();
}

function bindTeach(root: ParentNode): void {
  const noteInput = root.querySelector<HTMLInputElement>("#teach-note");
  const noteAdd = root.querySelector("#teach-note-add");
  const sendNote = async () => {
    const text = noteInput?.value.trim() || "";
    if (!text) return;
    if (noteInput) noteInput.value = "";
    await fetch("/api/sessions/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    renderKey = "";
    await refresh();
  };
  if (noteAdd) (noteAdd as HTMLButtonElement).onclick = () => void sendNote();
  if (noteInput) noteInput.onkeydown = (ev) => {
    if (ev.key === "Enter") void sendNote();
  };
  const pause = root.querySelector("#teach-pause");
  if (pause) (pause as HTMLButtonElement).onclick = async () => {
    await fetch("/api/sessions/pause", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const check = root.querySelector("#teach-check");
  if (check) (check as HTMLButtonElement).onclick = async () => {
    await fetch("/api/teach/check", { method: "POST" });
    renderKey = "";
    await refresh();
  };
  const discard = root.querySelector("#teach-discard");
  if (discard) (discard as HTMLButtonElement).onclick = async () => {
    await fetch("/api/teach/discard", { method: "POST" });
    screen = "teach";
    renderKey = "";
    await refresh();
  };
  const stop = root.querySelector("#teach-stop");
  if (stop) (stop as HTMLButtonElement).onclick = async () => {
    await fetch("/api/teach/stop", { method: "POST" });
    screen = "teach";
    renderKey = "";
    await refresh();
  };
  root.querySelectorAll<HTMLElement>("[data-card]").forEach((card) => {
    const id = card.dataset.card || "";
    const row = card.querySelector(".teach-row");
    if (row instanceof HTMLElement) row.onclick = () => {
      const opening = !card.classList.contains("open");
      root.querySelectorAll(".teach-card.open").forEach((el) => {
        el.classList.remove("open");
        el.querySelector(".teach-row")?.setAttribute("aria-expanded", "false");
      });
      card.classList.toggle("open", opening);
      row.setAttribute("aria-expanded", opening ? "true" : "false");
      teachOpenId = opening ? id : "";
    };
    card.querySelectorAll<HTMLButtonElement>("[data-correct]").forEach((btn) => {
      btn.onclick = () => {
        const kind = btn.dataset.correct || "";
        const row = btn.closest(".teach-value");
        const name = (row?.querySelector("input[data-param]") as HTMLInputElement | null)?.value
          || card.querySelector<HTMLInputElement>("[data-param]")?.value
          || "";
        const outcome = card.querySelector("p.meta")?.textContent?.replace(/^Expected:\s*/, "") || "";
        void correct(id, kind, { name, outcome });
      };
    });
    const intent = card.querySelector<HTMLInputElement>("[data-intent]");
    if (intent) intent.onchange = () => { void correct(id, "rename", { intent: intent.value }); };
    const note = card.querySelector<HTMLInputElement>("[data-note]");
    if (note) {
      const commit = () => {
        const pending = noteTimers.get(id);
        if (pending) window.clearTimeout(pending);
        noteTimers.delete(id);
        if (note.value.trim()) void correct(id, "note", { note: note.value });
      };
      note.oninput = () => {
        const pending = noteTimers.get(id);
        if (pending) window.clearTimeout(pending);
        const text = note.value;
        noteTimers.set(id, window.setTimeout(() => {
          noteTimers.delete(id);
          if (text.trim()) void correct(id, "note", { note: text });
        }, 450));
      };
      note.onchange = commit;
    }
  });
}

function paintGuide(): void {
  const float = document.getElementById("float");
  if (!float || state.teach?.phase === "live" || !state.guide) return;
  const html = guidePanel(state.guide);
  const current = float.querySelector("#guide-panel");
  if (current && current.parentElement === float && float.innerHTML === html) return;
  float.innerHTML = html;
}

function paintLive(): void {
  if (!captureTrailOwnsSteps(screen)) return;
  const host = document.getElementById("live-steps");
  if (!host) return;
  const live = (state as ShellState & { liveTrail?: { id?: string; op?: string; kind?: string }[] }).liveTrail || [];
  const html = liveStepList(live);
  if (host.innerHTML !== html) {
    host.innerHTML = html;
    mountShots(host);
  }
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
    openWorkflow = item.workflowId;
    screen = "workflow";
  } else if (item.screen) screen = item.screen as Screen;
  renderKey = "";
  render();
}

function stepMoment(step: { startedAt?: number; endedAt?: number } | undefined): number | undefined {
  if (!step) return undefined;
  if (typeof step.endedAt === "number") return step.endedAt;
  return step.startedAt;
}

function seekVideo(at: number | undefined): void {
  const video = document.getElementById("run-video") as HTMLVideoElement | null;
  const origin = Number((document.getElementById("video-bar") as HTMLElement | null)?.dataset.origin || 0);
  if (!video || typeof at !== "number" || !Number.isFinite(at)) return;
  const target = Math.max(0, (at - origin) / 1000);
  const apply = () => {
    if (video.seekable.length === 0) return false;
    const end = video.seekable.end(video.seekable.length - 1);
    if (!(end > 0)) return false;
    const clamped = Math.min(target, Math.max(0, end - 0.001));
    if (Math.abs(video.currentTime - clamped) > 0.05) video.currentTime = clamped;
    video.pause();
    return true;
  };
  if (apply()) return;
  const retry = () => {
    if (!apply()) return;
    video.removeEventListener("loadedmetadata", retry);
    video.removeEventListener("progress", retry);
    video.removeEventListener("canplay", retry);
  };
  video.addEventListener("loadedmetadata", retry);
  video.addEventListener("progress", retry);
  video.addEventListener("canplay", retry);
}

function paintToasts(): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const items = [banner, ...(state.notices || [])].flatMap((item) => {
    if (!item || !item.title) return [];
    const id = ("id" in item && item.id) ? item.id : item.title;
    if (dismissed.has(id)) return [];
    return [{ id, title: item.title, body: item.body }];
  });
  host.innerHTML = notices(items);
  host.querySelectorAll<HTMLButtonElement>("[data-dismiss]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.dismiss || "";
      if (id) dismissed.add(id);
      if (banner && banner.id === id) banner = null;
      paintToasts();
    };
  });
}

function bindShare(host: HTMLElement, id: string): void {
  const opener = host.querySelector("[data-testid=share-open]") as HTMLButtonElement | null;
  const panel = host.querySelector("[data-testid=share-panel]") as HTMLElement | null;
  opener?.addEventListener("click", () => {
    if (!panel || !opener) return;
    const open = panel.hasAttribute("hidden");
    if (open) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
    opener.setAttribute("aria-expanded", open ? "true" : "false");
  });
  const copy = host.querySelector("[data-testid=share-copy]") as HTMLButtonElement | null;
  copy?.addEventListener("click", () => {
    const link = copy.dataset.copy || "";
    if (navigator.clipboard) void navigator.clipboard.writeText(link).catch(() => undefined);
  });
  const publish = host.querySelector("[data-testid=share-publish]") as HTMLButtonElement | null;
  if (publish && !publish.disabled) {
    publish.addEventListener("click", async () => {
      const res = await fetch("/api/workflows/" + encodeURIComponent(id) + "/publish", { method: "POST" });
      const body = await res.json() as { why?: string; error?: string };
      if (res.ok && body.why === undefined) return;
      publish.disabled = true;
      const why = host.querySelector("[data-testid=share-publish-why]");
      const sentence = body.why || body.error || "The clean replay did not pass.";
      if (why) why.textContent = sentence;
      else publish.insertAdjacentHTML("afterend", `<p class="share-why" data-testid="share-publish-why">${esc(sentence)}</p>`);
    });
  }
  const exp = host.querySelector("[data-testid=share-export]") as HTMLButtonElement | null;
  if (exp && !exp.disabled) {
    exp.addEventListener("click", async () => {
      const body = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json();
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }
  const guide = host.querySelector("[data-testid=share-guide]") as HTMLButtonElement | null;
  if (guide && !guide.disabled) {
    guide.addEventListener("click", async () => {
      const res = await fetch("/api/workflows/" + encodeURIComponent(id) + "/guide");
      if (!res.ok) return;
      const blob = new Blob([await res.text()], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id.replace(/[^A-Za-z0-9._-]/g, "_")}-guide.html`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }
}

async function stepCrops(runId: string): Promise<Record<string, string>> {
  const shots: Record<string, string> = {};
  try {
    const res = await fetch("/api/runs/" + encodeURIComponent(runId));
    if (!res.ok) return shots;
    const run = await res.json() as { id?: string; steps?: { id?: string; afterShot?: string; beforeShot?: string }[] };
    const id = run.id || runId;
    for (const step of run.steps || []) {
      if (!step.id) continue;
      const src = imageRef(id, step.afterShot) || imageRef(id, step.beforeShot);
      if (src) shots[step.id] = src;
    }
  } catch { /* the card still tries the capture crop */ }
  return shots;
}

function mountShots(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-shot]").forEach((node) => {
    if (node.dataset.shotMounted === "1") return;
    node.dataset.shotMounted = "1";
    const primary = node.dataset.shot || "";
    const fallback = node.dataset.shotFallback || "";
    const load = (src: string, next?: string) => {
      if (!src) {
        if (next) load(next);
        return;
      }
      const img = new Image();
      img.alt = "";
      img.onload = () => {
        if (!node.isConnected) return;
        if (img.naturalWidth === 96 && img.naturalHeight === 54) {
          if (next) load(next);
          return;
        }
        node.classList.add("has-shot");
        node.prepend(img);
      };
      img.onerror = () => {
        if (next) load(next);
      };
      img.src = src;
    };
    const existing = node.querySelector("img");
    if (existing) {
      const show = () => {
        if (node.isConnected) node.classList.add("has-shot");
      };
      if (existing.complete && existing.naturalWidth > 0) {
        if (existing.naturalWidth === 96 && existing.naturalHeight === 54) {
          existing.remove();
          node.classList.remove("has-shot");
          if (fallback) load(fallback);
          return;
        }
        show();
        return;
      }
      existing.addEventListener("load", () => {
        if (existing.naturalWidth === 96 && existing.naturalHeight === 54) {
          existing.remove();
          node.classList.remove("has-shot");
          if (fallback) load(fallback);
          return;
        }
        show();
      });
      existing.addEventListener("error", () => {
        existing.remove();
        node.classList.remove("has-shot");
        if (fallback) load(fallback);
      });
      return;
    }
    load(primary, fallback);
  });
}

function mountStage(stage: HTMLElement): void {
  const which = stage.dataset.which || (stage.dataset.after ? "after" : "before");
  const url = which === "before" ? stage.dataset.before || "" : stage.dataset.after || stage.dataset.before || "";
  stage.querySelectorAll("img").forEach((img) => img.remove());
  stage.classList.remove("has-shot");
  if (!url) return;
  const img = new Image();
  img.alt = "";
  img.onload = () => {
    if (!stage.isConnected) return;
    stage.classList.add("has-shot");
    stage.prepend(img);
  };
  img.src = url;
}

function mountCompare(node: HTMLElement): void {
  const load = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.alt = "";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  void Promise.all([load(node.dataset.before || ""), load(node.dataset.after || "")]).then(([before, after]) => {
    if (!node.isConnected) return;
    if (before) {
      before.className = "compare-before";
      node.prepend(before);
      node.classList.add("has-shot");
    }
    if (after) {
      after.id = "compare-top";
      after.className = "compare-after";
      node.prepend(after);
      node.classList.add("has-shot");
    }
    const slider = document.getElementById("shot-slider") as HTMLInputElement | null;
    const top = document.getElementById("compare-top") as HTMLImageElement | null;
    if (slider && top) {
      const paint = () => {
        const right = 100 - Number(slider.value);
        top.style.clipPath = `inset(0 ${right}% 0 0)`;
      };
      slider.oninput = paint;
      paint();
    }
  });
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

void refresh();
// The login bar has to be on screen within a second of replay. This poll is what paints it.
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  refresh().catch(() => undefined).finally(() => { polling = false; });
}, 100);
setInterval(tickClock, 250);
