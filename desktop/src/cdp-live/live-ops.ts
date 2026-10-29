import { insertTextRefusal } from "./allowlist";
import { redactLabel } from "./live-record";

export const LIVE_TOOL_NAMES = [
  "live_session_start",
  "live_snapshot",
  "live_click",
  "live_type",
  "live_screenshot",
  "live_stop",
] as const;

export type LiveOpName = (typeof LIVE_TOOL_NAMES)[number];

export function isLiveOp(value: string): value is LiveOpName {
  return (LIVE_TOOL_NAMES as readonly string[]).includes(value);
}

export const LIVE_TOOLS = [
  {
    name: "live_session_start",
    description: "Open a local live session on one http(s) page in the running Chrome. Pass an intent, a url, and an absolute DevToolsActivePort path. A preset (generic, instacart, books) supplies deny labels, confirm labels, and stop paths. Those are refused before navigation and before a click. The reply lists controls and names the buttons that will not be clicked. It does not return cookies or storage.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        url: { type: "string" },
        portFile: { type: "string" },
        preset: { type: "string", enum: ["generic", "instacart", "books"] },
        workflowId: { type: "string" },
      },
      required: ["intent", "url", "portFile"],
    },
  },
  {
    name: "live_snapshot",
    description: "Read the open live page. Confirm buttons and denied labels are named and not given a ref. Credential fields, including security code, PIN, verification code, and one-time code, are counted and not given a ref.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_click",
    description: "Click one ref from the latest snapshot. A confirm button or a denied label is refused and not clicked. A control covered by another element is refused and not clicked.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "live_type",
    description: "Type into one non-credential field from the latest snapshot. Passwords, security codes, card numbers, SSNs, and secret-looking text are refused. Typing stops if focus is no longer that field.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] },
  },
  {
    name: "live_screenshot",
    description: "Save a redacted screenshot into this Mac's live session. The reply is the shot name, not the picture bytes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_stop",
    description: "Close the live session and write its workflow in this Mac's library. A confirm step is saved before each typed field. Replay of that file uses the open Chrome and does not call a model.",
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

export interface LiveControlFact {
  index: number;
  label: string;
  kind: string;
  form?: string;
  href?: string;
  field?: { type: string; name: string; autocomplete: string };
}

export interface PageFacts {
  path: string;
  title: string;
  headings: string[];
  blocked: string;
  text?: string;
  controls: LiveControlFact[];
}

export interface LiveControlView {
  ref: string;
  label: string;
  kind: string;
}

export interface LiveView {
  path: string;
  title: string;
  headings: string[];
  controls: LiveControlView[];
  stopBeforeConfirm: { label: string }[];
  credentialFields: number;
  epoch: number;
}

type TargetKind = "click" | "field" | "commit" | "credential" | "deny";

export interface LiveRead {
  view: LiveView;
  targets: {
    byRef: Map<string, { index: number; kind: TargetKind; selector: string; href: string }>;
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

function commit(control: LiveControlFact, commitSource: string): boolean {
  if (control.kind === "field") return false;
  if (pattern(commitSource, control.label)) return true;
  if (control.form === "search") return false;
  if (control.kind === "submit") return true;
  return false;
}

function denied(control: LiveControlFact, denySource: string): boolean {
  if (control.kind === "field") return false;
  return pattern(denySource, control.label);
}

export function buildView(facts: PageFacts, epoch: number, commitSource: string, denySource = ""): LiveRead {
  const view: LiveView = {
    path: facts.path.startsWith("/") ? facts.path.slice(0, 120) : "",
    title: redactLabel(facts.title).slice(0, 80),
    headings: facts.headings.map((item) => redactLabel(item)).filter(Boolean).slice(0, 8),
    controls: [],
    stopBeforeConfirm: [],
    credentialFields: 0,
    epoch,
  };
  const byRef = new Map<string, { index: number; kind: TargetKind; selector: string; href: string }>();
  let passwordRef: string | undefined;
  for (const control of facts.controls) {
    const ref = refFor(epoch, control.index);
    const selector = selectorFor(control.index);
    const href = control.href || "";
    if (credential(control)) {
      view.credentialFields += 1;
      byRef.set(ref, { index: control.index, kind: "credential", selector, href });
      passwordRef = passwordRef || ref;
      continue;
    }
    const label = redactLabel(control.label);
    if (!label) continue;
    if (denied(control, denySource)) {
      view.stopBeforeConfirm.push({ label });
      byRef.set(ref, { index: control.index, kind: "deny", selector, href });
      continue;
    }
    if (commit(control, commitSource)) {
      view.stopBeforeConfirm.push({ label });
      byRef.set(ref, { index: control.index, kind: "commit", selector, href });
      continue;
    }
    const kind: TargetKind = control.kind === "field" ? "field" : "click";
    byRef.set(ref, { index: control.index, kind, selector, href });
    view.controls.push({ ref, label, kind: control.kind });
  }
  return { view, targets: { byRef, passwordRef } };
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
  if (target.kind === "commit") return { ok: false, refusal: "stop_before_confirm" };
  if (target.kind === "deny") return { ok: false, refusal: "denied" };
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  return { ok: true, selector: target.selector };
}

export function planType(read: LiveRead, ref: string, text: string, prior = ""): Plan {
  const parsed = parsedRef(ref);
  if (!parsed || parsed.epoch !== read.view.epoch) return { ok: false, refusal: "stale_ref" };
  const target = read.targets.byRef.get(ref);
  if (!target) return { ok: false, refusal: "unknown_ref" };
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  if (target.kind !== "field") return { ok: false, refusal: "not_a_field" };
  const refusal = insertTextRefusal(text, prior);
  if (refusal) return { ok: false, refusal };
  return { ok: true, selector: target.selector };
}

export function pageHalt(facts: { blocked: string; path: string; passwordFields: number; text?: string }): "login_wall" | "bot_wall" | null {
  const text = (facts.text || "").toLowerCase();
  if (/request unsuccessful|powered by imperva|incapsula incident/.test(text)) return "bot_wall";
  if (/verify you are human|i'm not a robot|i’m not a robot|recaptcha challenge/.test(text)) return "bot_wall";
  if (/continue with google|sign in with google|sign in with apple|continue with apple|single sign-on|\bsso\b/.test(text)) return "login_wall";
  if (/verification code|one-time code|one time code|two-factor|two factor|\b2fa\b|security code|\bpin\b/.test(text)) return "login_wall";
  if (facts.blocked === "login" || facts.blocked === "login_wall" || (facts.passwordFields > 0 && /login|sign-?in/i.test(facts.path))) {
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
  const slug = intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
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

/** Page function. Focuses the control this process just marked. */
export function focusLiveMark(ask: { markIndex: number }): void {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (el instanceof HTMLElement) el.focus();
}

/** Page function. The value already in the marked field. It is not returned to the caller of the tool. */
export function markedFieldValue(ask: { markIndex: number }): string {
  const el = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || "").slice(0, 80);
  return "";
}

/** Page function. True only when focus is still the marked control, including through an open shadow root. */
export function focusStillMarked(ask: { markIndex: number }): { ok: boolean; credential: boolean } {
  const marked = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  let node: Element | null = document.activeElement;
  while (node && node.shadowRoot) {
    const inner = node.shadowRoot.activeElement;
    if (!inner || inner === node) break;
    node = inner;
  }
  const focused = node;
  const password = focused instanceof HTMLInputElement && (focused.getAttribute("type") || "").toLowerCase() === "password";
  const auto = focused instanceof HTMLInputElement ? (focused.getAttribute("autocomplete") || "").toLowerCase() : "";
  const name = focused instanceof HTMLElement
    ? `${focused.getAttribute("name") || ""} ${focused.getAttribute("aria-label") || ""}`.toLowerCase()
    : "";
  const credential = password || /password|one-time-code|cc-number|cc-csc/.test(auto)
    || /\b(password|passcode|otp|cvv|cvc|ssn|social security|card number|security code|pin|verification code|one-time code|one time code|2fa|two-factor|two factor)\b/.test(name);
  if (!(marked instanceof HTMLElement) || !focused) return { ok: false, credential };
  const same = focused === marked || marked.contains(focused);
  return { ok: same && !credential, credential };
}

/** Page function. It lists visible controls and never reads cookies or storage. */
export function readLivePage(ask: { markIndex: number }): PageFacts {
  const mark = typeof ask?.markIndex === "number" ? ask.markIndex : -1;
  if (mark >= 0) {
    document.querySelectorAll("[data-bao-live]").forEach((el) => el.removeAttribute("data-bao-live"));
  }
  const controls: LiveControlFact[] = [];
  let index = 0;
  let credentialHalt = false;
  const textOf = (el: Element): string => (
    el.getAttribute("aria-label")
    || el.getAttribute("placeholder")
    || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.getAttribute("name") : "")
    || el.textContent
    || ""
  ).replace(/\s+/g, " ").trim().slice(0, 80);
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
    if (!label) return;
    if (mark === index) el.setAttribute("data-bao-live", String(index));
    const form = el.closest("form");
    const search = !!form && (!!form.querySelector("input[type=search]") || form.getAttribute("role") === "search");
    const href = el instanceof HTMLAnchorElement ? el.href : "";
    const blob = `${field?.type || ""} ${field?.name || ""} ${field?.autocomplete || ""} ${label}`.toLowerCase();
    if (field && /\b(security code|pin|verification code|one-time code|one time code|2fa|two-factor|two factor|otp)\b/.test(blob)) {
      credentialHalt = true;
    }
    controls.push({ index, label, kind, form: search ? "search" : "", href, field });
    index += 1;
  };
  for (const el of document.querySelectorAll("a[href], button, input[type=submit]")) {
    const submit = (el as HTMLInputElement).type === "submit" || (el.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit");
    const kind = el.tagName === "A" ? "link" : submit ? "submit" : "button";
    visit(el, kind);
  }
  for (const el of document.querySelectorAll("input, textarea")) {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden" || type === "submit") continue;
    visit(el, "field", {
      type,
      name: input.getAttribute("name") || "",
      autocomplete: input.getAttribute("autocomplete") || "",
    });
  }
  const headings = [...document.querySelectorAll("h1, h2")].slice(0, 8).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
  return {
    path: `${location.pathname || "/"}${location.hash || ""}`,
    title: document.title || "",
    headings,
    blocked: credentialHalt ? "login" : "",
    text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500),
    controls,
  };
}
