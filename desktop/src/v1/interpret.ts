// Deterministic interpret. Same trail, same workflow bytes.
// Secrets become inputs. File paths are dropped. No model is required.

import { isSensitiveField, isSensitiveValue } from "../../../src/mask";
import { applyExpect, type KnownTyped } from "./expect";
import { fileAct } from "./file-chooser";
import { locatorsFromIdentity } from "./locators";
import type { Identity, StepLocator, WorkflowInput, WorkflowStep, WorkflowV2 } from "./schema";
import { WORKFLOW_SCHEMA_ID } from "./schema";

export interface TrailEvent {
  id: string;
  ts: number;
  kind: "read" | "act" | "decision";
  op: string;
  /** Append-only teach correction. Interpret does not turn these into steps. */
  decision?: string;
  detail?: string;
  cardId?: string;
  intent?: string;
  name?: string;
  note?: string;
  outcome?: string;
  /** live-model marks a person or model driving MCP. Scripted drivers use another label. */
  source?: { agent: string; vendor: string; adapter: string };
  unresolved?: { reason: string };
  sensitive?: boolean;
  value?: string;
  key?: string;
  pageLevel?: boolean;
  checked?: boolean;
  provenance?: WorkflowStep["provenance"];
  identity?: Identity;
  locators?: StepLocator[];
  beforeUrl?: string;
  afterUrl?: string;
  afterText?: string;
  /** Target subtree text before and after a click. Equal means no subtree diff. */
  subtreeBefore?: string;
  subtreeAfter?: string;
  /** Target value before and after a click, when the target has a value. */
  valueBefore?: string;
  valueAfter?: string;
  /** Basename only. A path here is stripped, not stored. */
  fileName?: string;
  rawPath?: string;
  /** Set when capture refused the action and a person has to do it. */
  gate?: "login" | "confirm";
  /** False when the tool recorded the act and did not change the page. */
  performed?: boolean;
  /** Message from Page.javascriptDialogOpening. The opening itself is an effect. */
  dialog?: string;
  /** alert, confirm, or prompt. */
  dialogType?: "alert" | "confirm" | "prompt";
  /** Which button closed the dialog. An alert records accept. */
  dialogDecision?: "accept" | "dismiss";
}

export interface InterpretMeta {
  id: string;
  name?: string;
  startUrl: string;
  /** Extra exact strings that must not survive into the workflow. */
  secrets?: string[];
}

const NOISE = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup", "dom", "ax", "navigate", "mark",
]);

const DIGIT = /^[0-9]$/;
const OP = new Set(["+", "-", "*", "/", "×", "÷", "="]);

/** Events that become steps, in step order. A merged type keeps the first event id. */
export function retainedEvents(events: readonly TrailEvent[]): TrailEvent[] {
  return mergeTyping(withoutChooserClicks(events.filter(keep)));
}

export interface InterpretPiece {
  events: TrailEvent[];
  step: WorkflowStep;
}

/** The same grouping interpret saves, so a teach card can point at the events behind a step. */
export function explain(events: readonly TrailEvent[], meta: InterpretMeta): { workflow: WorkflowV2; groups: TrailEvent[][] } {
  const built = buildWorkflow(events, meta);
  return { workflow: built.doc, groups: built.groups };
}

export function interpret(events: readonly TrailEvent[], meta: InterpretMeta): WorkflowV2 {
  return buildWorkflow(events, meta).doc;
}

function buildWorkflow(events: readonly TrailEvent[], meta: InterpretMeta): { doc: WorkflowV2; groups: TrailEvent[][] } {
  const secrets = secretStrings(events, meta.secrets ?? []);
  const seen: InterpretMeta = { ...meta, secrets };
  const kept = mergeTyping(withoutChooserClicks(events.filter(keep)));
  const inputs: WorkflowInput[] = [];
  const known: KnownTyped[] = [];
  const drafted = kept.map((event) => {
    const step = toStep(event, 0, seen, inputs, known);
    if (step.action === "type" && step.input && event.value && !step.sensitive && !secrets.includes(event.value)) {
      known.push({ name: step.input, value: event.value });
    }
    return { events: [event], step };
  });
  const pieces = foldNotes(collapseDigits(drafted, inputs), seen.secrets ?? []);
  attachExpr(pieces.map((piece) => piece.step));
  const steps = pieces.map((piece, index) => ({ ...piece.step, index, id: `${meta.id}-${index}` }));
  const doc: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id: meta.id,
    name: meta.name || "Untitled workflow",
    startUrl: meta.startUrl,
    inputs,
    steps,
    createdAt: events[0]?.ts ?? 0,
  };
  assertClean(doc, secrets);
  return { doc, groups: pieces.map((piece) => piece.events) };
}

/** A password field's typed text is a secret even when the caller did not list it. */
function secretStrings(events: readonly TrailEvent[], listed: string[]): string[] {
  const out = [...listed];
  for (const event of events) {
    const password = event.sensitive || event.identity?.role === "password";
    const value = event.value;
    if (!password || !value || value.length < 8 || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function dropReason(event: TrailEvent): string | undefined {
  if (event.kind === "read") return "read";
  if (event.kind === "decision" || event.op === "decision") return "correction";
  if (NOISE.has(event.op)) return event.op || "noise";
  if (event.unresolved) return event.unresolved.reason || "unresolved";
  return undefined;
}

function keep(event: TrailEvent): boolean {
  return dropReason(event) === undefined;
}

export interface TrailDrop {
  id: string;
  reason: string;
}

/** Events interpret does not keep, with the reason each one was left out. */
export function trailDrops(events: readonly TrailEvent[]): TrailDrop[] {
  const dropped: TrailDrop[] = [];
  const kept: TrailEvent[] = [];
  for (const event of events) {
    const reason = dropReason(event);
    if (reason) dropped.push({ id: event.id, reason });
    else kept.push(event);
  }
  const noChooser: TrailEvent[] = [];
  for (let index = 0; index < kept.length; index++) {
    const event = kept[index]!;
    const next = kept[index + 1];
    if (event.op === "click" && next && (next.op === "upload" || next.op === "drop") && sameTarget(event, next)) {
      dropped.push({ id: event.id, reason: "opens the file chooser" });
      continue;
    }
    noChooser.push(event);
  }
  const merged: TrailEvent[] = [];
  for (const event of noChooser) {
    const prev = merged[merged.length - 1];
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event)) {
      dropped.push({ id: event.id, reason: "merged into the previous type" });
      prev.value = event.sensitive ? undefined : (prev.value || "") + (event.value || "");
      prev.sensitive = prev.sensitive || event.sensitive;
      prev.ts = event.ts;
      continue;
    }
    merged.push({ ...event });
  }
  return dropped;
}

/** A click that only opens the chooser is not a step once the file event lands. */
function withoutChooserClicks(events: TrailEvent[]): TrailEvent[] {
  return events.filter((event, index) => {
    if (event.op !== "click") return true;
    const next = events[index + 1];
    if (!next || (next.op !== "upload" && next.op !== "drop")) return true;
    return !sameTarget(event, next);
  });
}

/**
 * A typed note is the step's intent, not its own action.
 * A note after a step attaches to that step. A note before any step attaches to the next one.
 * A trailing note with nothing after it stays a note so the text is kept.
 * Handoff lines stay note steps; they are the pause record, not an intent.
 */
function foldNotes(pieces: InterpretPiece[], secrets: string[]): InterpretPiece[] {
  const out: InterpretPiece[] = [];
  let pending: InterpretPiece | undefined;
  for (const piece of pieces) {
    if (!isIntentNote(piece)) {
      if (pending && piece.step.action !== "note") {
        applyNote(piece, pending, secrets);
        pending = undefined;
      }
      out.push(piece);
      continue;
    }
    const current = out[out.length - 1];
    if (current && current.step.action !== "note") {
      applyNote(current, piece, secrets);
      continue;
    }
    if (pending) {
      pending.events.push(...piece.events);
      pending.step = piece.step;
      continue;
    }
    pending = { events: [...piece.events], step: { ...piece.step } };
  }
  if (pending) {
    const text = noteText(pending, secrets);
    if (text) pending.step.intent = text;
    out.push(pending);
  }
  return out;
}

function isIntentNote(piece: InterpretPiece): boolean {
  if (piece.step.action !== "note") return false;
  const text = piece.events[0]?.afterText || piece.step.label || "";
  return !/^Handoff (started|ended)\b/.test(text);
}

function noteText(piece: InterpretPiece, secrets: string[]): string {
  const raw = piece.events.map((event) => event.afterText || "").find(Boolean) || "";
  const cleaned = scrub(raw, secrets)?.replace(/\s+/g, " ").trim() || "";
  if (cleaned) return cleaned;
  return piece.step.label.replace(/^Note:\s*/, "").trim();
}

function applyNote(target: InterpretPiece, note: InterpretPiece, secrets: string[]): void {
  const text = noteText(note, secrets);
  if (text) target.step.intent = text;
  target.events.push(...note.events);
}

function mergeTyping(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event) && !event.sensitive && !prev.sensitive) {
      prev.value = (prev.value || "") + (event.value || "");
      prev.afterUrl = event.afterUrl || prev.afterUrl;
      prev.afterText = event.afterText || prev.afterText;
      prev.ts = event.ts;
      continue;
    }
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event)) {
      prev.value = event.sensitive ? undefined : event.value;
      prev.sensitive = prev.sensitive || event.sensitive;
      prev.afterUrl = event.afterUrl || prev.afterUrl;
      prev.ts = event.ts;
      continue;
    }
    out.push({ ...event });
  }
  return out;
}

function isType(event: TrailEvent): boolean {
  return event.op === "type" || event.op === "input" || event.op === "osType" || event.op === "osSetValue";
}

/** A currency or unit choice stays a literal. The other typed values become inputs. */
export function isConstantType(event: TrailEvent): boolean {
  if (!isType(event) || event.sensitive || event.gate) return false;
  const id = [event.identity?.id, event.identity?.nameAttr].filter(Boolean).join(" ");
  return /\b(currency|unit)\b/i.test(id);
}

function sameTarget(a: TrailEvent, b: TrailEvent): boolean {
  const left = a.identity;
  const right = b.identity;
  if (!left || !right) return false;
  return (left.id != null && left.id === right.id)
    || (left.testId != null && left.testId === right.testId)
    || (left.nameAttr != null && left.nameAttr === right.nameAttr)
    || (left.identifier != null && left.identifier === right.identifier)
    || (left.name != null && left.name === right.name && left.role === right.role && left.app === right.app);
}

function toStep(event: TrailEvent, index: number, meta: InterpretMeta, inputs: WorkflowInput[], known: readonly KnownTyped[]): WorkflowStep {
  event = normalizeFile(event);
  const surface = event.identity?.surface === "dom" || !event.identity ? "dom" : "os";
  const identity = stripSecretValue(event.identity, meta.secrets ?? []);
  const step: WorkflowStep = {
    id: `${meta.id}-${index}`,
    index,
    action: "click",
    label: event.op,
    surface,
    identity,
    locators: scrubLocators(event.locators?.length ? event.locators : locatorsFromIdentity(identity), meta.secrets ?? []),
    timeoutMs: 8000,
    provenance: event.provenance,
  };
  if (event.op === "login" || event.op === "confirm") {
    return {
      id: `${meta.id}-${index}`,
      index,
      action: event.op,
      label: event.op === "login"
        ? "ensure logged in (import from chrome, else wait for user)"
        : "confirm before applying",
      surface: "dom",
      human: true,
      timeoutMs: 8000,
      ...observed(event, undefined, false, known, meta.secrets ?? []),
    };
  }
  if (event.op === "note") {
    const text = scrub(event.afterText, meta.secrets ?? []);
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "note",
      label: text ? `Note: ${text}` : "Note",
      surface: "dom",
      timeoutMs: 8000,
    };
  }
  if (event.op === "expect") {
    const match = scrub(event.afterText, meta.secrets ?? []);
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "verify",
      label: match ? `Check: ${match}` : "Check",
      surface: "dom",
      timeoutMs: 8000,
      expect: { kind: "text", match: match || "", timeoutMs: 8000 },
    };
  }
  if (event.op === "verify") {
    const match = scrub(event.afterText, meta.secrets ?? []);
    const check = observed(event, undefined, false, known, meta.secrets ?? []);
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "verify",
      label: "re-read the status",
      surface: "dom",
      timeoutMs: 8000,
      expect: match ? { kind: "text", match, timeoutMs: 8000 } : check.expect,
      postcondition: check.postcondition,
    };
  }
  const gate = inferGate(event, meta.secrets ?? []);
  if (gate) step.gate = gate;
  if (event.op === "keypress" || event.op === "key") {
    return {
      ...step,
      action: "key",
      key: event.key || event.value,
      label: `Press ${event.key || event.value || "key"}`,
      ...observed(event, undefined, false, known, meta.secrets ?? []),
    };
  }
  if (event.op === "upload" || event.op === "drop") {
    const input = addInput(inputs, "file", "file");
    return {
      ...step,
      action: event.op === "drop" ? "drop" : "upload",
      input: input.name,
      value: `{{${input.name}}}`,
      label: event.op === "drop" ? "Drop file" : "Upload file",
      postcondition: {
        kind: "text",
        match: event.op === "drop" ? `Dropped file: {{${input.name}}}` : `{{${input.name}}}`,
        timeoutMs: 4000,
      },
    };
  }
  if (isType(event)) {
    const secret = isSecret(event, meta.secrets ?? []);
    if (!secret && isConstantType(event)) {
      return {
        ...step,
        action: "type",
        value: event.value,
        label: `Type ${event.value}`,
        ...observed(event, undefined, false, known, meta.secrets ?? []),
      };
    }
    const kind = secret ? "secret" : numberLike(event.value) && surface === "os" ? "number" : "text";
    const input = addInput(inputs, kind, nameHint(event, secret));
    if (!secret && event.value && !event.rawPath) input.default = event.value;
    return {
      ...step,
      action: "type",
      input: input.name,
      value: `{{${input.name}}}`,
      sensitive: secret || undefined,
      label: secret ? "Type secret" : `Type {{${input.name}}}`,
      ...observed(event, secret ? undefined : input.name, secret, known, meta.secrets ?? []),
    };
  }
  if (typeof event.checked === "boolean") {
    return {
      ...step,
      action: "check",
      checked: event.checked,
      label: event.checked ? "Check" : "Uncheck",
      ...observed(event, undefined, false, known, meta.secrets ?? []),
    };
  }
  if (event.gate === "login" && event.performed === false) {
    const named = inputs.find((item) => item.type === "text" && /user|email|login/i.test(item.name))
      || inputs.find((item) => item.type === "text");
    return {
      ...step,
      action: "click",
      gate: "login",
      label: "Sign in",
      postcondition: {
        kind: "text",
        match: named ? `Welcome {{${named.name}}}` : "Welcome",
        timeoutMs: 4000,
      },
    };
  }
  const name = event.identity?.name || event.identity?.text || event.identity?.label;
  return {
    ...step,
    action: "click",
    label: name ? `Click "${name}"` : "Click",
    ...observed(event, undefined, false, known, meta.secrets ?? []),
  };
}

function observed(
  event: TrailEvent,
  input: string | undefined,
  secret: boolean,
  known: readonly KnownTyped[],
  secrets: string[],
): Pick<WorkflowStep, "postcondition" | "expect" | "confidence"> {
  const identity = stripSecretValue(event.identity, secrets);
  const step = applyExpect(
    { id: "x", index: 0, action: "click", label: "x", surface: "dom", timeoutMs: 8000, identity },
    { ...event, identity },
    { input, secret, known, secrets },
  );
  return {
    ...(step.postcondition ? { postcondition: step.postcondition } : {}),
    ...(step.expect ? { expect: step.expect } : {}),
    ...(step.confidence ? { confidence: step.confidence } : {}),
  };
}

/** Upload, drop, and a typed path become a file slot. The path itself is not a step value. */
function normalizeFile(event: TrailEvent): TrailEvent {
  const act = fileAct({
    op: event.op,
    value: event.value,
    fileName: event.fileName,
    rawPath: event.rawPath,
    identity: event.identity,
  });
  if (!act.file) return { ...event, value: act.value, rawPath: undefined };
  return { ...event, op: act.op, value: undefined, rawPath: undefined, fileName: act.fileName };
}

function scrub(value: string | undefined, secrets: string[]): string | undefined {
  if (!value) return value;
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("");
  }
  return out.trim() ? out : undefined;
}

function inferGate(event: TrailEvent, secrets: string[]): "login" | "confirm" | undefined {
  if (event.gate === "login" || event.gate === "confirm") return event.gate;
  if (isSecret(event, secrets)) return "login";
  const name = [event.identity?.name, event.identity?.text, event.identity?.label, event.identity?.nameAttr]
    .filter(Boolean)
    .join(" ");
  if (/\bconfirm\b/i.test(name)) return "confirm";
  if (/\b(log in|sign in)\b/i.test(name)) return "login";
  return undefined;
}

function isSecret(event: TrailEvent, secrets: string[]): boolean {
  if (event.sensitive) return true;
  if (event.value && secrets.includes(event.value)) return true;
  if (event.value && isSensitiveValue(event.value)) return true;
  const id = event.identity;
  return isSensitiveField({
    type: id?.role === "password" ? "password" : undefined,
    name: id?.nameAttr,
    id: id?.id,
    ariaLabel: id?.label || id?.name,
    value: event.value,
  });
}

function numberLike(value: string | undefined): boolean {
  return !!value && /^-?\d+(\.\d+)?$/.test(value);
}

function nameHint(event: TrailEvent, secret: boolean): string {
  const hay = [event.identity?.nameAttr, event.identity?.id, event.identity?.label, event.identity?.name]
    .filter(Boolean)
    .join(" ");
  if (secret || /pass/i.test(hay)) return "password";
  if (/user|email|login/i.test(hay)) return "username";
  if (event.identity?.nameAttr && /^[A-Za-z][A-Za-z0-9_]*$/.test(event.identity.nameAttr)) return event.identity.nameAttr;
  if (event.identity?.id && /^[A-Za-z][A-Za-z0-9_]*$/.test(event.identity.id)) return event.identity.id;
  return secret ? "secret" : "text";
}

function addInput(inputs: WorkflowInput[], type: WorkflowInput["type"], hint: string): WorkflowInput {
  let name = hint || "text";
  let n = 2;
  while (inputs.some((item) => item.name === name)) name = `${hint}${n++}`;
  const input: WorkflowInput = { name, type, required: true, label: name };
  inputs.push(input);
  return input;
}

function scrubLocators(list: StepLocator[] | undefined, secrets: string[]): StepLocator[] | undefined {
  if (!list || list.length === 0) return undefined;
  const out = list.flatMap((locator) => {
    const blob = `${locator.name || ""} ${locator.value || ""}`;
    if (secrets.some((secret) => secret && blob.includes(secret))) return [];
    return [locator];
  });
  return out.length ? out : undefined;
}

function stripSecretValue(identity: Identity | undefined, secrets: string[]): Identity | undefined {
  if (!identity) return undefined;
  const copy = { ...identity, path: identity.path.map((seg) => ({ ...seg })) };
  for (const key of ["value", "text", "name", "label", "title"] as const) {
    const current = copy[key];
    if (typeof current !== "string") continue;
    if (secrets.some((secret) => secret && current.includes(secret)) || (key === "value" && isSensitiveValue(current))) {
      delete copy[key];
    }
  }
  return copy;
}

/** 7, 7, +, 5, =  becomes digits {{a}}, click +, digits {{b}}, click = with a numeric postcondition. */
function collapseDigits(
  pieces: { events: TrailEvent[]; step: WorkflowStep }[],
  inputs: WorkflowInput[],
): { events: TrailEvent[]; step: WorkflowStep }[] {
  const out: { events: TrailEvent[]; step: WorkflowStep }[] = [];
  const steps = pieces.map((piece) => piece.step);
  let i = 0;
  while (i < pieces.length) {
    const run = digitRun(steps, i);
    if (run.length === 0) {
      out.push(pieces[i]!);
      i += 1;
      continue;
    }
    const sample = pieces[i]!.step;
    const input = addInput(inputs, "number", inputs.some((item) => item.name === "a") ? "b" : "a");
    input.default = run.map((step) => step.identity?.name).join("");
    input.label = input.name;
    out.push({
      events: pieces.slice(i, i + run.length).flatMap((piece) => piece.events),
      step: {
        ...sample,
        action: "digits",
        input: input.name,
        value: `{{${input.name}}}`,
        label: `Enter {{${input.name}}}`,
        identity: sample.identity ? { ...sample.identity, name: undefined, text: undefined, title: undefined } : undefined,
        locators: undefined,
        postcondition: { kind: "element", timeoutMs: 4000 },
      },
    });
    i += run.length;
  }
  return out;
}

function digitRun(steps: WorkflowStep[], start: number): WorkflowStep[] {
  const run: WorkflowStep[] = [];
  for (let i = start; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.action !== "click" || step.surface !== "os") break;
    if (!step.identity?.name || !DIGIT.test(step.identity.name)) break;
    run.push(step);
  }
  return run;
}

function attachExpr(steps: WorkflowStep[]): WorkflowStep[] {
  const nums = steps.filter((step) => step.action === "digits");
  if (nums.length < 2) return steps;
  const left = nums[0]!;
  const right = nums[1]!;
  const leftAt = steps.indexOf(left);
  const rightAt = steps.indexOf(right);
  const op = steps.slice(leftAt + 1, rightAt).find((step) => step.action === "click" && OP.has(step.identity?.name || ""));
  const equals = steps.slice(rightAt + 1).find((step) => step.identity?.name === "=");
  if (!op || !equals || !left.input || !right.input) return steps;
  const symbol = op.identity?.name === "×" ? "*" : op.identity?.name === "÷" ? "/" : op.identity?.name;
  equals.postcondition = { kind: "value", match: `{{${left.input}}}${symbol}{{${right.input}}}`, timeoutMs: 4000 };
  return steps;
}

function assertClean(doc: WorkflowV2, secrets: string[]): void {
  const blob = JSON.stringify(doc);
  for (const secret of secrets) {
    if (secret && blob.includes(secret)) {
      throw new Error("interpret kept a secret");
    }
  }
  for (const step of doc.steps) {
    if (step.value && step.value.startsWith("/") && !step.value.includes("{{")) {
      throw new Error("interpret kept a file path");
    }
  }
}
