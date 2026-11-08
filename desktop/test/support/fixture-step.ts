// Builds a v4 step for tests. Not a reader of old workflow files.

import { redactSavedValue } from "../../../shared/outbound-secrets";
import { citeIdentity, caption, clickSentence, openSentence, typeSentence } from "../../src/v1/caption";
import { locatorsFromIdentity } from "../../src/v1/locators";
import {
  anchorRef,
  hintFromIdentity,
  stepCheck,
  stepInputName,
  stepKey,
  stepLocators,
  stepQuery,
  stepTarget,
  stepValueTemplate,
  WORKFLOW_SCHEMA_ID,
  type Check,
  type HealChange,
  type Identity,
  type InputType,
  type ReadBack,
  type StepCaption,
  type StepLocator,
  type StepWhen,
  type Target,
  type TargetBox,
  type TextOf,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowV2,
} from "../../src/v1/schema";

export interface LooseCheck {
  kind?: string;
  match?: string;
  state?: string;
  timeoutMs?: number;
  identity?: Partial<Identity>;
  locators?: StepLocator[];
}

export interface LooseStep {
  id?: string;
  action?: string;
  index?: number;
  timeoutMs?: number;
  label?: string;
  caption?: StepCaption;
  identity?: Partial<Identity>;
  locators?: StepLocator[];
  target?: Target;
  value?: string;
  input?: string;
  key?: string;
  checked?: boolean;
  sensitive?: boolean;
  expect?: LooseCheck;
  postcondition?: LooseCheck;
  check?: Check;
  targetBox?: TargetBox;
  url?: string;
  optional?: string;
  heal?: string;
  when?: StepWhen;
  text?: unknown;
  reason?: string;
  ms?: number;
  literal?: boolean;
  surface?: string;
  download?: { output: string; name: string; url?: string };
  open?: { target: "url"; url: string } | { target: "file"; file: string; app?: string };
  extract?: Extract<WorkflowStep, { action: "extract" }>["extract"];
  forEach?: Extract<WorkflowStep, { action: "for_each" }>["forEach"];
  date?: { input: string; endInput?: string };
  datePicker?: { input: string; endInput?: string };
  file?: { input: string } | { fromOutput: string };
  fileFrom?: string;
  selection?: Extract<WorkflowStep, { action: "click" }>["selection"];
  reveal?: StepLocator;
  dialog?: { input: string };
  readBack?: ReadBack;
  history?: HealChange[];
  waitFor?: LooseCheck;
  gone?: LooseCheck;
  [key: string]: unknown;
}

export interface LooseInput {
  name: string;
  type?: InputType;
  label?: string;
  supply?: "saved" | "must";
  default?: string;
  required?: boolean;
  askOnImport?: boolean;
  example?: string;
  choices?: string[];
  multiple?: boolean;
  accept?: string;
  format?: string;
  relative?: string;
  zone?: string;
  fromOutput?: string;
  [key: string]: unknown;
}

export interface LooseDoc {
  id?: string;
  name?: string;
  schema?: string;
  version?: number;
  startUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  inputs?: LooseInput[];
  steps?: LooseStep[];
  driver?: string;
  provenance?: string;
  readBack?: WorkflowV2["readBack"];
  precondition?: WorkflowV2["precondition"];
  summary?: string;
  intent?: string;
  inference?: WorkflowV2["inference"];
  heal?: WorkflowV2["heal"];
  replayed?: boolean;
  outputs?: WorkflowV2["outputs"];
  filesDates?: unknown;
  [key: string]: unknown;
}

export type FixtureDraft = LooseStep;

export function fixtureStep(draft: object, index = (draft as LooseStep).index ?? 0): WorkflowStep {
  const step = builtFixtureStep(draft, index);
  const raw = draft as LooseStep;
  const extra = step as WorkflowStep & { waitFor?: LooseCheck; gone?: LooseCheck };
  if (raw.waitFor) extra.waitFor = raw.waitFor;
  if (raw.gone) extra.gone = raw.gone;
  return extra;
}

function builtFixtureStep(draft: object, index = (draft as LooseStep).index ?? 0): WorkflowStep {
  const raw = draft as LooseStep;
  const action = raw.date || raw.datePicker ? "pickDate" : mapAction(raw.action);
  const timeoutMs = typeof raw.timeoutMs === "number" ? raw.timeoutMs : 8000;
  const target = targetOf(raw);
  const check = checkOf(raw);
  const sentence = sentenceOf(raw, action);
  const noBox = action === "navigate" || action === "wait" || action === "finish" || action === "note" || action === "verify" || action === "extract" || action === "for_each" || (action === "handoff" && raw.action !== "confirm" && raw.reason !== "owner-press");
  const cap = raw.caption?.text
    ? (noBox ? caption(raw.caption.text) : raw.caption)
    : caption(sentence, noBox ? undefined : citeIdentity(asIdentity(raw.identity)), noBox ? undefined : raw.targetBox);
  const heal = healOf(raw.heal) ?? (raw.unresolved ? "never" : undefined);
  const base = {
    id: raw.id || `step-${index}`,
    index,
    timeoutMs,
    caption: cap,
    ...(raw.when ? { when: raw.when } : {}),
    ...(heal ? { heal } : {}),
    ...(raw.readBack ? { readBack: raw.readBack } : {}),
    ...(typeof raw.input === "string" ? { input: raw.input } : {}),
  };
  const withCheck = check ? { check } : {};
  switch (action) {
    case "click":
      return {
        ...base,
        action: "click",
        target: {
          ...(target ?? { locators: [{ kind: "role" as const, role: "button", name: raw.label || "Click" }] }),
          ...(raw.reveal ? { reveal: raw.reveal } : {}),
        },
        ...withCheck,
        ...(raw.optional === "dismiss" ? { optional: "dismiss" as const } : {}),
        ...(raw.selection ? { selection: raw.selection } : {}),
        ...(raw.dialog?.input ? { dialog: raw.dialog } : {}),
      };
    case "type":
    case "select":
      return {
        ...base,
        action,
        target: target ?? { locators: [{ kind: "role", role: "textbox", name: raw.label || "Field" }] },
        text: textOf(raw),
        ...(raw.sensitive ? { sensitive: true } : {}),
        ...withCheck,
      };
    case "key":
      return { ...base, action: "key", key: raw.key || "Enter", ...(target ? { target } : {}), ...withCheck };
    case "check":
      return {
        ...base,
        action: "check",
        target: target ?? { locators: [{ kind: "role", role: "checkbox", name: raw.label || "Check" }] },
        checked: raw.checked !== false,
        ...withCheck,
      };
    case "navigate":
      return { ...base, action: "navigate", url: raw.url || raw.value || "https://example.test/", caption: caption(sentence), ...withCheck };
    case "verify":
      return { ...base, action: "verify", check: check ?? { kind: "settled", timeoutMs: 4000 }, caption: caption(sentence) };
    case "handoff": {
      const reason = raw.action === "login" || raw.reason === "sign-in"
        ? "sign-in"
        : raw.reason === "code" ? "code" : "owner-press";
      return {
        ...base,
        action: "handoff",
        reason,
        ...(typeof raw.input === "string" ? { input: raw.input } : {}),
        ...(reason === "owner-press" && target ? { target } : {}),
        caption: caption(raw.label || raw.caption?.text || (reason === "sign-in" ? "Sign in" : reason === "code" ? "Enter the code" : "You press the button")),
        ...withCheck,
      } as WorkflowStep;
    }
    case "upload":
    case "drop":
      return {
        ...base,
        action,
        target: target ?? { locators: [{ kind: "css", value: "input[type=file]" }] },
        file: fileOf(raw),
        ...withCheck,
      };
    case "extract":
      return {
        ...base,
        action: "extract",
        caption: caption(sentence),
        heal: "never",
        extract: raw.extract ?? { mode: "element", as: "item", locators: [{ kind: "css", value: "body" }], columns: [{ name: "text", type: "text", read: "text", locators: [{ kind: "css", value: "body" }] }] },
      };
    case "for_each":
      return { ...base, action: "for_each", caption: caption(sentence), forEach: raw.forEach ?? { over: { kind: "extract", name: "item" }, steps: [] } };
    case "note":
      return { ...base, action: "note", text: typeof raw.text === "string" ? raw.text : (raw.label || "Note"), caption: caption(sentence) };
    case "download":
      return { ...base, action: "download", caption: caption(sentence), download: raw.download ?? { output: "file", name: "file.txt" }, ...withCheck };
    case "open":
      return { ...base, action: "open", caption: caption(sentence), open: raw.open ?? { target: "url", url: raw.url || "https://example.test/" }, ...withCheck };
    case "digits":
      return { ...base, action: "digits", text: textOf(raw), ...(target ? { target } : {}), ...withCheck };
    case "pickDate":
      return { ...base, action: "pickDate", date: raw.date ?? raw.datePicker ?? { input: raw.input || "date" }, ...(target ? { target } : {}), ...withCheck };
    case "wait":
      return { ...base, action: "wait", reason: raw.reason || raw.label || "the page", caption: caption(sentence), ...(raw.ms ? { ms: raw.ms } : {}) };
    case "finish":
      return { ...base, action: "finish", caption: caption(sentence), ...(raw.reason ? { reason: raw.reason } : {}) };
    default:
      return { ...base, action: "note", text: raw.label || action, caption: caption(sentence) };
  }
}

export function fixtureInput(partial: LooseInput): WorkflowInput {
  const type = partial.type ?? "text";
  const file = type === "file";
  const hasDefault = typeof partial.default === "string" && partial.default.length > 0 && partial.default !== "[secret stripped]";
  let supply = partial.supply;
  if (supply !== "saved" && supply !== "must") {
    supply = file || !hasDefault ? "must" : "saved";
  }
  if (file || !hasDefault) supply = "must";
  if (supply === "saved" && !hasDefault) supply = "must";
  return {
    name: partial.name,
    type,
    label: partial.label || partial.name,
    supply,
    ...(supply === "saved" && hasDefault ? { default: partial.default } : {}),
    ...(supply === "must" && (partial.default === "[secret stripped]" || (file && typeof partial.default === "string" && redactSavedValue(partial.default) === "[secret stripped]")) ? { default: "[secret stripped]" } : {}),
    ...(partial.askOnImport ? { askOnImport: true } : {}),
    ...(partial.example ? { example: partial.example } : {}),
    ...(partial.choices ? { choices: partial.choices } : {}),
    ...(partial.multiple ? { multiple: true } : {}),
    ...(partial.accept ? { accept: partial.accept } : {}),
    ...(partial.format ? { format: partial.format } : {}),
    ...(partial.relative ? { relative: partial.relative } : {}),
    ...(partial.zone ? { zone: partial.zone } : {}),
    ...(partial.fromOutput ? { fromOutput: partial.fromOutput } : {}),
  };
}

export function fixtureDoc(raw: WorkflowV2): WorkflowV2;
export function fixtureDoc(raw: Record<string, unknown>): WorkflowV2;
export function fixtureDoc(raw: WorkflowV2 | Record<string, unknown>): WorkflowV2 {
  const doc = raw as LooseDoc;
  const steps = (doc.steps ?? []).map((step, index) => fixtureStep(step as LooseStep, index));
  const driver = doc.driver === "playwright" || doc.driver === "extension" || doc.driver === "cdp-live" ? doc.driver : undefined;
  return {
    schema: WORKFLOW_SCHEMA_ID,
    id: doc.id || "wf",
    name: doc.name || "Workflow",
    startUrl: doc.startUrl || "https://example.test/",
    createdAt: doc.createdAt ?? 1,
    inputs: (doc.inputs ?? []).map((input) => fixtureInput(input as LooseInput)),
    steps,
    ...(doc.updatedAt != null ? { updatedAt: doc.updatedAt } : {}),
    ...(doc.provenance === "fixture" ? { provenance: "fixture" as const } : {}),
    ...(doc.outputs ? { outputs: doc.outputs } : {}),
    ...(doc.heal ? { heal: doc.heal } : {}),
    ...(doc.replayed ? { replayed: true } : {}),
    ...(doc.readBack ? { readBack: doc.readBack } : {}),
    ...(doc.precondition ? { precondition: doc.precondition } : {}),
    ...(doc.summary ? { summary: doc.summary } : {}),
    ...(doc.intent ? { intent: doc.intent } : {}),
    ...(doc.inference ? { inference: doc.inference } : {}),
    ...(driver ? { driver } : {}),
  };
}

export function withStep(step: WorkflowStep, patch: object): WorkflowStep {
  const draft = draftFrom(step);
  const extra = patch as LooseStep;
  const merged: LooseStep = { ...draft, ...extra, id: extra.id || step.id, index: extra.index ?? step.index };
  if (extra.identity || extra.locators || extra.history) delete merged.target;
  if (extra.identity && !extra.locators) delete merged.locators;
  if ("postcondition" in extra || "expect" in extra) delete merged.check;
  if (extra.label || extra.caption) delete merged.caption;
  if ("value" in extra) delete merged.text;
  if ("input" in extra) delete merged.text;
  if ("value" in extra && !("input" in extra)) delete merged.input;
  if ("input" in extra && extra.input == null) delete merged.input;
  return fixtureStep(merged, merged.index ?? step.index);
}

export function writeStep(step: WorkflowStep, patch: object): WorkflowStep {
  const next = withStep(step, patch);
  for (const key of Object.keys(step)) delete (step as unknown as Record<string, unknown>)[key];
  return Object.assign(step, next);
}

function draftFrom(step: WorkflowStep): LooseStep {
  return {
    id: step.id,
    action: step.action,
    index: step.index,
    timeoutMs: step.timeoutMs,
    caption: step.caption,
    heal: step.heal,
    when: step.when,
    readBack: step.readBack,
    target: stepTarget(step),
    identity: stepQuery(step),
    locators: stepLocators(step),
    value: stepValueTemplate(step),
    input: stepInputName(step),
    key: stepKey(step),
    checked: step.action === "check" ? step.checked : undefined,
    sensitive: step.action === "type" ? step.sensitive : undefined,
    check: stepCheck(step),
    text: step.action === "type" || step.action === "select" || step.action === "digits" ? step.text : step.action === "note" ? step.text : undefined,
    url: step.action === "navigate" ? step.url : undefined,
    download: step.action === "download" ? step.download : undefined,
    open: step.action === "open" ? step.open : undefined,
    extract: step.action === "extract" ? step.extract : undefined,
    forEach: step.action === "for_each" ? step.forEach : undefined,
    date: step.action === "pickDate" ? step.date : undefined,
    file: step.action === "upload" || step.action === "drop" ? step.file : undefined,
    optional: step.action === "click" ? step.optional : undefined,
    selection: step.action === "click" ? step.selection : undefined,
    dialog: step.action === "click" ? step.dialog : undefined,
    reason: step.action === "wait" || step.action === "finish" || step.action === "handoff" ? step.reason : undefined,
    ms: step.action === "wait" ? step.ms : undefined,
  };
}

export function fixtureWorkflow(partial: Partial<WorkflowV2> & Pick<WorkflowV2, "id" | "name" | "steps">): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID,
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    ...partial,
    steps: partial.steps.map((step, index) => ({ ...step, index })),
  };
}

function healOf(value: unknown): "auto" | "ask" | "never" | undefined {
  return value === "auto" || value === "ask" || value === "never" ? value : undefined;
}

function mapAction(action: string | undefined): WorkflowStep["action"] {
  if (action === "confirm" || action === "login") return "handoff";
  if (action === "input") return "type";
  if (action === "press") return "key";
  if (action === "goto") return "navigate";
  const known: WorkflowStep["action"][] = ["click", "type", "key", "check", "select", "navigate", "verify", "handoff", "upload", "drop", "extract", "for_each", "note", "download", "open", "digits", "pickDate", "wait", "finish"];
  return known.includes(action as WorkflowStep["action"]) ? action as WorkflowStep["action"] : "note";
}

function asIdentity(node: Partial<Identity> | undefined): Identity | undefined {
  if (!node) return undefined;
  return { surface: node.surface ?? "dom", role: node.role ?? "unknown", path: node.path ?? [], ...node };
}

function withDraftAnchor(list: StepLocator[] | undefined, draft: LooseStep): StepLocator[] | undefined {
  const raw = draft.anchor as { relation?: string; identity?: Partial<Identity> } | undefined;
  const relation = raw?.relation;
  if (relation !== "below" && relation !== "above" && relation !== "right" && relation !== "left") return list;
  const node = asIdentity(raw?.identity);
  if (!node) return list;
  const anchor: StepLocator = { kind: "anchor", relation, anchor: anchorRef(node) };
  return [...(list ?? []), anchor];
}

function targetOf(draft: LooseStep): Target | undefined {
  if (draft.target?.locators?.length || draft.target?.hint) {
    return {
      ...draft.target,
      ...(draft.reveal ? { reveal: draft.reveal } : {}),
      ...(draft.history ? { history: draft.history } : {}),
    };
  }
  const identity = asIdentity(draft.identity);
  const locators = withDraftAnchor(draft.locators ?? locatorsFromIdentity(identity), draft);
  if (!locators?.length && !identity) return draft.history ? { locators: [{ kind: "role", role: "button", name: draft.label || "Click" }], history: draft.history } : undefined;
  const hint = hintFromIdentity(identity);
  return {
    locators: locators ?? [],
    ...(hint ? { hint } : {}),
    ...(draft.reveal ? { reveal: draft.reveal } : {}),
    ...(draft.history ? { history: draft.history } : {}),
  };
}

function textOf(draft: LooseStep): TextOf {
  if (draft.text && typeof draft.text === "object" && ("input" in draft.text || "literal" in draft.text)) return draft.text as TextOf;
  if (draft.input && !draft.literal) return { input: draft.input };
  return { literal: draft.value ?? (typeof draft.text === "string" ? draft.text : "") };
}

function fileOf(draft: LooseStep): { input: string } | { fromOutput: string } {
  if (draft.file && typeof draft.file === "object") return draft.file;
  if (draft.fileFrom) return { fromOutput: draft.fileFrom };
  return { input: draft.input || "file" };
}

function checkOf(draft: LooseStep): Check | undefined {
  if (draft.check) return draft.check;
  const raw = draft.expect ?? draft.postcondition;
  if (!raw?.kind) return undefined;
  const timeoutMs = raw.timeoutMs ?? 4000;
  if (raw.kind === "settled") return { kind: "settled", timeoutMs };
  if (raw.kind === "state" && raw.state) {
    const locators = raw.locators ?? locatorsFromIdentity(asIdentity(raw.identity)) ?? targetOf(draft)?.locators ?? [];
    return { kind: "state", state: raw.state as "checked", locators, timeoutMs };
  }
  if (raw.kind === "element" || raw.kind === "absent") {
    const locators = raw.locators ?? locatorsFromIdentity(asIdentity(raw.identity)) ?? targetOf(draft)?.locators ?? [{ kind: "text" as const, value: raw.match || "item" }];
    return { kind: raw.kind, locators, timeoutMs };
  }
  if (raw.kind === "text" || raw.kind === "url" || raw.kind === "value") return { kind: raw.kind, match: raw.match || "", timeoutMs };
  return undefined;
}

function sentenceOf(draft: LooseStep, action: WorkflowStep["action"]): string {
  if (draft.label) return draft.label;
  if (draft.caption?.text) return draft.caption.text;
  if (action === "navigate") return openSentence(draft.url || draft.value);
  if (action === "type" || action === "select") return typeSentence(draft.identity?.label || draft.identity?.name, draft.sensitive);
  if (action === "click") return clickSentence(draft.identity?.name || draft.identity?.text || draft.identity?.label);
  if (action === "key") return `Press ${draft.key || "Enter"}`;
  if (action === "handoff") return draft.action === "login" || draft.reason === "sign-in" ? "Sign in" : "You press the button";
  if (action === "wait") return `Wait ${draft.reason || "the page"}`;
  if (action === "extract") return `Read ${draft.extract?.as || "the page"}`;
  if (action === "finish") return draft.reason ? `Finish: ${draft.reason}` : "Finish";
  if (action === "verify") return draft.expect?.match || draft.postcondition?.match ? `Check ${draft.expect?.match || draft.postcondition?.match}` : "Check the page";
  return action;
}
