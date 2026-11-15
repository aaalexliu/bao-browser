/** The page overlay and the run's control chart. The page script is a string so Chrome can install it in an isolated world. */

export const ACTING_COMMANDS = ["click", "fill", "press", "scroll", "upload", "download"] as const;
export const HANDED_BACK = "The owner took control of this tab and handed it back. Take a fresh snapshot before acting.";
export const OWNER_IN_CONTROL = "The owner is in control of this tab.";
export const WATCHDOG_MS = 20_000;
/** Marks the overlay's host element, so the receipt's page map can leave Bao's own controls out. */
export const OVERLAY_HOST_ATTRIBUTE = "data-bao-overlay";

const acting = new Set<string>(ACTING_COMMANDS);

export function isActing(command: string): boolean {
  return acting.has(command);
}

function tabHead(args: readonly string[]): string | undefined {
  return args.find((arg) => arg === "close" || arg === "list" || arg === "new" || !arg.startsWith("-"));
}

/** A command that would change the tab the owner holds: an acting command, an open, or a tab close. Session close is not one. */
export function isHeldMutation(command: string, args: readonly string[] = []): boolean {
  if (isActing(command) || command === "open") return true;
  return command === "tab" && tabHead(args) === "close";
}

export function askLine(task: string): string {
  const trimmed = task.trim();
  const sentence = trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "Take a look";
  return `${sentence}, then click Done`;
}

/** Keeps the ask, and names Done as the way to hand the tab back. */
export function doneAsk(instruction: string): string {
  const text = instruction.trim();
  if (!text) return "Click Done";
  const swapped = text.replace(/\bpress Continue\b/gi, "click Done");
  if (swapped !== text || /\bclick Done\b/i.test(swapped)) return swapped;
  return `${swapped.replace(/[.]+$/, "")}, then click Done`;
}

/** A result that skipped the command because the owner held the tab. Success bookkeeping must not treat it as done. */
export function handedBack(result: { stdout: string; exitCode: number }): boolean {
  return result.exitCode === 0 && result.stdout.trim() === HANDED_BACK;
}

/**
 * A mutation admitted before a take does not run after that take, even if Done already returned the tab.
 * A mutation that is held now waits. Anything else runs.
 */
export function staleHold(takenDuringPrep: boolean, heldNow: boolean, command: string, args: readonly string[] = []): "run" | "handback" | "wait" {
  if (!isHeldMutation(command, args)) return "run";
  if (heldNow) return "wait";
  if (takenDuringPrep) return "handback";
  return "run";
}

/** A mutation of the held tab does not run. The caller waits, then returns the one line. */
export async function holdCommand<T>(
  held: boolean,
  command: string,
  run: () => Promise<T>,
  wait: () => Promise<"done" | "timeout" | "disconnect">,
  args: readonly string[] = [],
): Promise<{ held: true; outcome: "done" | "timeout" | "disconnect" } | { held: false; value: T }> {
  if (held && isHeldMutation(command, args)) return { held: true, outcome: await wait() };
  return { held: false, value: await run() };
}

export type ControlPhase = "agent" | "taking" | "owner" | "releasing" | "finished";
export type ControlReason = "takeover" | "ask";
export type FinishOutcome = "finished" | "failed" | "stopped";

export interface Control {
  phase: ControlPhase;
  reason?: ControlReason;
  startedAt?: number;
  endedAt?: number;
  ask?: string;
  outcome?: FinishOutcome;
}

export type ControlEvent =
  | { type: "take"; at: number }
  | { type: "ask"; ask: string; at: number }
  | { type: "own" }
  | { type: "done"; at: number }
  | { type: "resume" }
  | { type: "finish"; outcome: FinishOutcome }
  | { type: "disconnect"; at: number };

export function controlState(): Control {
  return { phase: "agent" };
}

/** One chart per run. A transition that the phase does not allow leaves the state as it is. */
export function stepControl(state: Control, event: ControlEvent): Control {
  if (event.type === "finish") return { phase: "finished", outcome: event.outcome };
  if (event.type === "disconnect") return { phase: "finished", outcome: "stopped", endedAt: event.at };
  switch (state.phase) {
    case "agent":
      if (event.type === "take") return { phase: "taking", reason: "takeover", startedAt: event.at };
      if (event.type === "ask") return { phase: "owner", reason: "ask", ask: event.ask, startedAt: event.at };
      return state;
    case "taking":
      if (event.type === "own") return { ...state, phase: "owner" };
      return state;
    case "owner":
      if (event.type === "done") return { ...state, phase: "releasing", endedAt: event.at };
      return state;
    case "releasing":
      if (event.type === "resume") return { phase: "agent" };
      return state;
    case "finished":
      return state;
  }
}

export type OverlayPhase = "working" | "control" | "releasing" | "finished" | "hidden";

export interface OverlayView {
  phase: OverlayPhase;
  activity: string;
  lastTab?: boolean;
  outcome?: FinishOutcome;
}

export function overlayView(state: Control, activity: string, lastTab = false): OverlayView {
  if (state.phase === "finished") return { phase: "finished", activity: finishLine(state.outcome), outcome: state.outcome, lastTab };
  if (state.phase === "releasing") return { phase: "releasing", activity: "Resuming…", lastTab };
  if (state.phase === "owner" || state.phase === "taking") {
    return { phase: "control", activity: state.reason === "ask" ? state.ask || "You're in control" : "You're in control", lastTab };
  }
  return { phase: "working", activity: activity || "Working…", lastTab };
}

function finishLine(outcome: FinishOutcome | undefined): string {
  if (outcome === "failed") return "Bao couldn't finish";
  if (outcome === "stopped") return "Bao stopped";
  return "Bao finished";
}

const MARK = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="bao-bg" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFB86B"/><stop offset="1" stop-color="#E8813A"/></linearGradient><radialGradient id="bao-dough" cx="42%" cy="32%" r="78%"><stop stop-color="#FFFDF8"/><stop offset=".66" stop-color="#FFF1DE"/><stop offset="1" stop-color="#F8DEBE"/></radialGradient></defs><rect x="4" y="4" width="92" height="92" rx="24" fill="url(#bao-bg)"/><path d="M50 34C70 34 79 48 79 62C79 78 65 84 50 84C35 84 21 78 21 62C21 48 30 34 50 34Z" fill="url(#bao-dough)" stroke="#EBD3B2" stroke-width="1.4"/><ellipse cx="50" cy="36.5" rx="6.5" ry="3.9" fill="#FCEED8" stroke="#EBD3B2"/><path d="M36 60Q41 52.5 46 60M54 60Q59 52.5 64 60" stroke="#3A302A" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M44 72Q50 77 56 72" stroke="#3A302A" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>';

/** The isolated-world script. A short watchdog is for the fail-open test only. */
export function takeoverOverlaySource(watchdogMs = WATCHDOG_MS): string {
  const ms = Number.isFinite(watchdogMs) && watchdogMs >= 200 ? Math.floor(watchdogMs) : WATCHDOG_MS;
  return `(() => {
  if (window.top !== window) return;
  const WATCHDOG_MS = ${ms};
  const existing = globalThis.__baoTakeover;
  if (existing && existing.alive) return existing;
  const tag = "b-" + (crypto.getRandomValues(new Uint32Array(1))[0] || 1).toString(36);
  const host = document.createElement(tag);
  host.setAttribute("popover", "manual");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute(${JSON.stringify(OVERLAY_HOST_ATTRIBUTE)}, "");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(overlayCss())};
  const root = document.createElement("div");
  root.className = "root";
  root.innerHTML = ${JSON.stringify(overlayHtml(MARK))};
  shadow.append(style, root);
  const frame = shadow.querySelector(".frame");
  const shield = shadow.querySelector(".shield");
  const notch = shadow.querySelector(".notch");
  const nameEl = shadow.querySelector(".name");
  const activities = shadow.querySelectorAll(".activity");
  const closes = shadow.querySelectorAll(".x");
  const avatar = shadow.querySelector(".avatar");
  const pill = shadow.querySelector(".pill");
  const hint = shadow.querySelector(".hint");
  const cursor = shadow.querySelector(".cursor");
  const done = shadow.querySelector(".done");
  const cancel = shadow.querySelector(".cancel");
  const disconnect = shadow.querySelector(".disconnect");
  const question = shadow.querySelector(".question");
  let phase = "hidden";
  let lastTab = false;
  let armed = false;
  let acting = false;
  let shot = false;
  let gone = false;
  let disarmed = false;
  let confirm = false;
  let confirmAt = 0;
  let confirmTimer = 0;
  let hoverTimer = 0;
  let hintTimer = 0;
  let fadeTimer = 0;
  let lastCall = Date.now();
  let waiter = null;
  const queue = [];
  function touch() { lastCall = Date.now(); if (disarmed) rearm(); }
  function emit(event) {
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); }
    else queue.push(event);
  }
  let topModal = null;
  function activeModal() {
    if (topModal && topModal.isConnected && topModal.open && topModal.matches(":modal")) return topModal;
    const modals = document.querySelectorAll("dialog:modal");
    return modals.length ? modals[modals.length - 1] : null;
  }
  function place() {
    if (gone) return;
    const parent = document.fullscreenElement || activeModal() || document.documentElement;
    if (!parent) return;
    if (host.parentNode !== parent) parent.appendChild(host);
    try { if (!host.matches(":popover-open")) host.showPopover(); } catch (e) {}
  }
  function onDialogToggle(event) {
    const dialog = event.target;
    if (!dialog || dialog.tagName !== "DIALOG") return;
    if (event.newState === "open" && dialog.matches(":modal")) topModal = dialog;
    else if (topModal === dialog) topModal = null;
    place();
  }
  function visible() { return document.visibilityState === "visible" && !shot && !gone && !disarmed; }
  function paint() {
    const show = visible() && phase !== "hidden";
    host.style.display = show ? "block" : "none";
    root.hidden = !show;
    const working = phase === "working" && !confirm;
    const control = phase === "control" || phase === "releasing" || phase === "finished" || confirm;
    frame.hidden = !working;
    notch.hidden = control;
    pill.hidden = !control;
    if (working) notch.classList.remove("away");
    else notch.classList.add("away");
    pill.classList.toggle("float", control);
    done.hidden = phase !== "control" || confirm;
    pill.querySelector(".x").hidden = !confirm;
    for (const node of activities) node.hidden = confirm;
    question.hidden = !confirm;
    cancel.hidden = !confirm;
    disconnect.hidden = !confirm;
    if (!working) hideHint();
    armed = phase === "working" && !acting;
    shield.hidden = !armed;
    shield.style.pointerEvents = armed ? "auto" : "none";
    root.classList.toggle("acting", acting);
  }
  function hideHint() { hint.hidden = true; clearTimeout(hoverTimer); clearTimeout(hintTimer); }
  function showHint(x, y) {
    if (!armed || phase !== "working" || confirm) return;
    hint.hidden = false;
    hint.style.left = x + "px";
    hint.style.top = (y + 30) + "px";
  }
  function flashHint() {
    const box = notch.getBoundingClientRect();
    showHint(box.left + box.width / 2, box.bottom);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 1400);
  }
  function swallow(event) {
    if (!armed || gone || disarmed) return;
    if (event.composedPath().includes(host)) return;
    if (confirm) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.type === "click") { event.preventDefault(); event.stopImmediatePropagation(); emit({ type: "takeControl" }); return; }
    if (event.type === "keydown" && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); emit({ type: "takeControl" }); return; }
    if (event.type === "pointermove" || event.type === "mousemove") {
      clearTimeout(hoverTimer);
      const x = event.clientX, y = event.clientY;
      hoverTimer = setTimeout(() => showHint(x, y), 100);
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.type === "keydown" || event.type === "wheel") flashHint();
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  const kinds = ["pointerdown", "pointerup", "click", "auxclick", "dblclick", "contextmenu", "mousedown", "mouseup", "mousemove", "pointermove", "touchstart", "touchend", "wheel", "keydown", "keyup", "keypress", "dragstart", "drop", "paste", "copy", "cut", "beforeinput"];
  function listen(on) {
    for (const kind of kinds) window[(on ? "add" : "remove") + "EventListener"](kind, swallow, true);
  }
  function rearm() { disarmed = false; paint(); }
  function disarm() {
    if (disarmed || gone) return;
    disarmed = true;
    armed = false;
    if (confirm) endConfirm();
    hideHint();
    host.style.display = "none";
    shield.style.pointerEvents = "none";
  }
  function apply(state) {
    touch();
    if (!state || typeof state !== "object") return;
    phase = state.phase || "hidden";
    lastTab = state.lastTab === true;
    for (const node of activities) node.textContent = state.activity || "Working…";
    question.textContent = lastTab ? "Stop Bao and disconnect?" : "Disconnect Bao from this tab?";
    if (phase !== "working" && confirm) endConfirm();
    paint();
    place();
  }
  function agent(pointer) {
    touch();
    if (!pointer) return;
    if (typeof pointer.active === "boolean") { acting = pointer.active; paint(); }
    if (typeof pointer.x === "number" && typeof pointer.y === "number") {
      cursor.hidden = false;
      cursor.style.left = pointer.x + "px";
      cursor.style.top = pointer.y + "px";
      cursor.style.opacity = "1";
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => { cursor.style.opacity = "0"; }, 1500);
    }
    cursor.classList.toggle("press", pointer.active === true);
  }
  function heartbeat() { touch(); place(); }
  function hide(on) { shot = on === true; paint(); }
  function dispose() {
    gone = true;
    armed = false;
    listen(false);
    clearInterval(watch);
    clearTimeout(confirmTimer);
    host.removeEventListener("toggle", onToggle);
    document.removeEventListener("fullscreenchange", place);
    document.removeEventListener("visibilitychange", paint);
    document.removeEventListener("toggle", onDialogToggle, true);
    observer.disconnect();
    host.remove();
    delete globalThis.__baoTakeover;
  }
  function poll() {
    touch();
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      waiter = resolve;
      setTimeout(() => { if (waiter === resolve) { waiter = null; resolve({ type: "tick" }); } }, 8000);
    });
  }
  function onToggle(event) { if (!gone && event.newState === "closed") place(); }
  function endConfirm() {
    if (!confirm) return;
    confirm = false;
    clearTimeout(confirmTimer);
    emit({ type: "confirm", open: false });
    paint();
  }
  function onX(event) {
    event.preventDefault();
    event.stopPropagation();
    if (confirm || phase !== "working") return;
    confirm = true;
    hideHint();
    confirmAt = Date.now();
    emit({ type: "confirm", open: true });
    paint();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(endConfirm, 10000);
  }
  function onCancel(event) {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - confirmAt < 350) return;
    endConfirm();
  }
  function onDisconnect(event) {
    event.preventDefault();
    event.stopPropagation();
    if (Date.now() - confirmAt < 350) return;
    confirm = false;
    emit({ type: "disconnect" });
  }
  function onDone(event) {
    event.preventDefault();
    event.stopPropagation();
    emit({ type: "done" });
  }
  function onAvatar(event) {
    event.preventDefault();
    event.stopPropagation();
    emit({ type: "openBao" });
  }
  shield.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!armed || gone || disarmed || confirm) return;
    emit({ type: "takeControl" });
  });
  shield.addEventListener("pointermove", (event) => {
    clearTimeout(hoverTimer);
    const x = event.clientX, y = event.clientY;
    hoverTimer = setTimeout(() => showHint(x, y), 100);
  });
  shield.addEventListener("mousemove", (event) => {
    clearTimeout(hoverTimer);
    const x = event.clientX, y = event.clientY;
    hoverTimer = setTimeout(() => showHint(x, y), 100);
  });
  shield.addEventListener("wheel", (event) => { event.preventDefault(); flashHint(); }, { passive: false });
  for (const node of closes) node.addEventListener("click", onX);
  cancel.addEventListener("click", onCancel);
  disconnect.addEventListener("click", onDisconnect);
  done.addEventListener("click", onDone);
  avatar.addEventListener("click", onAvatar);
  host.addEventListener("toggle", onToggle);
  document.addEventListener("fullscreenchange", place);
  document.addEventListener("visibilitychange", paint);
  document.addEventListener("toggle", onDialogToggle, true);
  const observer = new MutationObserver(() => { if (!gone && !host.isConnected) place(); });
  function watchTree() {
    const rootNode = document.documentElement;
    if (!rootNode) return;
    observer.observe(rootNode, { childList: true, subtree: true });
  }
  function mount() {
    place();
    watchTree();
    paint();
  }
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  listen(true);
  const watch = setInterval(() => { if (!gone && Date.now() - lastCall > WATCHDOG_MS) disarm(); }, Math.min(1000, WATCHDOG_MS));
  const api = { apply, agent, heartbeat, hide, dispose, poll, alive: true };
  globalThis.__baoTakeover = api;
  return api;
})()`;
}

function overlayHtml(mark: string): string {
  return `<div class="frame" hidden><div class="band"></div></div><div class="shield" hidden></div><div class="cursor" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5 13.5 8.2 8.2 9.4 6.4 14.2Z" fill="#E8813A" stroke="#fff" stroke-width="1"/></svg></div><div class="hint" hidden>Click to take control</div><div class="notch" hidden><button class="avatar" type="button">${mark}</button><span class="name">Bao</span><span class="activity">Working…</span><button class="x" type="button" aria-label="Disconnect">×</button></div><div class="pill" hidden><span class="question" hidden></span><span class="activity">You're in control</span><button class="x" type="button" aria-label="Disconnect">×</button><button class="cancel" type="button" hidden>Cancel</button><button class="disconnect" type="button" hidden>Disconnect</button><button class="done" type="button">Done</button></div>`;
}

function overlayCss(): string {
  return `
    :host { all: initial; position: fixed !important; inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important; margin: 0 !important; border: 0 !important; padding: 0 !important; background: transparent !important; overflow: visible !important; pointer-events: none !important; }
    [hidden] { display: none !important; }
    .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .root.acting, .root.acting * { pointer-events: none !important; }
    .frame { position: fixed; inset: 0; pointer-events: none; border-radius: 14px; box-shadow: inset 6px 0 0 #5A3014, inset -6px 0 0 #5A3014, inset 0 -5px 0 #5A3014, inset 0 0 28px rgba(232,129,58,.5); }
    .band { position: absolute; top: 0; left: 0; right: 0; height: 32px; border-radius: 0 0 16px 16px; background: linear-gradient(180deg, #7E441C 0%, #5A3014 45%, #46240C 100%); }
    .shield { position: fixed; inset: 0; background: transparent; }
    .notch, .pill { position: fixed; left: 50%; display: flex; align-items: center; gap: 8px; pointer-events: auto; font: 12.5px/1.2 -apple-system, BlinkMacSystemFont, sans-serif; color: #fff; }
    .notch { top: 0; height: 42px; min-width: 300px; max-width: 420px; padding: 0 12px 0 8px; background: #111; border-radius: 0 0 16px 16px; transform: translateX(-50%); box-shadow: 0 14px 28px rgba(232,129,58,.62); transition: top .52s ease, border-radius .52s ease, background .52s ease; }
    .notch::before, .notch::after { content: ""; position: absolute; top: 0; width: 20px; height: 20px; background: radial-gradient(circle at 0 20px, transparent 20px, #111 20px); }
    .notch::before { left: -20px; }
    .notch::after { right: -20px; background: radial-gradient(circle at 20px 20px, transparent 20px, #111 20px); }
    .notch.away { top: 14px; border-radius: 22px; }
    .pill { top: 18px; min-height: 44px; padding: 6px 8px 6px 16px; background: #f7f7f8; color: #1c1c1e; border: 1px solid #c7c7cc; border-radius: 22px; box-shadow: 0 8px 24px rgba(0,0,0,.16); transform: translateX(-50%); }
    .avatar, .x, .done, .cancel, .disconnect { pointer-events: auto; border: 0; padding: 0; cursor: pointer; }
    .avatar { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; background: transparent; flex: none; }
    .avatar svg { width: 28px; height: 28px; display: block; }
    .name { font-weight: 500; font-size: 12.5px; flex: none; }
    .activity { color: #9a9aa2; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
    .notch .activity { background: linear-gradient(90deg, #8e8e93 0%, #8e8e93 35%, #f4f4f5 50%, #8e8e93 65%, #8e8e93 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: sheen 2.4s linear infinite; }
    .pill .activity { color: #1c1c1e; background: none; -webkit-text-fill-color: #1c1c1e; animation: none; }
    .x { width: 22px; height: 22px; margin-inline-start: 4px; border-radius: 11px; background: transparent; color: #d0d0d4; font-size: 16px; }
    .pill .x { color: #6e6e73; }
    .done, .disconnect { height: 30px; padding: 0 14px; border-radius: 15px; background: #E8813A; color: #fff; font: 600 13px/30px -apple-system, BlinkMacSystemFont, sans-serif; }
    .cancel { height: 30px; padding: 0 12px; border-radius: 15px; background: transparent; color: #6e6e73; font: 13px/30px -apple-system, BlinkMacSystemFont, sans-serif; }
    .question { color: #1c1c1e; white-space: nowrap; }
    .hint { position: fixed; display: flex; align-items: center; height: 28px; padding: 0 10px; border-radius: 14px; pointer-events: none; background: #111; color: #fff; font: 12.5px/28px -apple-system, BlinkMacSystemFont, sans-serif; transform: translateX(-50%); box-shadow: 0 6px 16px rgba(0,0,0,.28); }
    .cursor { position: fixed; width: 18px; height: 18px; margin: 0; pointer-events: none; transition: transform .12s ease, opacity .4s ease; filter: drop-shadow(0 1px 1px rgba(0,0,0,.35)); }
    .cursor.press { transform: scale(.82); }
    @keyframes sheen { from { background-position: 100% 0; } to { background-position: -100% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .activity, .notch .activity { animation: none; color: #9a9aa2; background: none; -webkit-text-fill-color: #9a9aa2; }
      .notch, .cursor { transition: none; }
    }
    @media print { :host, .root { display: none !important; } }
  `;
}
