// Desktop window. Talks only to this machine's bao server.

import { formatWait } from "../v1/human-ask";
import { activePolling, createStatePoller } from "./state-poll";
import { shellScreen, shellScreens, type Screen } from "./shell-navigation";
import type { OpenedView } from "./deeplink";
import { bindDesktopMcp, desktopMcpSettings } from "./desktop-mcp-view";
import { settingsIndex, settingsScreen } from "./settings-view";
import { expandControlKey } from "../v1/visible-copy";
import { trajectoryFromWorkflow } from "../v1/trajectory";
import type { WorkflowV2 } from "../v1/schema";
import { oneTimeCodeInput } from "../../../shared/saved-secrets";
import type { inspectRunView } from "../mcp/run-view";
import type { DamagedWorkflow, Settings } from "../v1/store";
import { captureTrailOwnsSteps, livePageFromQuery, liveRunView, liveSessionView, screenFromQuery } from "./live-view";
import type { LiveSessionRecord } from "../cdp-live/live-record";
import { emptyLogin, loginAct, loginsScreen, needsSignInHtml, preferredDirectory, syncPanel, type LoginForm, type SavedSite } from "./logins-view";
import type { PublicImportResult, PublicPreview } from "../login-import/types";
import {
  actBar,
  remoteBanner,
  commandItems,
  esc,
  healDetail,
  healInbox,
  healWorkflowName,
  importCard,
  consolePane,
  runConsoleLines,
  inputsPane,
  guidePanel,
  libraryTable,
  networkPane,
  liveStepList,
  captureView,
  captureStream,
  notices,
  paletteView,
  rail,
  shellList,
  recordBar,
  saveSheetView,
  runsWelcome,
  connectionError,
  runReceipt,
  receiptError,
  runWorkflowName,
  runAttention,
  shellAttentionCount,
  runWaitLeft,
  reviewItems,
  runViewer,
  runField,
  hostAccessPanel,
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
  workflowConflicts,
  workflowSidebarToggle,
  runDriverField,
  runHealField,
  type CommandItem,
  type HealView,
  type ImportPending,
  type RunSummary,
  type ShellState,
  type WorkflowSummary,
} from "./views";

let state: ShellState & {
  notices?: { id?: string; title?: string; body?: string; runId?: string; stepId?: string }[];
  settings?: Partial<Settings>;
  profileCopy?: { bytes: number; copyMs: number; status: "open" | "deleted" };
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
  workflows?: WorkflowSummary[];
  runs?: RunSummary[];
  opened?: OpenedView | null;
  liveTargetOverride?: string;
  liveSession?: LiveSessionRecord | null;
  damagedWorkflows?: DamagedWorkflow[];
  librarySplits?: string[];
  home?: string;
} = {};
let conflictCopy: { id: string; name: string; steps: string[] } | null = null;
let settingsSection = "runs";
let settingsFeedback = "";
let screen: Screen = screenFromQuery(location.search) || "runs";
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
let stateLoaded = false;
let initialConnectionError = false;
let receiptOffset = 0;
let evidenceOpen = false;
let runRequest = 0;
let renderedDetail = "";
let liveRequest = 0;
let liveViewElement: HTMLElement | null = null;
let liveViewKey = "";
let railHtmlKey = "";
let listHtmlKey = "";
let libraryQuery = "";
let librarySearchOpen = false;
let libraryRecovery: { key: string; visible: boolean; open: boolean; status: string } | null = null;
let paletteOpen = false;
let paletteQuery = "";
let paletteActive = 0;
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
let captureName = "";
let captureUrl = fixtureStartValue();
let captureError = "";
let captureBusy = false;
let capturePicking = false;
try {
  theme = localStorage.getItem("bao-theme") === "dark" ? "dark" : "light";
} catch { /* private mode */ }
const railEl = () => document.getElementById("rail")!;
const actEl = () => document.getElementById("act")!;
const mainEl = () => document.getElementById("main")!;
let keyboardInput = false;
function focusMain(options?: FocusOptions): void {
  mainEl().dataset.keyboardFocus = String(keyboardInput);
  mainEl().focus(options);
}
document.addEventListener("pointerdown", () => {
  keyboardInput = false;
  mainEl().dataset.keyboardFocus = "false";
}, true);
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || (event.altKey && event.key !== "Tab")) return;
  if (!["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
  keyboardInput = true;
  mainEl().dataset.keyboardFocus = "true";
}, true);

let chromeProfiles: { directory: string; name: string; email: string }[] = [];

async function loadHostAccess(): Promise<void> {
  await Promise.all([
    fetch("/api/extension/host-access").catch(() => undefined),
    fetch("/api/chrome-profiles").then(async (response) => {
      if (response.ok) chromeProfiles = (await response.json()).profiles || [];
    }).catch(() => undefined),
  ]);
  renderKey = "";
  await refresh();
}

function refresh(): Promise<void> {
  return statePoller.refresh();
}

async function refreshState(): Promise<void> {
  try {
    await loadState();
  } catch (error) {
    if (!stateLoaded && !initialConnectionError) {
      initialConnectionError = true;
      render();
    }
    throw error;
  }
}

async function loadState(): Promise<void> {
  try {
    const stored = localStorage.getItem("bao-theme");
    if (stored === "dark" || stored === "light") theme = stored;
  } catch { /* private mode */ }
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error(`state request failed: ${response.status}`);
  const recovering = initialConnectionError;
  const firstLoad = !stateLoaded;
  const liveId = state.activeRun?.id;
  state = await response.json();
  stateLoaded = true;
  initialConnectionError = false;
  const opened = state.opened;
  if (opened) {
    const token = opened.kind === "receipt" ? `receipt:${opened.id}:${opened.request}` : `${opened.kind}:${opened.id}:${opened.saved}:${JSON.stringify(opened.inputs || {})}`;
    if (token !== seenOpen) {
      seenOpen = token;
      if (opened.kind === "import") screen = "import";
      else if (opened.kind === "receipt") selectRun(opened.id);
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
  if (screen === "live" && liveId && !state.activeRun) selectRun(liveId);
  if (screen === "runs" && !opened) selectDefaultRun();
  const key = JSON.stringify({
    recording: state.recording,
    replaying: state.replaying,
    pending: state.pendingImport,
    activeRun: state.activeRun,
    ask: state.activeAsk,
    liveSteps: screen === "live" ? state.runs?.find((run) => run.id === state.activeRun?.id)?.steps : undefined,
    notices: state.notices,
    workflows: state.workflows,
    damagedWorkflows: state.damagedWorkflows,
    settings: state.settings,
    profileCopy: state.profileCopy,
    runs: (state.runs || []).map((run) => ({
      id: run.id, workflowId: run.workflowId, status: run.status, envelopeStatus: run.envelope?.status,
      at: run.at, kind: run.kind, modelCalls: run.modelCalls,
      envelope: run.envelope, failure: run.failure,
      heals: run.heals?.map((heal) => [heal.id, heal.failedStep]), decisions: run.decisions, promotionStatus: run.promotion?.status,
    })),
    day: new Date().toDateString(),
    reviews: reviewItems(state.runs).map((item) => `${item.workflowId}:${item.stepId}`),
    helper: state.helper,
    model: state.model,
    paused: state.capturePaused,
    captureUrl: state.capture?.url,
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
  render(!firstLoad);
  if (recovering) focusMain({ preventScroll: true });
  paintGuide();
}

function render(focusDetail = true): void {
  const recoveryKey = screen === "library" ? JSON.stringify(state.damagedWorkflows || []) : null;
  const keepLibraryRecovery = libraryRecovery !== null && libraryRecovery.key === recoveryKey;
  if (!keepLibraryRecovery) libraryRecovery = recoveryKey === null ? null : { key: recoveryKey, visible: false, open: false, status: "" };
  applyTheme();
  const live = state.activeRun;
  if (screen === "logins") readLoginForm();
  const railHtml = rail(state, screen);
  const focused = document.activeElement as HTMLElement | null;
  const settingsFocus = screen === "settings" && focused?.closest("#settings") ? focused.id : "";
  const captureFocus = screen === "capture" && focused?.closest("#capture-panel, .capture-controls") ? focused.id : "";
  const captureCaret = focused instanceof HTMLInputElement && captureFocus ? focused.selectionStart : null;
  const settingsDetails = screen === "settings" ? [...document.querySelectorAll<HTMLDetailsElement>("#settings details[id][open]")].map((details) => details.id) : [];
  const customWait = document.getElementById("act-custom") as HTMLInputElement | null;
  const settingsDrafts = screen === "settings" ? [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#settings [data-settings-draft], #settings [data-setting]")].filter((input) => {
    if (input.id === "act-minutes" && input.value === "custom") return customWait === focused || customWait?.validity.valid === false;
    return input.dataset.settingsEdited === "true" || (input instanceof HTMLSelectElement
      ? input.value !== (([...input.options].find((option) => option.defaultSelected) ?? input.options[0])?.value ?? "")
      : input.type === "checkbox" || input.type === "radio" ? input.checked !== input.defaultChecked : input.value !== input.defaultValue);
  }).map((input) => [input.id, input instanceof HTMLInputElement && (input.type === "checkbox" || input.type === "radio") ? input.checked : input.value, input.dataset.settingsEdited === "true"] as const) : [];
  const focusedNav = focused?.closest("#rail, #screen-list");
  const focusedRun = focused?.dataset.openRun;
  const focusedHeal = focused?.dataset.heal;
  const focusedHealRun = focused?.dataset.run;
  const focusedRunGroup = focused?.closest("section")?.getAttribute("aria-label");
  const focusSelector = !focusedNav ? "" : focused?.id ? `#${focused.id}` : focused?.dataset.screen ? `#${focusedNav.id} button[data-screen="${focused.dataset.screen}"]` : "";
  const runsScroll = document.getElementById("runs")?.scrollTop || 0;
  const runsPlace = shellScreens[shellScreen(screen)].place === "runs";
  document.getElementById("app")!.dataset.runsDetail = screen === "run" || screen === "live" || (screen === "heals" && Boolean(openHeal)) ? "true" : "false";
  document.getElementById("app")!.dataset.capture = screen === "capture" ? "true" : "false";
  document.getElementById("content")!.classList.toggle("capture-content", screen === "capture");
  document.getElementById("app")!.dataset.workflowsList = screen === "library" ? "true" : "false";
  document.getElementById("app")!.dataset.workflowDetail = screen === "workflow" ? "true" : "false";
  document.getElementById("content")!.classList.toggle("runs-content", runsPlace);
  document.getElementById("content")!.classList.toggle("heal-content", screen === "heals" && Boolean(openHeal));
  document.getElementById("content")!.classList.toggle("workflows-content", screen === "library" || screen === "workflow");
  document.getElementById("content")!.classList.toggle("settings-content", screen === "settings");
  if (railHtmlKey !== railHtml) {
    railEl().innerHTML = railHtml;
    railHtmlKey = railHtml;
  }
  const list = document.getElementById("screen-list")!;
  const listHtml = screen === "settings" ? settingsIndex({ ...state, sites: login.saved }) : shellList(screen, state, screen === "live" ? live?.id || "" : screen === "run" ? openRun : "", !initialConnectionError, screen === "heals" ? openHeal : null);
  if (listHtmlKey !== listHtml) {
    list.innerHTML = listHtml;
    listHtmlKey = listHtml;
    const runs = document.getElementById("runs");
    if (runs) runs.scrollTop = runsScroll;
    if (focusedRun) {
      const copies = [...list.querySelectorAll<HTMLElement>("[data-open-run]")].filter((row) => row.dataset.openRun === focusedRun);
      const target = copies.find((row) => row.closest("section")?.getAttribute("aria-label") === focusedRunGroup) || copies[0];
      target?.focus();
    } else if (focusedHeal) {
      [...list.querySelectorAll<HTMLElement>("[data-heal]")].find((row) => row.dataset.heal === focusedHeal && row.dataset.run === focusedHealRun)?.focus();
    }
  }
  if (focusSelector && !focused?.isConnected) document.querySelector<HTMLElement>(focusSelector)?.focus();
  document.getElementById("app")!.dataset.liveDetail = screen === "live" && Boolean(live) ? "true" : "false";
  const title = document.getElementById("screen-title")!;
  if (screen === "live" && live) {
    title.innerHTML = `<button type="button" data-open-workflow="${esc(live.workflowId)}">Open workflow</button><button type="button" id="palette-open" aria-label="Search workflows and runs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4"/><path d="m10 10 3.5 3.5"/></svg></button>`;
  } else title.textContent = shellScreens[shellScreen(screen)].label;
  const importAsk = screen === "logins" ? loginAct(login) : "";
  actEl().innerHTML = remoteBanner(state.remote) + (screen === "live" && live ? "" : importAsk || actBar(state)) + importCard(state.pendingImport as ImportPending);
  const float = document.getElementById("float");
  if (float && state.teach?.phase !== "live" && !state.guide) float.innerHTML = recordBar(state, screen === "capture", capturePicking) + (state.extractPicker || "");
  const replayId = lastWf || (state.workflows && state.workflows[0]?.id) || "";
  const openArgs = document.getElementById("args");
  const keepReplay = screen === "replay" && !deeplinkPending && openArgs !== null && openArgs.childElementCount > 0 && argsWorkflow === replayId;
  const keepWorkflow = screen === "workflow" && document.getElementById("workflow-host")?.getAttribute("data-workflow") === openWorkflow;
  const keepImport = screen === "import" && document.getElementById("import-sheet")?.getAttribute("data-id") === state.opened?.id;
  const keepLive = screen === "live" && live && document.getElementById("live-run")?.dataset.run === live.id;
  if (!keepReplay && !keepWorkflow && !keepImport && !keepLive) {
    const body = initialConnectionError ? connectionError()
      : screen === "capture" ? capture()
      : screen === "teach" ? teachScreen()
      : screen === "runs" ? runsWelcome(Boolean(state.runs?.length))
      : screen === "live" ? live ? liveRunView(live) : liveSessionView(state.liveSession, livePageFromQuery(location.search))
      : screen === "run" ? `<section id="run-host"><p class="meta">Loading run…</p></section>`
      : screen === "heals" ? openHeal ? `<div id="heal-detail"><p class="quiet">Loading target review…</p></div>` : healInbox(state.runs || [], state.workflows || [], healFilter)
      : screen === "settings" ? settings()
      : screen === "logins" ? loginsScreen(login)
      : screen === "replay" ? replayForm()
      : screen === "import" ? importSheet()
      : screen === "workflow" ? `<section id="workflow-host" data-workflow="${esc(openWorkflow)}"><div class="wf-toolbar">${workflowSidebarToggle()}</div><p class="meta">Loading workflow…</p></section>`
      : libraryTable(state.workflows || [], state.runs || [], state.promotions || [], state.librarySplits || [], state.home || "", state.damagedWorkflows || []);
    const typingSearch = document.activeElement?.id === "library-search";
    const caret = typingSearch ? (document.activeElement as HTMLInputElement).selectionStart : null;
    const recovery = keepLibraryRecovery ? document.querySelector<HTMLDetailsElement>("#library-damaged details") : null;
    const focusedRecovery = recovery?.querySelector("summary") === document.activeElement;
    if (recovery && libraryRecovery) {
      libraryRecovery.visible = !recovery.hidden;
      libraryRecovery.open = recovery.open;
    }
    mainEl().querySelectorAll<HTMLInputElement>('input[type="number"][data-setting]').forEach((input) => {
      input.onblur = null;
      input.onchange = null;
    });
    mainEl().innerHTML = body;
    const nextRecovery = document.querySelector<HTMLDetailsElement>("#library-damaged details");
    if (nextRecovery && libraryRecovery) {
      nextRecovery.hidden = !libraryRecovery.visible;
      nextRecovery.open = libraryRecovery.open;
      if (focusedRecovery) nextRecovery.querySelector("summary")?.focus();
    }
    const revealStatus = document.getElementById("library-reveal-status");
    if (revealStatus && libraryRecovery) revealStatus.textContent = libraryRecovery.status;
    const search = document.getElementById("library-search") as HTMLInputElement | null;
    if (search) search.value = libraryQuery;
    const tools = document.getElementById("library-tools");
    if (tools) tools.hidden = !librarySearchOpen;
    document.getElementById("library-search-open")?.setAttribute("aria-expanded", String(librarySearchOpen));
    if (typingSearch && search) {
      search.focus();
      if (caret != null) search.setSelectionRange(caret, caret);
    }
    if (screen === "replay") void fillArgs(replayId);
  }
  for (const id of settingsDetails) document.getElementById(id)?.setAttribute("open", "");
  for (const [id, value, edited] of settingsDrafts) {
    const input = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (input instanceof HTMLInputElement && typeof value === "boolean") input.checked = value;
    else if (input && typeof value === "string") input.value = value;
    if (input && edited) input.dataset.settingsEdited = "true";
  }
  bind();
  if (settingsFocus && !focused?.isConnected) document.getElementById(settingsFocus)?.focus({ preventScroll: true });
  if (captureFocus && !focused?.isConnected) {
    const input = document.getElementById(captureFocus);
    input?.focus({ preventScroll: true });
    if (input instanceof HTMLInputElement && captureCaret !== null) input.setSelectionRange(captureCaret, captureCaret);
  }
  applySearch();
  paintPalette();
  paintLive();
  paintSaveSheet();
  mountShots();
  paintToasts();
  const detail = screen === "workflow" ? `workflow:${openWorkflow}` : screen === "run" ? `run:${openRun}` : screen === "heals" && openHeal ? `heal:${openHeal.runId}:${openHeal.healId}` : screen === "live" ? "live" : "";
  if (detail && detail !== renderedDetail) {
    if (focusDetail) focusMain({ preventScroll: true });
    document.getElementById("content")!.scrollTop = 0;
  }
  renderedDetail = detail;
  if (screen === "live" && live) void showLiveRun();
  if (screen === "workflow" && openWorkflow && !keepWorkflow) void openEditor(openWorkflow);
  if (!initialConnectionError && screen === "run" && openRun) void showRun(openRun);
  if (screen === "heals" && openHeal) void showHeal(openHeal.runId, openHeal.healId);
}

async function showLiveRun(): Promise<void> {
  const live = state.activeRun;
  if (!live) return;
  const request = ++liveRequest;
  const read = async <T,>(url: string): Promise<T | null> => {
    try {
      const response = await fetch(url);
      return response.ok ? await response.json() as T : null;
    } catch { return null; }
  };
  const [workflow, run] = await Promise.all([
    read<WorkflowV2>(`/api/workflows/${encodeURIComponent(live.workflowId)}`),
    read<RunSummary>(`/api/runs/${encodeURIComponent(live.id)}`),
  ]);
  const currentLive = state.activeRun;
  if (request !== liveRequest || screen !== "live" || currentLive?.id !== live.id || currentLive.phase !== live.phase || currentLive.ask?.stepId !== live.ask?.stepId || currentLive.ask?.startedAt !== live.ask?.startedAt) return;
  const current = document.getElementById("live-run");
  const continuing = live.phase === "running";
  const key = JSON.stringify({ live, run, workflow });
  if (current === liveViewElement && key === liveViewKey) return;
  const expanded = document.querySelector<HTMLDetailsElement>("#live-run-details")?.open;
  const modal = document.querySelector<HTMLDialogElement>("#live-stop-dialog")?.open;
  const focused = document.activeElement as HTMLElement | null;
  const focusId = current?.contains(focused) ? focused?.id : "";
  const stepKey = `${live.id}:${live.ask?.stepId ?? ""}:${live.ask?.startedAt ?? ""}`;
  const message = current?.dataset.step === stepKey && current.querySelector<HTMLButtonElement>("#act-continue")?.disabled !== true ? document.getElementById("live-action-status")?.textContent || "" : "";
  const view = liveRunView(live, run, workflow);
  if (current?.dataset.run === live.id) {
    const template = document.createElement("template");
    template.innerHTML = view;
    const next = template.content.firstElementChild!;
    current.setAttribute("data-step", next.getAttribute("data-step")!);
    current.setAttribute("aria-label", next.getAttribute("aria-label")!);
    current.replaceChildren(...next.childNodes);
  } else mainEl().innerHTML = view;
  liveViewElement = document.getElementById("live-run");
  liveViewKey = key;
  if (expanded) document.getElementById("live-run-details")?.setAttribute("open", "");
  if (modal) document.querySelector<HTMLDialogElement>("#live-stop-dialog")?.showModal();
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  if (!continuing) document.getElementById("live-action-status")!.textContent = message;
  bindAsk();
}

function capture(): string {
  return captureView(state, { name: captureName, startUrl: captureUrl, error: captureError, busy: captureBusy, picking: capturePicking });
}

async function captureAction(action: "start" | "save" | "discard"): Promise<void> {
  if (captureBusy || (state.teach && state.teach.phase !== "idle")) return;
  if (action === "discard" && !confirm("Discard this recording? The steps you recorded are deleted. You can’t undo this.")) return;
  captureBusy = true;
  captureError = "";
  render();
  try {
    const endpoint = action === "start" ? "/api/sessions" : action === "save" ? "/api/sessions/stop" : "/api/sessions/discard";
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: action === "start" ? JSON.stringify({ url: captureUrl }) : "{}" });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Could not update the recording. Try again.");
    if (action === "save") {
      const saved = await fetch("/api/sessions/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: captureName.trim() || undefined }) });
      const doc = await saved.json() as { id?: string; error?: string };
      if (!saved.ok || !doc.id) throw new Error(doc.error || "Could not save the recording. Try saving again in the save dialog.");
      openWorkflow = doc.id;
      screen = "workflow";
    } else if (action === "discard") screen = "library";
    if (action !== "start") captureName = "";
    capturePicking = false;
  } catch (error) {
    captureError = error instanceof Error ? error.message : "Could not update the recording. Try again.";
  } finally {
    captureBusy = false;
    renderKey = "";
    await refresh().catch(() => undefined);
    render();
  }
}

async function discardTeachReview(): Promise<void> {
  if (captureBusy || state.teach?.phase !== "review") return;
  if (!confirm("Discard this Teach review? The steps you recorded are deleted. You can’t undo this.")) return;
  captureBusy = true;
  captureError = "";
  render();
  try {
    const response = await fetch("/api/teach/discard", { method: "POST" });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "Could not discard the Teach review. Try again.");
  } catch (error) {
    captureError = error instanceof Error ? error.message : "Could not discard the Teach review. Try again.";
  } finally {
    captureBusy = false;
    renderKey = "";
    await refresh().catch(() => undefined);
    render();
  }
}

function teachScreen(): string {
  const teach = state.teach;
  if (teach?.phase === "review") return teachReview(teach);
  if (teach?.phase === "live") {
    return `<section><h2>Teach</h2><p class="lede">The teach panel names each step as it lands. Click a row to correct it.</p></section>`;
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
    ? `<p id="run-prefill">Prefilled from the link.</p>`
    : "";
  return `<section id="run-form"><h2>Run ${esc(current?.name || "")}</h2>
    <p class="lede">Saved inputs are ready to replay. Change any value before the run.</p>
    ${prefill}
    ${fromLine()}
    <label>Workflow <select id="wf">${options}</select></label>
    ${runDriverField(current?.driver)}
    ${runHealField(current?.driver, mode, globalHeal)}
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
  if (debugStepId) return `<p id="debug-note">Debug from this step (${esc(debugStepId)}). Earlier steps are not re-run.</p>`;
  return "";
}

function settings(): string {
  const circuit = state.settings?.circuitLimit ?? 3;
  const libraryHome = state.home ? `<p class="meta" id="settings-home">Library: ${esc(state.home)}</p>` : "";
  return settingsScreen({ ...state, sites: login.saved }, `${libraryHome}
    ${desktopMcpSettings()}
    <div class="card" id="page-engine-settings">
      <h3>Page engine</h3>
      <label>Run engine <select id="page-engine" data-settings-draft>
        <option value="old" ${state.settings?.pageEngine !== "agent-browser" ? "selected" : ""}>Current engine (default)</option>
        <option value="agent-browser" ${state.settings?.pageEngine === "agent-browser" ? "selected" : ""}>agent-browser (trial)</option>
      </select></label>
      <label>Chrome profile for agent-browser <select id="chrome-profile" data-settings-draft ${state.settings?.pageEngine !== "agent-browser" ? "disabled" : ""}>
        <option value="">Choose a Chrome profile</option>
        ${chromeProfiles.map((profile) => `<option value="${esc(profile.directory)}" ${state.settings?.chromeProfile === profile.directory ? "selected" : ""}>${esc(profile.name)}${profile.email ? ` - ${esc(profile.email)}` : ""} (${esc(profile.directory)})</option>`).join("")}
      </select></label>
      <label class="extensions-choice"><input id="chrome-profile-extensions" data-settings-draft type="checkbox" aria-describedby="chrome-extensions-help" ${state.settings?.chromeProfileExtensions?.[state.settings?.chromeProfile || ""] === true ? "checked" : ""} ${state.settings?.pageEngine !== "agent-browser" || !state.settings?.chromeProfile ? "disabled" : ""}> Load my Chrome extensions</label>
      <p class="quiet" id="chrome-extensions-help">Shopping and coupon extensions can cover pages and block the agent.</p>
      <p class="quiet">Each agent-browser run gets a fresh, private copy. Bao leaves your original Chrome untouched, turns sync off in the copy, and deletes the copy when the session ends unless you keep the window open after the agent disconnects or Bao MCP stops. A kept copy stays on disk until the next agent session cleans it up, even if you close its window by hand. No remote-debugging switch, Accessibility, or Automation is needed.</p>
      ${state.profileCopy ? `<p class="meta">Last copy: ${(state.profileCopy.bytes / 1024 / 1024).toFixed(1)} MiB in ${(state.profileCopy.copyMs / 1000).toFixed(1)} seconds. ${state.profileCopy.status === "deleted" ? "Copy deleted." : "Run open."}</p>` : ""}
      <button id="save-engine" type="button">Save engine choice</button>
      <p id="engine-feedback" role="status"></p>
    </div>
    <div class="card" id="agent-window-settings">
      <h3>Agent window</h3>
      <label><input id="keep-agent-browser-open" data-settings-draft type="checkbox" aria-describedby="agent-browser-lifetime-help" ${state.settings?.keepAgentBrowserOpen === true ? "checked" : ""}> Keep window open after agent finishes</label>
      <p class="quiet" id="agent-browser-lifetime-help">Off by default. Bao closes the marked Chrome window and deletes its private profile copy when the agent disconnects or Bao MCP stops. Turn this on to finish a task by hand. The next agent session closes the kept window and deletes its copy before opening a fresh one. The agent's close command, or closing the window by hand during a live session, still closes Chrome and deletes its copy. Kept Chrome has no Bao owner and keeps a local debugging port open, even after you close its window, until you quit that Chrome or the next agent session reclaims its copy. Other local processes can use that port to read the copy's cookies or control its signed-in pages. Your original Chrome stays untouched.</p>
      <button id="save-agent-browser-lifetime" type="button">Save window choice</button>
      <p id="agent-browser-lifetime-feedback" role="status"></p>
    </div>
    ${hostAccessPanel(state.settings?.hostAccess)}
    <p class="quiet">AI help uses the source chosen above. After ${esc(String(circuit))} failed runs in a short window, auto-heal stays off.</p>
    <label>Failed runs that stop auto-heal <input id="circuit-limit" data-setting="circuitLimit" type="number" required min="1" max="50" value="${circuit}" aria-describedby="circuit-limit-error"></label><span id="circuit-limit-error" role="status" hidden></span>
    ${syncPanel(state.sync, conflictCopy)}
    <h3>Appearance</h3>
    <label>Theme <select id="theme">
      <option value="light" ${theme === "light" ? "selected" : ""}>Light</option>
      <option value="dark" ${theme === "dark" ? "selected" : ""}>Dark</option>
    </select></label>
    <p id="settings-helper">${state.helper?.platform === "darwin" ? `${state.helper?.label === "helper available" ? "Mac helper available" : "Mac helper unavailable"}. Chrome agents need no Accessibility, Automation, or Screen Recording permission.` : "The Mac helper is only available on macOS. Chrome agents do not need it."}</p>`);
}

function importSheet(): string {
  const opened = state.opened;
  if (!opened || opened.kind !== "import") return `<section id="import-sheet" data-testid="import-sheet"><h2>Import</h2><p>Nothing is waiting.</p></section>`;
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

function navigate(next: Screen): void {
  if (next === "heals") openHeal = null;
  screen = next;
  if (screen === "runs") selectDefaultRun();
  renderKey = "";
  if (screen === "logins") void loadSaved();
  if (screen === "settings") {
    settingsSection = "runs";
    settingsFeedback = "";
    void loadHostAccess();
    void loadSaved();
  }
  if (screen === "replay") {
    debugStepId = "";
    runFromN = 0;
    fromNote = "";
  }
  render();
  const sidebar = document.getElementById("sidebar-dialog") as HTMLDialogElement;
  if (sidebar.open) sidebar.close("navigate");
  focusMain();
  document.getElementById("content")!.scrollTop = 0;
}

function paintSettingsValidation(): void {
  document.querySelectorAll<HTMLInputElement>('#settings input[type="number"][data-setting]').forEach((input) => {
    const invalid = input.dataset.settingsEdited === "true" && !input.validity.valid;
    input.setAttribute("aria-invalid", String(invalid));
    const error = document.getElementById(`${input.id}-error`);
    if (error) {
      error.textContent = invalid ? input.validationMessage : "";
      error.hidden = !invalid || input.hidden;
    }
  });
}

function bindSettings(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-settings-jump]").forEach((link) => {
    if (link.dataset.settingsJump === settingsSection) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
    link.onclick = (event) => {
      event.preventDefault();
      settingsSection = link.dataset.settingsJump || "runs";
      document.querySelectorAll("[data-settings-jump]").forEach((item) => item.removeAttribute("aria-current"));
      link.setAttribute("aria-current", "true");
      document.getElementById(`set-${settingsSection}`)?.focus({ preventScroll: true });
      document.getElementById(`set-${settingsSection}`)?.scrollIntoView({ block: "start" });
    };
  });
  const feedback = document.getElementById("settings-feedback");
  if (feedback) feedback.textContent = settingsFeedback;
  const custom = document.getElementById("act-custom") as HTMLInputElement | null;
  const wait = document.getElementById("act-minutes") as HTMLSelectElement | null;
  if (custom && wait) custom.hidden = wait.value !== "custom";
  paintSettingsValidation();
  const saveSetting = async (patch: Record<string, unknown>) => {
    settingsFeedback = "Saving…";
    const status = document.getElementById("settings-feedback");
    if (status) status.textContent = settingsFeedback;
    try {
      const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const body = await response.json() as { error?: string };
      settingsFeedback = response.ok ? "Saved." : body.error || "Could not save. Try again.";
      if (response.ok) await refresh();
    } catch {
      settingsFeedback = "Could not save. Check that Bao is running, then try again.";
    } finally {
      const status = document.getElementById("settings-feedback");
      if (status) status.textContent = settingsFeedback;
    }
  };
  const source = document.getElementById("ai-source") as HTMLSelectElement | null;
  const keyForm = document.getElementById("ai-key-form") as HTMLFormElement | null;
  if (source && keyForm) {
    keyForm.hidden = source.value !== "api-key";
    source.onchange = () => {
      keyForm.hidden = source.value !== "api-key";
      if (source.value === "api-key") document.getElementById("ai-key")?.focus();
      else void saveSetting({ healSource: { kind: source.value } });
    };
    keyForm.onsubmit = (event) => {
      event.preventDefault();
      const key = (document.getElementById("ai-key") as HTMLInputElement).value.trim();
      const provider = (document.getElementById("ai-provider") as HTMLSelectElement).value;
      if (key) void saveSetting({ healSource: { kind: "api-key", provider, key } });
    };
  }
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]").forEach((input) => {
    const save = async () => {
      if (input.value === "custom") {
        const custom = document.getElementById("act-custom") as HTMLInputElement;
        custom.hidden = false;
        paintSettingsValidation();
        custom.focus();
        return;
      }
      if (!input.validity.valid) {
        paintSettingsValidation();
        return;
      }
      delete input.dataset.settingsEdited;
      const key = input.dataset.setting!;
      const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.type === "number" || key === "actTimeoutMin" ? Number(input.value) : input.value;
      await saveSetting({ [key]: value });
    };
    if (input instanceof HTMLInputElement && input.type === "number") {
      input.oninput = () => {
        input.dataset.settingsEdited = "true";
        paintSettingsValidation();
      };
      const commit = () => {
        if (input.dataset.settingsEdited === "true") void save();
      };
      input.onblur = commit;
      input.onchange = commit;
      input.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (!input.reportValidity()) {
            paintSettingsValidation();
            return;
          }
          if (Number(input.value) === Number(input.defaultValue)) {
            input.value = input.defaultValue;
            delete input.dataset.settingsEdited;
            return;
          }
          commit();
        }
      };
    } else input.onchange = save;
  });
}

function bind(): void {
  bindDesktopMcp();
  bindSettings();
  const retry = document.getElementById("retry-state");
  if (retry) retry.onclick = () => { void refresh().catch(() => document.getElementById("retry-state")?.focus()); };
  document.querySelectorAll<HTMLElement>("#runs-welcome [data-screen]").forEach((button) => {
    button.onclick = () => navigate(button.dataset.screen as Screen);
  });
  document.querySelectorAll<HTMLElement>("#library [data-screen=capture]").forEach((button) => {
    button.onclick = () => {
      navigate("capture");
    };
  });
  document.querySelectorAll<HTMLElement>("[data-damaged-file]").forEach((button) => {
    button.onclick = () => {
      const details = document.querySelector<HTMLDetailsElement>("#library-damaged details");
      if (details) {
        details.hidden = false;
        details.open = true;
        details.querySelector("summary")?.focus();
      }
    };
  });
  const revealWorkflow = document.getElementById("library-reveal") as HTMLButtonElement | null;
  if (revealWorkflow) revealWorkflow.onclick = async () => {
    const recovery = libraryRecovery;
    if (!recovery) return;
    revealWorkflow.disabled = true;
    try {
      const response = await fetch("/api/workflows/reveal", { method: "POST" });
      if (libraryRecovery !== recovery) return;
      if (!response.ok) throw new Error("Could not open the workflow folder.");
      recovery.status = "Workflow folder opened in Finder.";
    } catch {
      if (libraryRecovery !== recovery) return;
      recovery.visible = true;
      const details = document.querySelector<HTMLDetailsElement>("#library-damaged details");
      if (details) details.hidden = false;
      recovery.status = "Could not open the workflow folder. Open File details and recovery to find its path.";
    } finally {
      const status = document.getElementById("library-reveal-status");
      if (status && libraryRecovery === recovery) status.textContent = recovery.status;
      revealWorkflow.disabled = false;
    }
  };
  const sidebar = document.getElementById("sidebar-dialog") as HTMLDialogElement;
  bindSidebarToggle();
  const close = document.getElementById("sidebar-close");
  if (close) close.onclick = () => sidebar.close();
  document.querySelectorAll("#rail [data-screen], #screen-list [data-screen]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      navigate((btn as HTMLButtonElement).dataset.screen as Screen);
    };
  });
  const importLogin = document.querySelector<HTMLButtonElement>('#settings [data-screen="logins"]');
  if (importLogin) importLogin.onclick = () => navigate("logins");
  document.querySelectorAll("#main [data-screen=replay]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      lastWf = (btn as HTMLButtonElement).dataset.workflow || lastWf;
      navigate("replay");
    };
  });
  document.querySelectorAll("[data-open-run]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const sidebar = document.getElementById("sidebar-dialog") as HTMLDialogElement;
      if (sidebar.open) sidebar.close("navigate");
      selectRun((btn as HTMLButtonElement).dataset.openRun || "");
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
  const load = document.getElementById("load-trail");
  if (load) load.onclick = () => void loadTrail((document.getElementById("trail-id") as HTMLSelectElement).value, "trail-view");
  const discardReview = document.getElementById("capture-teach-discard");
  if (discardReview) discardReview.onclick = () => void discardTeachReview();
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
  bindTeach(document);
  const captureBack = document.querySelector<HTMLButtonElement>(".cap-back");
  if (captureBack) captureBack.onclick = () => navigate("library");
  const captureNameInput = document.getElementById("cap-name") as HTMLInputElement | null;
  if (captureNameInput) captureNameInput.oninput = () => { captureName = captureNameInput.value; };
  const captureUrlInput = document.getElementById("start-url") as HTMLInputElement | null;
  if (captureUrlInput) captureUrlInput.oninput = () => { captureUrl = captureUrlInput.value; };
  const start = document.getElementById("start");
  if (start) start.onclick = () => void captureAction("start");
  const stop = document.getElementById("stop");
  if (stop) stop.onclick = () => void captureAction("save");
  const discardCapture = document.getElementById("capture-discard");
  if (discardCapture) discardCapture.onclick = () => void captureAction("discard");
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
      selectRun(run.id, stepId);
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
  const saveLifetime = document.getElementById("save-agent-browser-lifetime");
  if (saveLifetime) saveLifetime.onclick = async () => {
    const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      keepAgentBrowserOpen: (document.getElementById("keep-agent-browser-open") as HTMLInputElement).checked,
    }) });
    const body = await response.json() as { error?: string };
    if (response.ok) { renderKey = ""; await refresh(); }
    const feedback = document.getElementById("agent-browser-lifetime-feedback");
    if (feedback) feedback.textContent = response.ok ? "Window choice saved." : body.error || "Could not save window choice.";
  };
  const engineChoice = document.getElementById("page-engine") as HTMLSelectElement | null;
  const profileChoice = document.getElementById("chrome-profile") as HTMLSelectElement | null;
  const extensionsChoice = document.getElementById("chrome-profile-extensions") as HTMLInputElement | null;
  const updateEngineControls = () => {
    if (profileChoice) profileChoice.disabled = engineChoice?.value !== "agent-browser";
    if (extensionsChoice) extensionsChoice.disabled = engineChoice?.value !== "agent-browser" || !profileChoice?.value;
  };
  updateEngineControls();
  if (engineChoice) engineChoice.onchange = updateEngineControls;
  if (profileChoice) profileChoice.onchange = () => {
    if (!extensionsChoice) return;
    extensionsChoice.checked = state.settings?.chromeProfileExtensions?.[profileChoice.value] === true;
    extensionsChoice.disabled = engineChoice?.value !== "agent-browser" || !profileChoice.value;
  };
  const saveEngine = document.getElementById("save-engine");
  if (saveEngine) saveEngine.onclick = async () => {
    const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
      pageEngine: engineChoice?.value || "old",
      chromeProfile: profileChoice?.value || "",
      ...(profileChoice?.value ? { chromeProfileExtensions: { [profileChoice.value]: extensionsChoice?.checked === true } } : {}),
    }) });
    if (!response.ok) {
      const body = await response.json();
      const feedback = document.getElementById("engine-feedback");
      if (feedback) feedback.textContent = body.error || "Could not save engine choice.";
      return;
    }
    renderKey = "";
    await refresh();
    const feedback = document.getElementById("engine-feedback");
    if (feedback) feedback.textContent = "Engine choice saved. It applies to the next run.";
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
      selectHeal((btn as HTMLButtonElement).dataset.run || "", (btn as HTMLButtonElement).dataset.heal || "");
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
  const searchOpen = document.getElementById("library-search-open");
  if (searchOpen) searchOpen.onclick = showLibrarySearch;
  const clearSearch = document.getElementById("library-clear-search");
  if (clearSearch && search) clearSearch.onclick = () => {
    libraryQuery = "";
    search.value = "";
    applySearch();
    search.focus();
  };
  const paletteBtn = document.getElementById("palette-open");
  if (paletteBtn) paletteBtn.onclick = openPalette;
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
    const response = await fetch("/api/sessions/extract/arm", { method: "POST" });
    if (screen === "capture" && response.ok) {
      capturePicking = true;
      render();
    }
  };
  if (captureBusy) document.querySelectorAll<HTMLButtonElement>(".capture-controls button").forEach((button) => { button.disabled = true; });
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
    capturePicking = false;
    renderKey = "";
    await refresh();
  };
  const recStop = document.getElementById("rec-stop");
  if (recStop) recStop.onclick = async () => {
    if (state.teach && state.teach.phase !== "idle") return;
    if (screen === "capture") return captureAction("save");
    await fetch("/api/sessions/stop", { method: "POST" });
    renderKey = "";
    await refresh();
  };
}

function paintSaveSheet(): void {
  const host = document.getElementById("sheet");
  if (!host) return;
  const sheet = state.saveSheet;
  if (!sheet || (screen === "capture" && captureBusy)) {
    if (host.innerHTML) host.innerHTML = "";
    return;
  }
  const existing = host.querySelector("#save-sheet");
  if (existing && existing.getAttribute("data-id") === sheet.id) return;
  host.innerHTML = saveSheetView(captureName.trim() ? { ...sheet, name: captureName } : sheet);
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
  captureName = "";
  captureError = "";
  screen = "workflow";
  renderKey = "";
  await refresh();
}

async function discardSaveSheet(): Promise<void> {
  await fetch("/api/sessions/save/discard", { method: "POST" });
  captureName = "";
  captureError = "";
  renderKey = "";
  await refresh();
}

function bindRemote(): void {
  const resume = document.getElementById("remote-continue");
  if (resume) resume.onclick = async () => {
    (resume as HTMLButtonElement).disabled = true;
    await fetch("/api/remote/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: resume.dataset.resume, stepId: resume.dataset.step }),
    });
    await refresh();
  };
  const kill = document.getElementById("remote-kill");
  if (kill) kill.onclick = () => void fetch("/api/remote/kill", { method: "POST" });
  const pair = document.getElementById("relay-pair");
  if (pair) pair.onclick = async () => {
    const code = (document.getElementById("relay-code") as HTMLInputElement | null)?.value || "";
    const response = await fetch("/api/remote/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (response.ok) {
      const input = document.getElementById("relay-code") as HTMLInputElement | null;
      if (input) input.value = input.defaultValue;
    }
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
  const active = state.activeRun;
  const action = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const cancel = document.getElementById("act-cancel");
  const cancelRunId = active?.id ?? (state.replaying ? state.guide?.runId : undefined);
  if (cancel && cancelRunId) cancel.onclick = () => void action("/api/replay/cancel", { runId: cancelRunId }).then(() => refresh());
  const cont = document.getElementById("act-continue");
  const ask = active?.phase === "waiting" ? active.ask : null;
  if (cont) cont.onclick = async () => {
    if (!active || !ask) return;
    const response = await action("/api/prompt/continue", { runId: active.id, stepId: ask.stepId, startedAt: ask.startedAt });
    const status = document.getElementById("live-action-status");
    if (status) status.textContent = response.ok ? "Bao is checking the page. The run waits until its check passes." : "Bao could not check the page. Try again.";
    await refresh();
  };
  const stop = document.getElementById("live-stop");
  const dialog = document.getElementById("live-stop-dialog") as HTMLDialogElement | null;
  if (stop && dialog) {
    stop.onclick = () => dialog.showModal();
    dialog.onclose = () => {
      if (dialog.returnValue === "stop" && active) void action("/api/replay/cancel", { runId: active.id }).then(() => refresh());
      else stop.focus();
    };
  }
  const yes = document.getElementById("import-yes");
  if (yes) yes.onclick = () => void answerImport({ accept: true });
  const no = document.getElementById("import-no");
  if (no) no.onclick = () => void answerImport({ accept: false });
  document.querySelectorAll("#act #import-pick [data-import-profile]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void answerImport({ accept: true, profile: (btn as HTMLButtonElement).dataset.importProfile });
  });
}

function bindHeal(): void {
  document.querySelectorAll("[data-keep]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => void decide(btn as HTMLButtonElement, "keep");
  });
  document.querySelectorAll("[data-revert]").forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const dialog = document.getElementById("heal-revert-confirm") as HTMLDialogElement;
      dialog.returnValue = "";
      dialog.onclose = () => { if (dialog.returnValue === "revert") void decide(btn as HTMLButtonElement, "revert"); };
      dialog.showModal();
    };
  });
}

async function decide(btn: HTMLButtonElement, decision: "keep" | "revert"): Promise<void> {
  const healId = decision === "keep" ? btn.dataset.keep : btn.dataset.revert;
  const runId = btn.dataset.run || "";
  const workflowId = btn.dataset.workflow || "";
  const host = btn.closest("#heal-detail");
  const controls = host?.querySelectorAll<HTMLButtonElement>("[data-keep]:not(:disabled), [data-revert]:not(:disabled)");
  controls?.forEach((control) => { control.disabled = true; });
  const status = host?.querySelector<HTMLElement>("#heal-decision-status");
  if (status) status.textContent = "";
  try {
    const runResponse = await fetch("/api/runs/" + encodeURIComponent(runId));
    if (!runResponse.ok) throw new Error("Run unavailable");
    const run = await runResponse.json() as RunSummary;
    const item = (run.heals || []).find((heal) => heal.id === healId);
    if (!item || !healId || (decision === "keep" && !item.proposedPatch)) throw new Error("Target unavailable");
    const response = await fetch(`/api/heal/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflowId, runId, healId, ...(decision === "keep" ? { stepId: item.failedStep?.id, patch: item.proposedPatch } : {}) }),
    });
    if (!response.ok) throw new Error("Decision failed");
    banner = {
      id: `decision-${decision}-${Date.now()}`,
      title: decision === "keep" ? "Patch kept" : "Patch reverted",
      body: decision === "keep" ? "Saved a draft. Replay still uses the live version until you promote it." : "Saved the recorded target as a draft. Replay still uses the live version until you promote it.",
    };
  } catch {
    if (status) status.textContent = `Could not ${decision === "keep" ? "keep" : "revert"} this target. Try again.`;
    controls?.forEach((control) => { control.disabled = false; });
    return;
  }
  renderKey = "";
  try {
    await refresh();
  } catch {
    if (status) status.textContent = "Draft saved. Could not refresh the view. Reload to see the saved decision.";
  }
}

async function showRun(id: string): Promise<void> {
  const request = ++runRequest;
  try {
    await loadRun(id, request);
  } catch {
    const host = document.getElementById("run-host");
    if (!host || screen !== "run" || openRun !== id || request !== runRequest) return;
    host.innerHTML = receiptError();
    document.getElementById("retry-run")!.onclick = () => { void showRun(id).then(() => focusMain({ preventScroll: true })); };
  }
}

async function loadRun(id: string, request: number): Promise<void> {
  const [runResponse, receiptResponse] = await Promise.all([
    fetch("/api/runs/" + encodeURIComponent(id)),
    fetch("/api/runs/" + encodeURIComponent(id) + "/receipt?step_offset=" + receiptOffset).catch(() => null),
  ]);
  if (!runResponse.ok) throw new Error("Run unavailable");
  const run = await runResponse.json() as RunSummary;
  const receipt = receiptResponse?.ok ? await receiptResponse.json().catch(() => null) as ReturnType<typeof inspectRunView> | null : null;
  const response = await fetch("/api/workflows/" + encodeURIComponent(run.workflowId));
  const workflow = response.ok
    ? await response.json() as { name: string; id: string; steps: { id: string; label?: string; action?: string }[]; recordedOnly?: boolean }
    : { name: runWorkflowName(run, state.workflows || []), id: run.workflowId, steps: run.steps || [], recordedOnly: true };
  const host = document.getElementById("run-host");
  if (!host || screen !== "run" || openRun !== id || request !== runRequest) return;
  const timings = (run.steps || []).map((step) => Math.max(0, (step.endedAt || 0) - (step.startedAt || 0)));
  const recorded = !workflow.recordedOnly && workflow.steps ? trajectoryFromWorkflow(workflow as unknown as WorkflowV2, timings) : [];
  const recent = (state.runs || []).filter((item) => item.workflowId === run.workflowId);
  const merged = new Map(recent.map((item) => [item.id, item]));
  merged.set(run.id, run);
  const history = [...merged.values()].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-8);
  const reviewStepIds = reviewItems((state.runs || []).filter((item) => item.workflowId === run.workflowId)).map((item) => item.stepId);
  host.innerHTML = (receipt ? runReceipt(receipt, workflow.name, run) : receiptError()) + `<details id="run-evidence"${evidenceOpen ? " open" : ""}><summary>Detailed evidence</summary>${runViewer(run, workflow, selectedStep, { recent: history, recorded, reviewStepIds })}</details>`;
  const retry = document.getElementById("retry-run");
  if (retry) retry.onclick = () => { void showRun(id).then(() => focusMain({ preventScroll: true })); };
  const evidence = document.getElementById("run-evidence") as HTMLDetailsElement;
  evidence.ontoggle = () => { if (evidence.isConnected) evidenceOpen = evidence.open; };
  host.querySelectorAll<HTMLElement>("[data-receipt-offset]").forEach((button) => {
    button.onclick = () => {
      receiptOffset = Number(button.dataset.receiptOffset);
      void showRun(id).then(() => document.querySelector<HTMLElement>("#receipt-step-heading")?.focus());
    };
  });
  host.querySelectorAll<HTMLElement>("[data-screen=heals]").forEach((button) => {
    button.onclick = () => navigate("heals");
  });
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
    if (extra) extra.innerHTML = consolePane(runConsoleLines(run), selectedStep);
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
  if (!host || !heal || screen !== "heals" || openHeal?.runId !== runId || openHeal.healId !== healId) return;
  const names = new Map((state.workflows || []).map((workflow) => [workflow.id, workflow.name]));
  const promotion = (state.promotions || []).find((item) => item.healId === heal.id && item.workflowId === run.workflowId)
    || (run.promotion && run.promotion.healId === heal.id ? run.promotion : undefined);
  host.outerHTML = healDetail(run, heal as HealView, {
    workflowName: healWorkflowName(heal, run, names),
    promotion,
  });
  bindHeal();
  host.ownerDocument.querySelectorAll<HTMLImageElement>("[data-heal-shot]").forEach((image) => {
    const unavailable = () => { image.hidden = true; image.nextElementSibling?.removeAttribute("hidden"); };
    image.onerror = unavailable;
    if (image.complete && !image.naturalWidth) unavailable();
  });
}

async function loadTrail(id: string, hostId: string): Promise<void> {
  if (!id) return;
  const trail = await (await fetch("/api/trails/" + encodeURIComponent(id))).json() as { id?: string; ts?: number; op?: string; kind?: string }[];
  const html = trailPane(Array.isArray(trail) ? trail : []);
  const host = document.getElementById(hostId);
  if (host) host.innerHTML = html;
}

function bindSidebarToggle(): void {
  const toggle = document.getElementById("sidebar-toggle");
  if (toggle) toggle.onclick = () => {
    const sidebar = document.getElementById("sidebar-dialog") as HTMLDialogElement;
    sidebar.returnValue = "";
    sidebar.append(railEl());
    sidebar.showModal();
  };
}

async function openEditor(id: string): Promise<void> {
  const host = document.getElementById("workflow-host");
  if (!host) return;
  let doc: WorkflowV2;
  try {
    const response = await fetch("/api/workflows/" + encodeURIComponent(id));
    if (!response.ok) throw new Error("Workflow unavailable");
    doc = await response.json() as WorkflowV2;
  } catch {
    if (!host.isConnected || screen !== "workflow" || openWorkflow !== id) return;
    host.innerHTML = `<div class="wf-toolbar">${workflowSidebarToggle()}</div><section class="wf-load-error"><h2>This workflow can’t open</h2><p>Try again, or open Workflows to check its file.</p><button type="button" id="workflow-retry">Try again</button><button type="button" id="workflow-back">Open Workflows</button></section>`;
    bindSidebarToggle();
    document.getElementById("workflow-retry")!.onclick = () => void openEditor(id);
    document.getElementById("workflow-back")!.onclick = () => navigate("library");
    return;
  }
  const [listed, shareRes] = await Promise.all([
    fetch("/api/workflows/" + encodeURIComponent(id) + "/versions").then((res) => res.ok ? res.json() : {}).catch(() => ({})) as Promise<{
      versions?: { n: number; role: string; source: string; createdAt: number }[];
    }>,
    fetch("/api/workflows/" + encodeURIComponent(id) + "/share").then((res) => res.ok ? res.json() : undefined).catch(() => undefined),
  ]);
  if (!host.isConnected || screen !== "workflow" || openWorkflow !== id) return;
  const runs = (state.runs || []).filter((run) => run.workflowId === id);
  const last = runs.slice().sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const shots = last?.id ? await stepCrops(last.id) : {};
  if (!host.isConnected || screen !== "workflow" || openWorkflow !== id) return;
  const selectedStep = host.querySelector<HTMLElement>("[data-workflow-step][aria-pressed=true]")?.dataset.workflowStep;
  host.innerHTML = workflowDetail(doc, { lastRunId: last?.id, shots, share: shareRes, runs, selectedStep });
  bindSidebarToggle();
  host.querySelector("#workflow-conflicts")!.innerHTML = workflowConflicts(listed.versions || []);
  host.querySelector("#workflow-tools")!.innerHTML = versionsPanel(listed.versions || []) + `<details class="card" id="workflow-edit"><summary>Edit workflow</summary>
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
      navigate("replay");
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
  host.querySelectorAll<HTMLButtonElement>("[data-workflow-step]").forEach((button) => {
    button.onclick = () => {
      const stepId = button.dataset.workflowStep;
      host.querySelectorAll<HTMLButtonElement>("[data-workflow-step]").forEach((pick) => {
        const selected = pick.dataset.workflowStep === stepId;
        pick.setAttribute("aria-pressed", String(selected));
        pick.closest("tr")!.classList.toggle("selected", selected);
      });
      host.querySelectorAll<HTMLElement>("[data-step-panel]").forEach((panel) => { panel.hidden = panel.dataset.stepPanel !== stepId; });
      host.querySelectorAll<HTMLElement>("[data-workflow-input]").forEach((row) => { row.classList.toggle("selected", row.dataset.workflowInput === button.dataset.stepInput); });
      if (matchMedia("(max-width: 820px)").matches) document.getElementById("workflow-inspector")?.scrollIntoView({ block: "start" });
    };
  });
  document.getElementById("workflow-search")!.onclick = openPalette;
  document.getElementById("workflow-edit-inputs")!.onclick = () => {
    const inputs = document.getElementById("workflow-inputs")!;
    inputs.scrollIntoView({ block: "nearest" });
    inputs.querySelector<HTMLButtonElement>("[data-edit-input]")?.focus();
  };
  host.querySelectorAll<HTMLButtonElement>("[data-open-run]").forEach((button) => {
    button.onclick = () => { selectRun(button.dataset.openRun || ""); renderKey = ""; render(); };
  });
  host.querySelectorAll<HTMLButtonElement>("[data-screen=capture]").forEach((button) => { button.onclick = () => navigate("capture"); });
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
  const doc = await (await fetch("/api/workflows/" + encodeURIComponent(id))).json() as Pick<WorkflowV2, "inputs" | "steps">;
  const form = document.getElementById("args");
  if (!form || screen !== "replay") return;
  const pinned = pinnedRunId ? (state.runs || []).find((run) => run.id === pinnedRunId && run.workflowId === id) : undefined;
  const last = (state.runs || []).filter((run) => run.workflowId === id).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const pinnedArgs = (pinnedRunId && pinnedInputs) || pinned?.inputs;
  const prev = { ...(pinnedArgs || last?.inputs || {}), ...deeplinkInputs };
  form.innerHTML = doc.inputs.map((input) => {
    const fresh = oneTimeCodeInput(doc, input.name);
    const previous = input.type === "secret" ? deeplinkInputs[input.name] ?? pinnedArgs?.[input.name] : prev[input.name];
    return field({ ...input, default: fresh ? undefined : input.default, fresh: fresh && deeplinkInputs[input.name] === undefined }, previous, doc.steps || []);
  }).join("") || "<p>This workflow has no inputs.</p>";
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
  input: { name: string; type: string; label?: string; default?: string; required?: boolean; choices?: string[]; multiple?: boolean; fromOutput?: string; relative?: string; format?: string; zone?: string; fresh?: boolean },
  previous: string | undefined,
  steps: { label?: string; download?: { output?: string } }[],
): string {
  const boundStep = input.fromOutput
    ? steps.find((step) => step.download?.output === input.fromOutput)?.label || input.fromOutput
    : undefined;
  return runField({ ...input, boundStep }, previous);
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
  const editor = document.createElement("form");
  editor.id = "input-editor";
  editor.className = "token-editor";
  editor.innerHTML = `<p class="quiet">Edit ${esc(token.dataset.label || name)}</p>
    <label>Label <input name="label" value="${esc(token.dataset.label || name)}"></label>
    <label>Type <select name="type">
      ${["text", "secret", "number", "choice", "file"].map((type) => `<option value="${type}" ${token.dataset.type === type ? "selected" : ""}>${type}</option>`).join("")}
    </select></label>
    <label>Default <input name="default" value="${esc(token.dataset.default || "")}"></label>
    <label>Required <input name="required" type="checkbox" ${token.dataset.required === "1" ? "checked" : ""}></label>
    <button type="button" data-save-input>Save</button>`;
  document.getElementById("input-editor")?.remove();
  token.after(editor);
  editor.querySelector<HTMLInputElement>("[name=label]")?.focus();
  const typeSel = editor.querySelector("[name=type]") as HTMLSelectElement;
  const defaultInput = editor.querySelector("[name=default]") as HTMLInputElement;
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
          default: defaultInput.value,
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
  const res = await statePoller.track(fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args: {}, guide: true }),
  }));
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
  const res = await statePoller.track(fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args, fromStep: fromStep || undefined }),
  }));
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
  selectRun(runId, fromStep);
  pinnedRunId = "";
  pinnedInputs = null;
  debugStepId = "";
  runFromN = 0;
  fromNote = "";
  renderKey = "";
  await refresh();
}

function selectDefaultRun(): void {
  const first = runAttention(state.runs || [], state.activeAsk, state.activeRun)[0];
  if (state.activeRun?.ask) screen = "live";
  else if (first?.kind === "healed") selectHeal(first.run.id, first.healId);
  else {
    const id = first?.run.id || [...(state.runs || [])].sort((a, b) => (b.at || 0) - (a.at || 0))[0]?.id;
    if (id) selectRun(id);
  }
}

function selectHeal(runId: string, healId: string): void {
  openHeal = { runId, healId };
  screen = "heals";
}

function selectRun(id: string, stepId = ""): void {
  if (state.activeRun?.id === id && state.activeRun.ask && !stepId) {
    screen = "live";
    return;
  }
  openRun = id;
  selectedStep = stepId;
  receiptOffset = 0;
  evidenceOpen = Boolean(stepId);
  screen = "run";
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
  if (node?.dataset.deadline) {
    const deadline = Number(node.dataset.deadline);
    if (deadline) node.textContent = formatWait(Date.now(), deadline, node.dataset.effect || "run stops, nothing applied");
  }
  for (const node of document.querySelectorAll<HTMLElement>("[data-run-deadline]")) {
    node.textContent = runWaitLeft(Number(node.dataset.runDeadline));
  }
  const liveDeadline = document.querySelector<HTMLElement>(".live-deadline[data-deadline]");
  const liveWait = document.getElementById("live-wait-left");
  if (liveDeadline?.dataset.deadline && liveWait) {
    const deadline = Number(liveDeadline.dataset.deadline);
    liveWait.textContent = runWaitLeft(deadline);
    const meter = liveDeadline.querySelector<HTMLElement>(".live-meter i");
    if (meter) meter.style.width = `${Math.min(100, Math.max(0, (deadline - Date.now()) / Number(liveDeadline.dataset.timeout) * 100))}%`;
  }
  const timer = document.getElementById("rec-timer");
  if (!timer?.dataset.since) return;
  const since = Number(timer.dataset.since);
  if (!since) return;
  const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  timer.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function paintDockBadge(): void {
  const count = shellAttentionCount(state);
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
  if (screen !== "logins" && screen !== "settings") return;
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
  document.querySelectorAll<HTMLButtonElement>("#main [data-import-profile]").forEach((btn) => {
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
  document.querySelectorAll<HTMLButtonElement>("#main [data-recheck]").forEach((btn) => {
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
  document.querySelectorAll<HTMLButtonElement>("#main [data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      const origin = expandControlKey(btn.dataset.remove || "");
      if (!window.confirm(`Remove the saved login for ${origin}?`)) return;
      readLoginForm();
      await fetch("/api/login-sites", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin }),
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
  } else if (url === "/api/sync/pair") {
    for (const id of ["pair-code", "invite-secret"]) {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) input.value = input.defaultValue;
    }
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

function showLibrarySearch(): void {
  librarySearchOpen = true;
  const tools = document.getElementById("library-tools");
  if (tools) tools.hidden = false;
  document.getElementById("library-search-open")?.setAttribute("aria-expanded", "true");
  document.getElementById("library-search")?.focus();
}

function applySearch(): void {
  const q = libraryQuery.trim().toLowerCase();
  const rows = [...document.querySelectorAll<HTMLElement>(".workflow-row")];
  let matches = 0;
  rows.forEach((row) => {
    const name = (row.querySelector(".workflow-name")?.textContent || "").toLowerCase();
    row.hidden = !!q && !name.includes(q);
    if (!row.hidden) matches += 1;
  });
  const empty = document.getElementById("library-no-results");
  if (empty) empty.hidden = matches > 0;
  const table = document.getElementById("workflow-list");
  if (table) table.hidden = matches === 0;
  const status = document.getElementById("library-search-status");
  if (status) status.textContent = q ? `${matches} matching ${matches === 1 ? "workflow" : "workflows"}` : "";
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
  const live = state.liveTrail || [];
  const html = screen === "capture" ? captureStream(state, capturePicking) : liveStepList(live);
  const count = document.getElementById("rec-steps");
  if (count) count.textContent = `${state.capture?.steps.length || 0} steps`;
  if (host.innerHTML !== html) {
    host.innerHTML = html;
    mountShots(host);
  }
}

function filteredCommands(): CommandItem[] {
  const q = paletteQuery.trim().toLowerCase();
  return commandItems(state.workflows || []).filter((item) => !q || item.label.toLowerCase().includes(q));
}

function openPalette(): void {
  const sidebar = document.getElementById("sidebar-dialog") as HTMLDialogElement;
  if (sidebar.open) sidebar.close("palette");
  paletteOpen = true;
  paletteQuery = "";
  paletteActive = 0;
  paintPalette();
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
    navigate("replay");
    return;
  } else if (item.kind === "workflow" && item.workflowId) {
    openWorkflow = item.workflowId;
    screen = "workflow";
  } else if (item.screen) {
    navigate(item.screen as Screen);
    return;
  }
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
    exp.addEventListener("click", () => {
      const link = document.createElement("a");
      link.href = "/api/workflows/" + encodeURIComponent(id) + "/export";
      link.download = `${id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
    });
  }
  const guide = host.querySelector("[data-testid=share-guide]") as HTMLButtonElement | null;
  if (guide && !guide.disabled) {
    guide.addEventListener("click", () => {
      const link = document.createElement("a");
      link.href = "/api/workflows/" + encodeURIComponent(id) + "/guide";
      link.download = `${id.replace(/[^A-Za-z0-9._-]/g, "_")}-guide.html`;
      document.body.append(link);
      link.click();
      link.remove();
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
      img.alt = node.dataset.shotAlt || "";
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
  const url = which === "before" ? stage.dataset.before || "" : stage.dataset.after || "";
  stage.querySelectorAll("img").forEach((img) => img.remove());
  stage.classList.remove("has-shot");
  const reason = stage.querySelector<HTMLElement>("[data-shot-error]");
  const placeholder = stage.querySelector<HTMLElement>(".ph");
  const showError = (message: string) => {
    if (placeholder) placeholder.hidden = true;
    if (reason) { reason.textContent = message; reason.hidden = false; }
  };
  if (reason) reason.hidden = true;
  if (placeholder) placeholder.hidden = false;
  if (!url) {
    showError((which === "before" ? stage.dataset.beforeError : stage.dataset.afterError) || "No picture was saved for this step.");
    return;
  }
  const img = new Image();
  img.alt = "";
  img.onload = () => {
    if (!stage.isConnected || img.parentElement !== stage) return;
    stage.classList.add("has-shot");
  };
  img.onerror = () => {
    if (!stage.isConnected || img.parentElement !== stage) return;
    img.remove();
    showError("The saved picture could not be loaded.");
  };
  stage.prepend(img);
  img.src = url;
}

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (paletteOpen) {
      paletteOpen = false;
      paintPalette();
    } else openPalette();
    return;
  }
  if (!paletteOpen) {
    const tag = document.activeElement?.tagName;
    if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      if (document.getElementById("library-search")) {
        event.preventDefault();
        showLibrarySearch();
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

const sidebarDialog = document.getElementById("sidebar-dialog") as HTMLDialogElement;
sidebarDialog.addEventListener("close", () => {
  if (sidebarDialog.open) return;
  document.getElementById("app")!.prepend(railEl());
  if (paletteOpen || sidebarDialog.returnValue === "palette") return;
  if (sidebarDialog.returnValue === "navigate") focusMain();
  else document.getElementById("sidebar-toggle")?.focus();
});
window.matchMedia("(max-width: 1060px)").addEventListener("change", (event) => {
  if (!event.matches && sidebarDialog.open) sidebarDialog.close("navigate");
});
const statePoller = createStatePoller({
  poll: refreshState,
  active: () => activePolling(state),
  visible: () => document.visibilityState === "visible",
});
document.addEventListener("visibilitychange", statePoller.visibilityChanged);
void refresh().catch(() => undefined);
setInterval(tickClock, 250);
