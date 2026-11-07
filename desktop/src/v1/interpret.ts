// Deterministic interpret. Same trail, same workflow bytes.
// Secrets become inputs. File paths are dropped. No model is required.

import { applyCapturedData, type ExtractSpec, type ListCapture } from "./data-steps";
import { applyExpect, type KnownTyped } from "./expect";
import { fileAct } from "./file-chooser";
import { locatorsFromIdentity } from "./locators";
import type { Identity, StepLocator, WorkflowInput, WorkflowStep, WorkflowV2 } from "./schema";
import { shapeFilesDates } from "./files-dates";
import { WORKFLOW_SCHEMA_ID } from "./schema";
import { fixedSavedChoice, hasStrippedSecret, NEEDS_SECRET_VALUE, scrubSaved, secretSavedField, STRIPPED_SECRET } from "../../../shared/saved-secrets";

export interface TrailEvent {
  id: string;
  toolCallId?: string;
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
  /** Second date of a picker range, ISO or the field's recorded text. */
  endValue?: string;
  /** The field is a date. Interpret lifts a date input. */
  dateField?: boolean;
  /** A click inside a date picker. Folded into one datePicker step. */
  picker?: boolean;
  /** input type, so a native date field stays a type step. */
  inputType?: string;
  /** Recorded display format for a date, when capture already knows it. */
  format?: string;
  /** Suggested filename from Browser.downloadWillBegin. Basename only. */
  suggestedFilename?: string;
  /** Bind an upload to a previous download output. */
  fileFrom?: string;
  /** Set when capture refused the action and a person has to do it. */
  gate?: "login" | "confirm";
  /** False when the tool recorded the act and did not change the page. */
  performed?: boolean;
  optional?: "dismiss";
  /** Message from Page.javascriptDialogOpening. The opening itself is an effect. */
  dialog?: string;
  /** alert, confirm, or prompt. */
  dialogType?: "alert" | "confirm" | "prompt";
  /** Which button closed the dialog. An alert records accept. */
  dialogDecision?: "accept" | "dismiss";
  /** Text the prompt returned. Replay types it again. */
  dialogValue?: string;
  /**
   * Name this click from an input. The recorded text is the sample default.
   * On a typed value, the input's name.
   */
  parameter?: string;
  /** Typed text that replay types as recorded. It does not become an input, and the step's label names the field, not the text. */
  literal?: boolean;
  /** The recorder read the whole field, rather than a typed chunk. */
  valueMode?: "full";
  /** Text or a control name this step leaves on the page. Replay skips the step when the page already shows it. */
  skipWhen?: string;
  /** A number in skipWhen matches any number, so "1 in cart" also matches "3 in cart". */
  skipAnyCount?: boolean;
  /** Rows the person selected or copied. */
  list?: ListCapture;
  /** A picked element or list, already named. */
  extract?: ExtractSpec;
}

export interface InterpretMeta {
  id: string;
  name?: string;
  startUrl: string;
  /** Extra exact strings that must not survive into the workflow. */
  secrets?: string[];
  /** Zone used to turn a picked date into +Nd. Absent is UTC so the same trail stays the same bytes. */
  zone?: string;
  /** Keep the raw action order for later workflow review. */
  preserveActions?: boolean;
}

const NOISE = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup", "dom", "ax", "mark",
]);

const DIGIT = /^[0-9]$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
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
  const kept = seen.preserveActions ? events.filter(keep) : mergeTyping(withoutChooserClicks(events.filter(keep)));
  const inputs: WorkflowInput[] = [];
  const known: KnownTyped[] = [];
  const mapped = kept.map((event) => {
    const step = toStep(event, 0, seen, inputs, known);
    if ([event.value, event.key].some(hasStrippedSecret)) step.unresolved = { reason: NEEDS_SECRET_VALUE };
    const skip = step.sensitive ? undefined : event.skipWhen?.trim();
    if (skip) step.when = { absent: skip, ...(event.skipAnyCount ? { anyCount: true } : {}) };
    if (step.action === "type" && (step.input || event.literal) && event.value && !step.sensitive && !secrets.includes(event.value)) {
      known.push({ name: step.input, value: event.value });
    }
    return { events: [event], step };
  });
  if (!seen.preserveActions) bindTypedOptions(mapped);
  const pieces = seen.preserveActions ? mapped : foldNotes(collapseDigits(mapped, inputs));
  if (!seen.preserveActions) attachExpr(pieces.map((piece) => piece.step));
  const captured = applyCapturedData(pieces, inputs);
  const drafted: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: captured.version,
    id: meta.id,
    name: meta.name || "Untitled workflow",
    startUrl: meta.startUrl,
    inputs,
    steps: captured.pieces.map((piece, index) => ({ ...piece.step, index, id: `${meta.id}-${index}` })),
    createdAt: events[0]?.ts ?? 0,
    ...(captured.outputs ? { outputs: captured.outputs } : {}),
  };
  const shaped = shapeFilesDates(drafted, captured.pieces.map((piece) => piece.events), meta.zone || "UTC");
  const saved = scrubSaved(shaped.doc, { secrets });
  assertFileSlots(saved);
  return { doc: saved, groups: shaped.groups as TrailEvent[][] };
}

/** A password field's typed text is a secret even when the caller did not list it. */
function secretStrings(events: readonly TrailEvent[], listed: string[]): string[] {
  const out = [...listed];
  for (const event of events) {
    const password = event.sensitive || secretSavedField(event.identity);
    const value = event.value;
    if (!password || !value || hasStrippedSecret(value) || out.includes(value)) continue;
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
      prev.value = event.sensitive ? undefined : event.valueMode === "full" ? event.value : mergeTypedValue(prev.value || "", event.value || "");
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
function foldNotes(pieces: InterpretPiece[]): InterpretPiece[] {
  const out: InterpretPiece[] = [];
  let pending: InterpretPiece | undefined;
  for (const piece of pieces) {
    if (!isIntentNote(piece)) {
      if (pending && piece.step.action !== "note") {
        applyNote(piece, pending);
        pending = undefined;
      }
      out.push(piece);
      continue;
    }
    const current = out[out.length - 1];
    if (current && current.step.action !== "note") {
      applyNote(current, piece);
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
    const text = noteText(pending);
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

function noteText(piece: InterpretPiece): string {
  const raw = piece.events.map((event) => event.afterText || "").find(Boolean) || "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned) return cleaned;
  return piece.step.label.replace(/^Note:\s*/, "").trim();
}

function applyNote(target: InterpretPiece, note: InterpretPiece): void {
  const text = noteText(note);
  if (text) target.step.intent = text;
  target.events.push(...note.events);
}

function mergeTyping(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event) && !event.sensitive && !prev.sensitive) {
      prev.value = event.valueMode === "full" ? event.value : mergeTypedValue(prev.value || "", event.value || "");
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

/**
 * input and change both report the whole field, so "N" then "NC" then "NCR"
 * is one value. A repeated letter is still two keystrokes: "o" then "o" is "oo".
 * Chunks that do not extend the previous text stay concatenated ("t" + "omsmith").
 */
function mergeTypedValue(before: string, added: string): string {
  if (!added) return before;
  if (!before) return added;
  if (added === before && added.length > 1) return added;
  if (added.startsWith(before) && added.length > before.length) return added;
  return before + added;
}

/** A suggestion click chooses the text just typed. Replay substitutes that input. */
function bindTypedOptions(pieces: InterpretPiece[]): void {
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const prev = pieces[i - 1]!;
    if (piece.step.action !== "click" || prev.step.action !== "type" || !prev.step.input) continue;
    const identity = piece.events[0]?.identity;
    if (identity?.role !== "option") continue;
    const sample = (identity.text || identity.name || "").replace(/\s+/g, " ").trim();
    const typed = (prev.events[0]?.value || "").replace(/\s+/g, " ").trim();
    if (!sample || sample !== typed) continue;
    piece.step.selection = { by: "text", input: prev.step.input };
    piece.step.label = `Click {{${prev.step.input}}}`;
  }
}

/** A currency or unit choice stays a literal, and so does text the trail marked literal. The other typed values become inputs. */
export function isConstantType(event: TrailEvent): boolean {
  if (!isType(event) || event.sensitive || event.gate) return false;
  if (event.literal) return true;
  const id = [event.identity?.id, event.identity?.nameAttr].filter(Boolean).join(" ");
  return /\b(currency|unit)\b/i.test(id);
}

export function sameTrailPage(a: Pick<TrailEvent, "beforeUrl">, b: Pick<TrailEvent, "beforeUrl">): boolean {
  return a.beforeUrl === b.beforeUrl;
}

function sameTarget(a: TrailEvent, b: TrailEvent): boolean {
  if (!sameTrailPage(a, b)) return false;
  const left = a.identity;
  const right = b.identity;
  if (!left || !right) return false;
  // Two date fields can share the accessible name "Date Picker". The path tells them apart.
  if (left.cssPath && right.cssPath && left.cssPath !== right.cssPath) return false;
  return (left.id != null && left.id === right.id)
    || (left.testId != null && left.testId === right.testId)
    || (left.nameAttr != null && left.nameAttr === right.nameAttr)
    || (left.identifier != null && left.identifier === right.identifier)
    || (left.name != null && left.name === right.name && left.role === right.role && left.app === right.app)
    || (left.cssPath != null && left.cssPath === right.cssPath);
}

function toStep(event: TrailEvent, index: number, meta: InterpretMeta, inputs: WorkflowInput[], known: KnownTyped[]): WorkflowStep {
  event = normalizeFile(event);
  const surface = event.identity?.surface === "dom" || !event.identity ? "dom" : "os";
  const secretEntry = isType(event) && isSecret(event, meta.secrets ?? []);
  const identity = secretEntry ? secretEntryIdentity(event.identity) : stripSecretValue(event.identity, meta.secrets ?? []);
  const captured = (value: string | undefined) => value !== undefined && [event.value, event.identity?.text, event.identity?.value].includes(value);
  const locators = secretEntry ? event.locators?.filter((locator) =>
    !(locator.kind === "text" && captured(locator.value) || locator.kind === "role" && captured(locator.name)),
  ) : event.locators;
  const step: WorkflowStep = {
    id: `${meta.id}-${index}`,
    index,
    action: "click",
    ...(event.optional ? { optional: event.optional } : {}),
    label: event.op,
    surface,
    identity,
    locators: locators?.length ? locators : locatorsFromIdentity(identity),
    timeoutMs: 8000,
    provenance: event.provenance,
  };
  if (event.op === "navigate") {
    const url = event.value || event.afterUrl || event.beforeUrl || meta.startUrl;
    const match = openMatch(event.afterUrl || url);
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "navigate",
      label: url ? `Open ${url}` : "Open",
      surface: "dom",
      value: url || undefined,
      timeoutMs: 8000,
      ...(match ? { expect: { kind: "url" as const, match, timeoutMs: 8000 } } : {}),
    };
  }
  if (event.op === "select") {
    const input = addInput(inputs, "text", nameHint(event, false));
    if (event.value) input.default = event.value;
    return {
      ...step,
      action: "select",
      input: input.name,
      value: `{{${input.name}}}`,
      label: `Select {{${input.name}}}`,
      ...observed(event, input.name, false, known, meta.secrets ?? []),
    };
  }
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
  if (event.op === "extract" && event.extract) {
    const spec = event.extract;
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "extract",
      label: `Extract ${spec.as}`,
      surface: "dom",
      timeoutMs: 8000,
      heal: "never",
      locators: spec.locators,
      extract: spec,
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
  if ((event.op === "keypress" || event.op === "key") && event.sensitive) return { ...step, action: "key", label: "Press [redacted]", sensitive: true, unresolved: { reason: "redacted key" } };
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
    const secret = secretEntry;
    if (!secret && isConstantType(event)) {
      const field = event.identity?.name || event.identity?.label;
      return {
        ...step,
        action: "type",
        value: event.value,
        label: event.literal ? (field ? `Type into "${field}"` : "Type") : `Type ${event.value}`,
        ...observed(event, undefined, false, known, meta.secrets ?? []),
      };
    }
    const kind = secret ? "secret" : numberLike(event.value) && surface === "os" ? "number" : "text";
    const named = !secret && event.parameter && NAME_RE.test(event.parameter) ? event.parameter : nameHint(secret ? { ...event, identity } : event, secret);
    const input = addInput(inputs, kind, named);
    if (!secret && event.value !== undefined && !event.rawPath) input.default = event.value;
    return {
      ...step,
      action: "type",
      input: input.name,
      value: `{{${input.name}}}`,
      sensitive: secret || undefined,
      label: secret ? "Type secret" : `Type {{${input.name}}}`,
      ...(secret ? {} : observed(event, input.name, false, known, meta.secrets ?? [])),
    };
  }
  if (typeof event.checked === "boolean" || event.op === "check") {
    const checked = event.checked !== false;
    const name = event.identity?.name || event.identity?.label || event.identity?.text;
    return {
      ...step,
      action: "check",
      checked,
      label: `${checked ? "Check" : "Uncheck"}${name ? ` "${name}"` : ""}`,
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
  let promptInput: string | undefined;
  if (event.dialogType === "prompt" && event.dialogValue) {
    const input = addInput(inputs, "text", "prompt");
    const typed = scrub(event.dialogValue, meta.secrets ?? []) || event.dialogValue;
    input.default = typed;
    promptInput = input.name;
    if (typed && !meta.secrets?.includes(typed)) known.push({ name: input.name, value: typed });
  }
  return {
    ...step,
    action: "click",
    label: name ? `Click "${name}"` : "Click",
    ...(promptInput ? { input: promptInput, value: `{{${promptInput}}}` } : {}),
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
  const saved = scrubSaved({ op: "type", value }, { secrets }).value;
  return saved === STRIPPED_SECRET && value !== STRIPPED_SECRET ? undefined : saved;
}

function inferGate(event: TrailEvent, secrets: string[]): "login" | "confirm" | undefined {
  if (event.gate === "login" || event.gate === "confirm") return event.gate;
  if (isSecret(event, secrets)) return "login";
  const name = [event.identity?.name, event.identity?.text, event.identity?.label, event.identity?.nameAttr]
    .filter(Boolean)
    .join(" ");
  if (/\b(log in|sign in)\b/i.test(name)) return "login";
  return undefined;
}

function isSecret(event: TrailEvent, secrets: string[]): boolean {
  if (event.sensitive || secretSavedField(event.identity)) return true;
  if (fixedSavedChoice(event)) return false;
  return !!event.value && (secrets.includes(event.value) || scrubSaved({ op: "type", value: event.value }).value === STRIPPED_SECRET);
}

function openMatch(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.host : "";
  } catch {
    return "";
  }
}

function numberLike(value: string | undefined): boolean {
  return !!value && /^-?\d+(\.\d+)?$/.test(value);
}

function nameHint(event: TrailEvent, secret: boolean): string {
  if (event.source?.adapter === "cdp-live") {
    for (const field of [event.identity?.label, event.identity?.name, event.identity?.placeholder, event.identity?.nameAttr]) {
      const name = (field || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (name) return /^\d/.test(name) ? `field_${name}` : name;
    }
  }
  const hay = [event.identity?.nameAttr, event.identity?.id, event.identity?.label, event.identity?.name]
    .filter(Boolean)
    .join(" ");
  if (secret || /pass/i.test(hay)) return "password";
  if (/user|email|login/i.test(hay)) return "username";
  if (event.identity?.nameAttr && NAME_RE.test(event.identity.nameAttr)) return event.identity.nameAttr;
  if (event.identity?.id && NAME_RE.test(event.identity.id)) return event.identity.id;
  return secret ? "secret" : "text";
}

function addInput(inputs: WorkflowInput[], type: WorkflowInput["type"], hint: string): WorkflowInput {
  const base = hint || "text";
  const suffix = /\d$/.test(base) ? `${base}_` : base;
  let name = base;
  let n = 2;
  while (inputs.some((item) => item.name === name)) name = `${suffix}${n++}`;
  const input: WorkflowInput = { name, type, required: true, label: name };
  inputs.push(input);
  return input;
}

/** Secret entries use field structure, not captured text or effects, to build a new step. */
function secretEntryIdentity(identity: Identity | undefined): Identity | undefined {
  if (!identity) return undefined;
  const { text, value, ...structure } = identity;
  return structure;
}

function stripSecretValue(identity: Identity | undefined, secrets: string[]): Identity | undefined {
  if (!identity) return undefined;
  return scrubSaved({ identity }, { secrets }).identity;
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

function assertFileSlots(doc: WorkflowV2): void {
  const walk = (step: WorkflowStep): void => {
    if (step.value && step.value.startsWith("/") && !step.value.includes("{{")) {
      throw new Error("interpret kept a file path");
    }
    for (const nested of step.forEach?.steps ?? []) walk(nested);
  };
  for (const step of doc.steps) walk(step);
}
