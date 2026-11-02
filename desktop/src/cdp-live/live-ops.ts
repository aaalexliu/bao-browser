import { insertTextRefusal, pathHalt } from "./allowlist";
import { EXPERIAN_COMMIT_MESSAGE } from "../v1/stop-copy";
export { EXPERIAN_COMMIT_MESSAGE, LIVE_LOGIN_INSTRUCTION } from "../v1/stop-copy";
import { redactLabel } from "./live-record";
import { COMMIT_FLOOR, type GuardPreset } from "./presets";

export const LIVE_TOOL_NAMES = [
  "live_session_start",
  "live_snapshot",
  "live_navigate",
  "live_tabs",
  "live_switch_tab",
  "live_select",
  "live_read",
  "live_click",
  "live_type",
  "live_key",
  "live_scroll",
  "live_screenshot",
  "live_stop",
] as const;

/** The only keys `live_key` presses. Space is left out because it also presses a focused button. */
export const LIVE_KEYS = ["Enter", "Tab", "Escape"] as const;

export const LIVE_SCROLL_DIRECTIONS = ["down", "up", "right", "left"] as const;

/** Controls per snapshot page. A long results page is read one page at a time. */
export const LIVE_PAGE_SIZE = 50;

export type LiveOpName = (typeof LIVE_TOOL_NAMES)[number];

export function isLiveOp(value: string): value is LiveOpName {
  return (LIVE_TOOL_NAMES as readonly string[]).includes(value);
}

/** An open session with no call for this long saves its workflow and ends. */
export const LIVE_IDLE_MS = 10 * 60_000;

/** The person is warned this long before an idle save, so one who is there can keep the session open. */
export const LIVE_IDLE_WARN_MS = 2 * 60_000;

/** The warning before an idle save. The session saves and ends at `saveAt` unless a call or Keep open comes first. */
export interface LiveIdleWarning {
  session: string;
  host: string;
  saveAt: number;
}

export const LIVE_TOOLS = [
  {
    name: "live_session_start",
    description: `Open a local live session on one http(s) page. Pass an intent and a url. Use the site's start page, such as its home or store page, not a search results url: type the search with live_type, so the saved workflow has the search step. The Bao app picks the Chrome and live profile from Settings, unless --live-target or BAO_LIVE_TARGET overrides it. By default Bao performs the action, including Create, Save, Submit, Confirm, checkout, and place order. Sign-in detection adds a note and leaves the session usable. Set careful: true to opt into preset deny labels, confirm checks, stop paths, and sign-in halts. If omitted, careful uses this Mac's setting, which defaults to false. A known host uses its own preset: instacart.com uses instacart, books.toscrape.com uses books, and both www.experian.com and usa.experian.com use experian. Other hosts use the preset given, else generic. For Experian, start at https://usa.experian.com/member after the person signs in in Chrome. In careful mode, dashboard Unfreeze and other freeze-flow starters stay ordinary clicks, but the final Unfreeze, Freeze, Lift, Thaw, Confirm or Submit action on the freeze review or confirmation page returns reached: experian_commit without a click. Session start never returns reached. Stop and save with live_stop. Only after the owner explicitly says go, start a new careful session with allowCommit: true to permit that freeze change. This opt-in applies only to that session, never a later session or replay, and the capture run records it. It never overrides careful mode's checkout, deny labels or credential guards. The reply lists controls with refs. In careful mode it also names buttons held for confirmation. It does not return cookies or storage. The session saves its workflow on live_stop, when this MCP server's client disconnects, or after ${LIVE_IDLE_MS / 60_000} minutes with no call. ${LIVE_IDLE_WARN_MS / 60_000} minutes before that idle save, Bao warns the person, and Keep open in the Bao window restarts the wait.`,
    inputSchema: {
      type: "object",
      properties: {
        careful: { type: "boolean", description: "Opt into confirm checks, sign-in halts, and site deny rules. Defaults to this Mac's careful setting (false)." },
        intent: { type: "string" },
        url: { type: "string" },
        portFile: { type: "string", description: "Leave this out. An absolute DevToolsActivePort path, only for a Chrome started with its own --user-data-dir." },
        preset: { type: "string", enum: ["generic", "instacart", "books", "experian"], description: "Leave this out for a known host." },
        allowCommit: { type: "boolean", default: false, description: "Experian freeze actions only. Use true only after the owner explicitly says go. Default reaches the final button without clicking it. This permission expires with the session and is recorded on its capture run." },
        workflowId: { type: "string", description: "Optional wf-<name>. Without it the id comes from the intent." },
      },
      required: ["intent", "url"],
    },
  },
  {
    name: "live_snapshot",
    description: `Read the open live page. Controls are listed in page order, ${LIVE_PAGE_SIZE} to a page, and the reply gives page and pages. Pass page to read another page of the last read without reading the page again, so every ref from that read still works. By default every control keeps its label and gets a ref, including credential fields. In careful mode confirm and denied buttons have no ref, labels are redacted, and credential fields are counted without refs. Select controls list their options for live_select.`,
    inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1 } } },
  },
  {
    name: "live_navigate",
    description: "Navigate Bao's current tab to an http(s) URL. By default Bao performs the action and follows redirects. Careful mode applies its host list and stop paths.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "live_tabs",
    description: "List only tabs opened by Bao or by Bao's tabs. Other Chrome tabs are not listed or controlled.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_switch_tab",
    description: "Switch to a tab id from live_tabs and read it. Old refs become stale. Bao never switches to a tab outside this session.",
    inputSchema: { type: "object", properties: { tab: { type: "string" } }, required: ["tab"] },
  },
  {
    name: "live_select",
    description: "Choose an option on a native select control from the latest snapshot by its value or label. For custom menus, click the combobox, then the option ref, or use live_key.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, option: { type: "string" } }, required: ["ref", "option"] },
  },
  {
    name: "live_read",
    description: "Read and record visible text from one CSS region or element. name is a unique output name, such as freeze_status. selector defaults to body; prefer a stable id or a named region, such as [aria-label='Freeze status']. Missing, hidden, or ambiguous regions are refused. Careful mode also refuses credential-named ancestors; YOLO reads them with the same secret-value redaction. Text is capped at 4000 characters with a truncation marker. Fields and editable content are excluded. Redaction covers credential-label values, SSNs, Luhn-valid 13-19-digit card numbers, JWTs, and keys with sk-, ghp_, gho_, xoxb-, xoxp-, or AKIA prefixes. Scores, dates, amounts, and freeze status stay readable. The saved workflow reads the region again on replay and returns its fresh text in run_workflow and get_run outputs. Text and run pictures stay on this Mac; do not read a region that contains secrets.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
        selector: { type: "string", maxLength: 500 },
      },
      required: ["name"],
    },
  },
  {
    name: "live_click",
    description: "Click one ref from the latest snapshot. By default Bao performs the action. In careful mode confirm buttons and preset deny labels are guarded. Stale refs and controls covered by another element are refused.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "live_type",
    description: "Type into one field or contenteditable from the latest snapshot. By default Bao performs the action, including credentials, long text, and digit strings. Careful mode refuses credential fields, secret-looking text, and text longer than 80 characters. Typing stops if focus is no longer that field. To search, type the query into the site's search box, then press Enter on that box with live_key.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] },
  },
  {
    name: "live_key",
    description: "Press a common key: Enter, Tab, Escape, arrows, Backspace, Delete, Space, Home, End, PageUp, PageDown, or Meta/Control/Alt/Shift combinations such as Meta+a. With a ref from the latest snapshot the control is focused first. Careful mode accepts only Enter, Tab, and Escape, and Enter needs a ref. By default Bao performs the action, including form submission. In careful mode Enter in a field is refused when its form would submit through a confirm or denied button, or when it has no submit button and is not a search box. Unsupported key names are refused.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, ref: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "live_scroll",
    description: "Scroll most of a screen down, up, right, or left so more of the page loads. With a ref from the latest snapshot, the nearest scrolling box around that control moves, or the page when there is none. The reply is a new snapshot and says whether anything moved.",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: [...LIVE_SCROLL_DIRECTIONS] }, ref: { type: "string" } },
      required: ["direction"],
    },
  },
  {
    name: "live_screenshot",
    description: "Save a readable screenshot into this Mac's live session. Careful mode blurs screenshots and video. The reply is the shot name, not the picture bytes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_stop",
    description: "Close the live session and write its workflow in this Mac's library. Each click, typed field, key, scroll, and named read that went through is on the session's trail, and the workflow is built from it. Only Experian workflows keep repeated clicks, clicks with no visible effect and typed corrections in order; other presets condense them as before. Scrolls stay in the trail but do not become steps. Typed text becomes an input, except a search box's text, which replay types again as recorded. run_workflow and the Bao app replay that workflow in a new window of the same Chrome, with no model call and no approval step. Replay repeats the recorded steps, skips a cart add when the item is already in the cart, and keeps the existing replay guards. The live session's careful setting does not change replay.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export type SlotState =
  | { phase: "idle" }
  | { phase: "open"; id: string }
  | { phase: "closed"; id: string; status: string };

export type Admission =
  | { kind: "run" }
  | { kind: "stop-already" }
  | { kind: "reject"; reason: "busy" | "not_open" };

export function admit(slot: SlotState, op: LiveOpName): Admission {
  if (op === "live_session_start") {
    return slot.phase === "open" ? { kind: "reject", reason: "busy" } : { kind: "run" };
  }
  if (op === "live_stop") {
    if (slot.phase === "closed") return { kind: "stop-already" };
    if (slot.phase !== "open") return { kind: "reject", reason: "not_open" };
    return { kind: "run" };
  }
  if (slot.phase !== "open") return { kind: "reject", reason: "not_open" };
  return { kind: "run" };
}

/** Not a tool. The MCP proxy sends it when its client goes away, and the host saves that client's open session. */
export const LIVE_DISCONNECT = "live_disconnect";

/** Not a tool. bao mcp's run_workflow sends it so the app replays a cdp-live workflow in its live target. */
export const LIVE_REPLAY = "live_replay";

export interface LiveControlFact {
  index: number;
  label: string;
  kind: string;
  form?: string;
  href?: string;
  field?: { type: string; name: string; autocomplete: string };
  /** A field's form submits through this button on Enter. Absent when there is no form or no submit button. */
  formSubmit?: string;
  options?: { value: string; label: string; selected: boolean; disabled: boolean }[];
}

export interface PageFacts {
  path: string;
  url?: string;
  title: string;
  headings: string[];
  blocked: string;
  text?: string;
  controls: LiveControlFact[];
  /** The index of the control readLivePage marked by its tree() handle. -1 when that element is not a listed control. */
  marked?: number;
}

export interface LiveControlView {
  ref: string;
  label: string;
  kind: string;
  options?: LiveControlFact["options"];
}

export interface LiveView {
  path: string;
  title: string;
  headings: string[];
  controls: LiveControlView[];
  stopBeforeConfirm: { label: string }[];
  credentialFields: number;
  reached?: { ref: string; label: string };
  epoch: number;
}

/** One page of a view. `controlsTotal` counts every control in the read. */
export interface LiveViewPage extends LiveView {
  page: number;
  pages: number;
  controlsTotal: number;
}

/** The active preset and session mode. Absent mode keeps legacy recordings guarded. */
export type LabelGuard = Pick<GuardPreset, "commit" | "deny" | "submit" | "freezeCommit"> & { careful?: boolean; allowCommit?: boolean };

export const EXPERIAN_COMMIT_INSTRUCTION = `${EXPERIAN_COMMIT_MESSAGE} Confirm with the owner before starting a new careful session with allowCommit: true.`;

type TargetKind = "click" | "field" | "commit" | "credential" | "deny";

interface RefTarget {
  index: number;
  kind: TargetKind;
  selector: string;
  href: string;
  /** Why Enter in this field is refused, or empty. */
  enter: string;
}

export interface LiveRead {
  careful?: boolean;
  view: LiveView;
  targets: {
    byRef: Map<string, RefTarget>;
    passwordRef?: string;
  };
}

export type Plan =
  | { ok: true; selector: string }
  | { ok: false; refusal: string };

function refFor(epoch: number, index: number): string {
  return `e${epoch}.c${index}`;
}

function selectorFor(index: number): string {
  return `[data-bao-live="${index}"]`;
}

const CREDENTIAL_WORD = /\b(password|passcode|otp|cvv|cvc|ssn|social security|card number|security code|pin|verification code|one-time code|one time code|2fa|two-factor|two factor)\b/;

function credential(control: LiveControlFact): boolean {
  if (control.kind !== "field") return false;
  const type = (control.field?.type || "").toLowerCase();
  const auto = (control.field?.autocomplete || "").toLowerCase();
  const name = `${control.field?.name || ""} ${control.label}`.toLowerCase();
  if (type === "password") return true;
  if (/password|username|one-time-code|cc-number|cc-csc|cc-exp/.test(auto)) return true;
  if (CREDENTIAL_WORD.test(name)) return true;
  return false;
}

function pattern(source: string, label: string): boolean {
  if (!source || !label) return false;
  try {
    return new RegExp(source, "i").test(label);
  } catch {
    return false;
  }
}

function freezeFlow(facts: PageFacts, guard: LabelGuard): boolean {
  return guard.freezeCommit === true && /\b(?:unfreeze|freeze|lift|thaw)\b/i.test(`${facts.path} ${facts.title} ${facts.headings.join(" ")}`);
}

function commitRefusal(control: LiveControlFact, guard: LabelGuard, facts: PageFacts): string {
  if (control.kind === "field") return "";
  if (pattern(COMMIT_FLOOR, control.label) || pattern(guard.commit, control.label)) return "stop_before_confirm";
  if (control.form === "search") return "";
  const inFreezeFlow = freezeFlow(facts, guard);
  const finalFreeze = inFreezeFlow
    && /\b(?:review|confirm(?:ation)?)\b/i.test(`${facts.path} ${facts.title} ${facts.headings.join(" ")}`)
    && /^(?:unfreeze|freeze|lift|thaw|confirm|submit)\b/i.test(control.label);
  if (control.kind !== "link" && finalFreeze) {
    return guard.allowCommit === true ? "" : "experian_commit";
  }
  if (inFreezeFlow && /^(?:continue|next|review)\b/i.test(control.label)) return "";
  return control.kind === "submit" && !pattern(guard.submit, control.label) ? "stop_before_confirm" : "";
}

function denied(control: LiveControlFact, denySource: string): boolean {
  if (control.kind === "field") return false;
  return pattern(denySource, control.label);
}

export function searchField(control: LiveControlFact): boolean {
  return control.form === "search" || control.field?.type === "search" || /\bsearch\b/i.test(control.label);
}

/**
 * Enter in a field can submit its form. With a submit button, that button is judged as a click.
 * With none, the form can still submit, or a page script can act, so only a search box takes Enter.
 */
function enterRefusal(control: LiveControlFact, guard: LabelGuard, facts: PageFacts): string {
  if (pattern(guard.deny, control.label)) return "denied";
  if (pattern(COMMIT_FLOOR, control.label) || pattern(guard.commit, control.label)) return "stop_before_confirm";
  if (control.formSubmit !== undefined) {
    const button: LiveControlFact = { index: control.index, label: control.formSubmit, kind: "submit", form: control.form };
    if (denied(button, guard.deny)) return "denied";
    return commitRefusal(button, guard, facts);
  }
  return searchField(control) ? "" : "stop_before_confirm";
}

export function buildView(facts: PageFacts, epoch: number, guard: LabelGuard): LiveRead {
  const view: LiveView = {
    path: facts.path.startsWith("/") ? facts.path.slice(0, 120) : "",
    title: redactLabel(facts.title).slice(0, 80),
    headings: facts.headings.map((item) => redactLabel(item)).filter(Boolean).slice(0, 8),
    controls: [],
    stopBeforeConfirm: [],
    credentialFields: 0,
    epoch,
  };
  const byRef = new Map<string, RefTarget>();
  let passwordRef: string | undefined;
  for (const control of facts.controls) {
    const ref = refFor(epoch, control.index);
    const selector = selectorFor(control.index);
    const href = control.href || "";
    if (credential(control)) {
      view.credentialFields += 1;
      if (guard.careful !== false) {
        byRef.set(ref, { index: control.index, kind: "credential", selector, href, enter: "credential_field" });
        passwordRef = passwordRef || ref;
        continue;
      }
    }
    const label = guard.careful === false ? control.label : redactLabel(control.label);
    if (!label && guard.careful !== false) continue;
    if (guard.careful !== false && denied(control, guard.deny)) {
      view.stopBeforeConfirm.push({ label });
      byRef.set(ref, { index: control.index, kind: "deny", selector, href, enter: "denied" });
      continue;
    }
    const refusal = guard.careful === false ? "" : commitRefusal(control, guard, facts);
    if (refusal) {
      view.stopBeforeConfirm.push({ label });
      byRef.set(ref, { index: control.index, kind: "commit", selector, href, enter: refusal });
      if (refusal === "experian_commit") view.reached = { ref, label };
      continue;
    }
    const kind: TargetKind = control.kind === "field" ? "field" : "click";
    const enter = kind === "field" && guard.careful !== false ? enterRefusal(control, guard, facts) : "";
    byRef.set(ref, { index: control.index, kind, selector, href, enter });
    view.controls.push({ ref, label, kind: control.kind, ...(control.options ? { options: control.options } : {}) });
  }
  return { careful: guard.careful, view, targets: { byRef, passwordRef } };
}

/** One page of the view's controls. A page past either end is clamped to that end. */
export function viewPage(view: LiveView, page = 1): LiveViewPage {
  const pages = Math.max(1, Math.ceil(view.controls.length / LIVE_PAGE_SIZE));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return {
    ...view,
    controls: view.controls.slice((at - 1) * LIVE_PAGE_SIZE, at * LIVE_PAGE_SIZE),
    page: at,
    pages,
    controlsTotal: view.controls.length,
  };
}

/** True when `after`, read while marking, still has the control `before` planned for `ref`. */
export function sameTarget(before: LiveRead, after: LiveRead, ref: string): boolean {
  const was = before.targets.byRef.get(ref);
  const now = after.targets.byRef.get(ref);
  if (!was || !now || was.kind !== now.kind || was.href !== now.href || was.enter !== now.enter) return false;
  const label = before.view.controls.find((control) => control.ref === ref);
  const next = after.view.controls.find((control) => control.ref === ref);
  return !!label && !!next && label.label === next.label && label.kind === next.kind;
}

function parsedRef(ref: string): { epoch: number; index: number } | null {
  const match = /^e(\d+)\.c(\d+)$/.exec(ref);
  if (!match) return null;
  return { epoch: Number(match[1]), index: Number(match[2]) };
}

export function planClick(read: LiveRead, ref: string): Plan {
  const parsed = parsedRef(ref);
  if (!parsed || parsed.epoch !== read.view.epoch) return { ok: false, refusal: "stale_ref" };
  const target = read.targets.byRef.get(ref);
  if (!target) return { ok: false, refusal: "unknown_ref" };
  if (target.kind === "commit") return { ok: false, refusal: target.enter };
  if (target.kind === "deny") return { ok: false, refusal: "denied" };
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  return { ok: true, selector: target.selector };
}

/** Enter needs a ref. Tab and Escape without one go to whatever has focus. */
export function planKey(read: LiveRead, key: string, ref: string): Plan {
  const common = /^(?:(?:Meta|Control|Ctrl|Cmd|Alt|Shift)\+)*(?:Enter|Return|Tab|Escape|Arrow(?:Up|Down|Left|Right)|Backspace|Delete|Space|Home|End|PageUp|PageDown|[a-zA-Z0-9 ])$/i;
  if (read.careful === false ? !common.test(key) : !(LIVE_KEYS as readonly string[]).includes(key)) return { ok: false, refusal: "key_not_allowed" };
  if (!ref) return key === "Enter" && read.careful !== false ? { ok: false, refusal: "ref_required" } : { ok: true, selector: "" };
  const plan = planClick(read, ref);
  if (!plan.ok) return plan;
  const enter = read.targets.byRef.get(ref)?.enter || "";
  if (key === "Enter" && enter) return { ok: false, refusal: enter };
  return plan;
}

/** Without a ref the page scrolls. A ref names a listed control whose scrolling box moves. */
export function planScroll(read: LiveRead, direction: string, ref: string): Plan {
  if (!(LIVE_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) return { ok: false, refusal: "direction_not_allowed" };
  if (!ref) return { ok: true, selector: "" };
  return planClick(read, ref);
}

export function planType(read: LiveRead, ref: string, text: string, prior = ""): Plan {
  const parsed = parsedRef(ref);
  if (!parsed || parsed.epoch !== read.view.epoch) return { ok: false, refusal: "stale_ref" };
  const target = read.targets.byRef.get(ref);
  if (!target) return { ok: false, refusal: "unknown_ref" };
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  if (target.kind !== "field") return { ok: false, refusal: "not_a_field" };
  const refusal = read.careful === false ? null : insertTextRefusal(text, prior);
  if (refusal) return { ok: false, refusal };
  return { ok: true, selector: target.selector };
}

export function pageHalt(facts: { blocked: string; path: string; url?: string; passwordFields: number; text?: string; stopPath?: string }): "login_wall" | "bot_wall" | "stop-path" | null {
  const halt = pathHalt(facts.path, facts.stopPath);
  if (halt) return halt;
  const text = (facts.text || "").toLowerCase();
  if (/request unsuccessful|powered by imperva|incapsula incident/.test(text)) return "bot_wall";
  if (/verify you are human|i'm not a robot|i’m not a robot|recaptcha challenge/.test(text)) return "bot_wall";
  if (facts.passwordFields > 0 && /continue with google|sign in with google|sign in with apple|continue with apple|single sign-on|\bsso\b|verification code|one-time code|one time code|two-factor|two factor|\b2fa\b|security code|\bpin\b/.test(text)) return "login_wall";
  if (facts.blocked === "login" || facts.blocked === "login_wall") {
    return "login_wall";
  }
  if (facts.blocked === "bot_wall" || facts.blocked === "captcha") return "bot_wall";
  return null;
}

export function targetVerdict(
  event: { type?: string; targetId?: string; openerId?: string },
  ownId: string,
  baseline?: ReadonlySet<string>,
): "close" | "ignore" {
  if (event.type && event.type !== "page") return "ignore";
  if (!event.targetId || event.targetId === ownId) return "ignore";
  if (event.openerId === ownId) return "close";
  if (baseline && !baseline.has(event.targetId)) return "close";
  return "ignore";
}

export function workflowIdsFromIntent(intent: string, explicit?: string): { workflowId: string; runId: string } {
  if (explicit && /^wf-[\w.-]+$/.test(explicit)) {
    return { workflowId: explicit, runId: `run-${explicit.slice(3)}` };
  }
  // 37 keeps wf-{slug} within the 40 characters a live session id holds, so the cut never ends on a dash.
  const slug = intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 37).replace(/-+$/, "") || "session";
  return { workflowId: `wf-${slug}`, runId: `run-${slug}` };
}

const SECRET_KEY = /^(cookies?|localStorage|sessionStorage|storage|document)$/i;

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(item);
  }
  return out;
}

export function publicLiveResult(value: unknown): unknown {
  return stripSecrets(value);
}

/** Page function. Chooses one option on the select this process just marked. */
export function selectLiveOption(ask: { markIndex: number; option: string }): string | null {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (!(el instanceof HTMLSelectElement)) return "not_a_select";
  const byValue = Array.from(el.options).filter((option) => option.value === ask.option);
  const options = byValue.length ? byValue : Array.from(el.options).filter((option) => option.label === ask.option);
  if (options.length !== 1) return options.length ? "ambiguous option" : "option not found";
  if (el.matches(":disabled") || options[0]!.matches(":disabled")) return "option is disabled";
  el.value = options[0]!.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return null;
}

/** Page function. Focuses the control this process just marked. */
export function focusLiveMark(ask: { markIndex: number }): void {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (el instanceof HTMLElement) el.focus();
}

/** Page function. Selects the marked field's text, so the next insert replaces it. */
export function selectLiveMark(ask: { markIndex: number }): void {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  else if (el instanceof HTMLElement && el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

/** Page function. The value already in the marked field. It is not returned to the caller of the tool. */
export function markedFieldValue(ask: { markIndex: number }): string {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || "");
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText;
  return "";
}

export interface MarkedState {
  /** The data-bao-i handle tree() gave the element. */
  handle: string;
  /** The element's own text. */
  text: string;
  /** A text field's value. Empty for a password and for other controls. */
  value: string;
  /** The marked element is no longer on the page. */
  missing: boolean;
}

/** Page function. The marked control as the live trail records it. */
export function markedState(ask: { markIndex: number }): MarkedState {
  const el = ask.markIndex >= 0 ? document.querySelector(`[data-bao-live="${ask.markIndex}"]`) : null;
  if (!(el instanceof HTMLElement) || !el.isConnected) return { handle: "", text: "", value: "", missing: true };
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const field = el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement
      && !/^(password|button|submit|reset|image|checkbox|radio|file|hidden)$/.test((el.getAttribute("type") || "text").toLowerCase()));
  const value = field ? String((el as HTMLInputElement | HTMLTextAreaElement).value || "").slice(0, 2000) : "";
  return { handle: el.getAttribute("data-bao-i") || "", text, value, missing: false };
}

/** Page function. True only when focus is still the marked control, including through an open shadow root. */
export function focusStillMarked(ask: { markIndex: number; careful?: boolean }): { ok: boolean; credential: boolean } {
  const marked = ask.markIndex >= 0 ? document.querySelector(`[data-bao-live="${ask.markIndex}"]`) : null;
  let node: Element | null = document.activeElement;
  while (node && node.shadowRoot) {
    const inner = node.shadowRoot.activeElement;
    if (!inner || inner === node) break;
    node = inner;
  }
  const focused = node;
  const password = focused instanceof HTMLInputElement && (focused.getAttribute("type") || "").toLowerCase() === "password";
  const auto = focused instanceof HTMLInputElement ? (focused.getAttribute("autocomplete") || "").toLowerCase() : "";
  const labels = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
    ? Array.from(focused.labels || []).map((label) => label.textContent || "").join(" ")
    : "";
  const name = focused instanceof HTMLElement
    ? `${focused.getAttribute("name") || ""} ${focused.getAttribute("aria-label") || ""} ${labels}`.toLowerCase()
    : "";
  const credential = password || /password|one-time-code|cc-number|cc-csc/.test(auto)
    || /\b(password|passcode|otp|cvv|cvc|ssn|social security|card number|security code|pin|verification code|one-time code|one time code|2fa|two-factor|two factor)\b/.test(name);
  const allowed = ask.careful === false || !credential;
  if (!(marked instanceof HTMLElement)) return { ok: ask.markIndex < 0 && allowed, credential };
  if (!focused) return { ok: false, credential };
  const same = focused === marked || marked.contains(focused);
  return { ok: same && allowed, credential };
}

/**
 * Page function. It lists visible controls and never reads cookies or storage.
 * markIndex marks the control at that index. markHandle marks the control that
 * tree() gave that data-bao-i handle, and the reply says which index it has.
 */
export function readLivePage(ask: { markIndex: number; markHandle?: string; careful?: boolean }): PageFacts {
  const mark = typeof ask?.markIndex === "number" ? ask.markIndex : -1;
  const handle = typeof ask?.markHandle === "string" ? ask.markHandle : "";
  if (mark >= 0 || handle) {
    document.querySelectorAll("[data-bao-live]").forEach((el) => el.removeAttribute("data-bao-live"));
  }
  const controls: LiveControlFact[] = [];
  let index = 0;
  let marked = -1;
  let credentialHalt = false;
  const buttonInput = (el: Element): boolean => el instanceof HTMLInputElement
    && /^(submit|image|button|reset)$/.test((el.getAttribute("type") || "").toLowerCase());
  const labelled = (el: Element): string => (
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      ? Array.from(el.labels || []).map((label) => {
        const copy = label.cloneNode(true) as Element;
        copy.querySelectorAll("input, textarea, select").forEach((field) => field.remove());
        return copy.textContent || "";
      }).join(" ").trim()
      : ""
  );
  const textOf = (el: Element): string => (
    el.getAttribute("aria-label")
    || (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim()
    || (buttonInput(el) ? (el as HTMLInputElement).value || el.getAttribute("alt") || el.getAttribute("name") : "")
    || labelled(el)
    || el.getAttribute("placeholder")
    || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.getAttribute("name") : "")
    || el.textContent
    || ""
  ).replace(/\s+/g, " ").trim();
  const submits = (el: Element): boolean => (el instanceof HTMLButtonElement && el.type === "submit")
    || (el instanceof HTMLInputElement && /^(submit|image)$/.test((el.getAttribute("type") || "").toLowerCase()));
  const ownerOf = (el: Element): HTMLFormElement | null => (
    el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.form : el.closest("form")
  );
  const concealed = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return true;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const owner = el.closest("form");
    if (owner instanceof HTMLElement && (owner.hidden || owner.getAttribute("aria-hidden") === "true")) return true;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const box = el.getBoundingClientRect();
    return box.width < 1 || box.height < 1;
  };
  const visit = (el: Element, kind: string, field?: { type: string; name: string; autocomplete: string }): void => {
    if (concealed(el)) return;
    const label = textOf(el);
    if (!label && ask.careful !== false) return;
    if (mark === index || (handle && el.getAttribute("data-bao-i") === handle)) {
      el.setAttribute("data-bao-live", String(index));
      if (handle) marked = index;
    }
    const form = ownerOf(el);
    const search = !!form && (!!form.querySelector("input[type=search]") || !!form.closest("[role=search], search"));
    const href = el instanceof HTMLAnchorElement ? el.href : "";
    const blob = `${field?.type || ""} ${field?.name || ""} ${field?.autocomplete || ""} ${label}`.toLowerCase();
    if (field && /\b(security code|pin|verification code|one-time code|one time code|2fa|two-factor|two factor|otp)\b/.test(blob)) {
      credentialHalt = true;
    }
    const fact: LiveControlFact = { index, label, kind, form: search ? "search" : "", href, field };
    const button = field && form ? Array.from(form.elements).find(submits) : undefined;
    if (button) fact.formSubmit = textOf(button);
    if (el instanceof HTMLSelectElement) fact.options = Array.from(el.options).map((option) => ({ value: option.value, label: option.label, selected: option.selected, disabled: option.disabled }));
    controls.push(fact);
    index += 1;
  };
  for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [contenteditable]:not([contenteditable="false"])')) {
    if (el instanceof HTMLAnchorElement) {
      visit(el, "link");
      continue;
    }
    if (el instanceof HTMLButtonElement || buttonInput(el)) {
      visit(el, submits(el) && ownerOf(el) ? "submit" : "button");
      continue;
    }
    if (el instanceof HTMLSelectElement) { visit(el, "select"); continue; }
    const role = el.getAttribute("role");
    const editable = el instanceof HTMLElement && el.isContentEditable;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !editable) { visit(el, role || "button"); continue; }
    const type = (el.getAttribute("type") || (editable ? "contenteditable" : "text")).toLowerCase();
    if (type === "hidden") continue;
    visit(el, "field", {
      type,
      name: el.getAttribute("name") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
    });
  }
  const headings = [...document.querySelectorAll("h1, h2")].slice(0, 8).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
  return {
    path: `${location.pathname || "/"}${location.hash || ""}`,
    url: location.href,
    title: document.title || "",
    headings,
    blocked: credentialHalt ? "login" : "",
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500),
    controls,
    ...(handle ? { marked } : {}),
  };
}

export interface ScrollFacts {
  /** `none` means the marked control is gone. */
  target: "page" | "box" | "none";
  moved: boolean;
}

/**
 * Page function. Scrolls the nearest box around the marked control that can still move,
 * else the page. With no mark and a page that cannot move, it scrolls the largest box
 * that can, because many app shells scroll an inner box instead of the page.
 */
export function scrollLivePage(ask: { markIndex: number; direction: string }): ScrollFacts {
  const vertical = ask.direction === "down" || ask.direction === "up";
  const sign = ask.direction === "down" || ask.direction === "right" ? 1 : -1;
  const page = document.scrollingElement || document.documentElement;
  const room = (el: Element): number => {
    if (vertical) return sign > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
    return sign > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
  };
  const moves = (el: Element): boolean => {
    if (room(el) < 1) return false;
    if (el === page) return true;
    const style = getComputedStyle(el);
    return /auto|scroll|overlay/.test(vertical ? style.overflowY : style.overflowX);
  };
  const up = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  let box: Element | null = null;
  if (ask.markIndex >= 0) {
    const marked = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
    if (!marked) return { target: "none", moved: false };
    for (let node = up(marked); node && node !== page; node = up(node)) {
      if (moves(node)) {
        box = node;
        break;
      }
    }
  }
  if (!box && moves(page)) box = page;
  if (!box && ask.markIndex < 0) {
    let best = 0;
    for (const el of document.querySelectorAll("body, body *")) {
      if (!moves(el)) continue;
      const rect = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
        * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      if (area > best) {
        best = area;
        box = el;
      }
    }
  }
  if (!box) return { target: "page", moved: false };
  const size = box === page ? (vertical ? innerHeight : innerWidth) : (vertical ? box.clientHeight : box.clientWidth);
  const step = sign * Math.max(40, Math.round(size * 0.8));
  const before = vertical ? box.scrollTop : box.scrollLeft;
  box.scrollBy({ top: vertical ? step : 0, left: vertical ? 0 : step, behavior: "instant" });
  const after = vertical ? box.scrollTop : box.scrollLeft;
  return { target: box === page ? "page" : "box", moved: after !== before };
}
