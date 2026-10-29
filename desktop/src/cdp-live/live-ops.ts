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
    description: "Open a local live session on one http(s) page in the running Chrome. Pass an intent and a url. A preset (generic, instacart, books) supplies the guard patterns. The reply lists controls and the buttons that will not be clicked. It does not return cookies or storage.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        url: { type: "string" },
        portFile: { type: "string" },
        preset: { type: "string", enum: ["generic", "instacart", "books"] },
      },
      required: ["intent", "url", "portFile"],
    },
  },
  {
    name: "live_snapshot",
    description: "Read the open live page. Confirm buttons are named and not given a ref. Credential fields are counted and not given a ref.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_click",
    description: "Click one ref from the latest snapshot. A confirm button is refused and not clicked.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "live_type",
    description: "Type into one non-credential field from the latest snapshot. Passwords, card numbers, and secret-looking text are refused.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] },
  },
  {
    name: "live_screenshot",
    description: "Save a redacted screenshot into this Mac's live session. The reply is the shot name, not the picture bytes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "live_stop",
    description: "Close the live session and leave the page where it is.",
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
  field?: { type: string; name: string; autocomplete: string };
}

export interface PageFacts {
  path: string;
  title: string;
  headings: string[];
  blocked: string;
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

type TargetKind = "click" | "field" | "commit" | "credential";

export interface LiveRead {
  view: LiveView;
  targets: {
    byRef: Map<string, { index: number; kind: TargetKind; selector: string }>;
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

function credential(control: LiveControlFact): boolean {
  const type = (control.field?.type || "").toLowerCase();
  const auto = (control.field?.autocomplete || "").toLowerCase();
  const name = `${control.field?.name || ""} ${control.label}`.toLowerCase();
  if (type === "password") return true;
  if (/password|username|one-time-code|cc-number|cc-csc|cc-exp/.test(auto)) return true;
  if (/\b(password|passcode|otp|cvv|cvc|ssn|social security|card number)\b/.test(name)) return true;
  return false;
}

function commit(control: LiveControlFact, commitSource: string): boolean {
  if (control.kind === "field") return false;
  if (control.form === "search") return false;
  if (control.kind === "submit") return true;
  if (!commitSource) return false;
  try {
    return new RegExp(commitSource, "i").test(control.label);
  } catch {
    return false;
  }
}

export function buildView(facts: PageFacts, epoch: number, commitSource: string): LiveRead {
  const view: LiveView = {
    path: facts.path.startsWith("/") ? facts.path.slice(0, 120) : "",
    title: redactLabel(facts.title).slice(0, 80),
    headings: facts.headings.map((item) => redactLabel(item)).filter(Boolean).slice(0, 8),
    controls: [],
    stopBeforeConfirm: [],
    credentialFields: 0,
    epoch,
  };
  const byRef = new Map<string, { index: number; kind: TargetKind; selector: string }>();
  let passwordRef: string | undefined;
  for (const control of facts.controls) {
    const ref = refFor(epoch, control.index);
    const selector = selectorFor(control.index);
    if (credential(control)) {
      view.credentialFields += 1;
      byRef.set(ref, { index: control.index, kind: "credential", selector });
      passwordRef = passwordRef || ref;
      continue;
    }
    const label = redactLabel(control.label);
    if (!label) continue;
    if (commit(control, commitSource)) {
      view.stopBeforeConfirm.push({ label });
      byRef.set(ref, { index: control.index, kind: "commit", selector });
      continue;
    }
    const kind: TargetKind = control.kind === "field" ? "field" : "click";
    byRef.set(ref, { index: control.index, kind, selector });
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
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  return { ok: true, selector: target.selector };
}

export function planType(read: LiveRead, ref: string, text: string): Plan {
  const parsed = parsedRef(ref);
  if (!parsed || parsed.epoch !== read.view.epoch) return { ok: false, refusal: "stale_ref" };
  const target = read.targets.byRef.get(ref);
  if (!target) return { ok: false, refusal: "unknown_ref" };
  if (target.kind === "credential") return { ok: false, refusal: "credential_field" };
  if (target.kind !== "field") return { ok: false, refusal: "not_a_field" };
  const refusal = insertTextRefusal(text);
  if (refusal) return { ok: false, refusal };
  return { ok: true, selector: target.selector };
}

export function pageHalt(facts: { blocked: string; path: string; passwordFields: number }): "login_wall" | "bot_wall" | null {
  if (facts.blocked === "login" || facts.blocked === "login_wall" || (facts.passwordFields > 0 && /login|sign-?in/i.test(facts.path))) {
    return "login_wall";
  }
  if (facts.blocked === "bot_wall" || facts.blocked === "captcha") return "bot_wall";
  return null;
}

export function targetVerdict(
  event: { type?: string; targetId?: string; openerId?: string },
  ownId: string,
): "close" | "ignore" {
  if (event.type && event.type !== "page") return "ignore";
  if (!event.targetId || event.targetId === ownId) return "ignore";
  if (event.openerId === ownId) return "close";
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

/** Page function. It lists controls and never reads cookies or storage. */
export function readLivePage(ask: { markIndex: number }): PageFacts {
  const mark = typeof ask?.markIndex === "number" ? ask.markIndex : -1;
  const controls: LiveControlFact[] = [];
  let index = 0;
  const textOf = (el: Element): string => (
    el.getAttribute("aria-label")
    || el.getAttribute("placeholder")
    || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.getAttribute("name") : "")
    || el.textContent
    || ""
  ).replace(/\s+/g, " ").trim().slice(0, 80);
  const visit = (el: Element, kind: string, field?: { type: string; name: string; autocomplete: string }): void => {
    const label = textOf(el);
    if (!label) return;
    if (mark === index) el.setAttribute("data-bao-live", String(index));
    const form = el.closest("form");
    const search = !!form && (!!form.querySelector("input[type=search]") || form.getAttribute("role") === "search");
    controls.push({ index, label, kind, form: search ? "search" : "", field });
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
  const password = !!document.querySelector("input[type=password]");
  return {
    path: location.pathname || "/",
    title: document.title || "",
    headings,
    blocked: password ? "login" : "",
    controls,
  };
}
